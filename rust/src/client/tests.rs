use super::*;
use laserstream_core_proto::tonic::Code;
use laserstream_core_proto::{
    geyser::*,
    tonic::{self, Response, Streaming},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

const SLOT_TOO_OLD_MESSAGE: &str = "Requested slot 95 is older than the oldest available slot 100. Please request a more recent slot.";

#[test]
fn update_parent_proto_is_available() {
    let filter = SubscribeRequestFilterEntry {
        include_update_parent: Some(true),
    };
    assert_eq!(filter.include_update_parent, Some(true));

    let parent_block_id = vec![0xab; 32];
    let update = SubscribeUpdate {
        update_oneof: Some(UpdateOneof::EntryUpdateParent(
            SubscribeUpdateEntryUpdateParent {
                slot: 42,
                cleared_bank_id: 7,
                parent_slot: 41,
                parent_block_id: parent_block_id.clone(),
            },
        )),
        ..Default::default()
    };
    let Some(UpdateOneof::EntryUpdateParent(parent)) = update.update_oneof else {
        panic!("expected entry update parent");
    };
    assert_eq!(
        (parent.slot, parent.cleared_bank_id, parent.parent_slot),
        (42, 7, 41)
    );
    assert_eq!(parent.parent_block_id, parent_block_id);
}

#[test]
fn only_opted_in_out_of_range_is_terminal() {
    for opted_in in [false, true] {
        let options = SubscribeOptions::default().with_intra_slot_updates(opted_in);
        for value in 1..=16 {
            let code = Code::from_i32(value);
            assert_eq!(
                is_terminal_error(&options, &Status::new(code, "test")),
                opted_in && code == Code::OutOfRange,
                "{code:?}"
            );
        }
    }
}

#[test]
fn intra_slot_updates_are_off_by_default() {
    let options = SubscribeOptions::default();
    assert!(!options.intra_slot_updates);
    let options = options.with_intra_slot_updates(true);
    assert!(options.intra_slot_updates);
    assert!(!options.with_intra_slot_updates(false).intra_slot_updates);
}

#[test]
fn config_literal_from_1_0_1_still_compiles() {
    let config = LaserstreamConfig {
        api_key: String::new(),
        endpoint: String::new(),
        max_reconnect_attempts: None,
        channel_options: crate::ChannelOptions::default(),
        replay: true,
    };
    assert!(config.replay);
}

#[tokio::test]
async fn stream_out_of_range_is_terminal() {
    assert_terminal(Reply::StreamOutOfRange, Code::OutOfRange, 1).await;
}
#[tokio::test]
async fn initial_out_of_range_preserves_status() {
    assert_terminal(Reply::InitialOutOfRange, Code::OutOfRange, 1).await;
}
#[tokio::test]
async fn retryable_error_reconnects_and_retains_requested_slot() {
    assert_terminal(Reply::TransientThenOutOfRange, Code::OutOfRange, 2).await;
}

#[tokio::test]
async fn default_client_omits_internal_header() {
    let server = TestServer::start(Reply::Data).await;
    let (stream, _handle) = subscribe(server.config(), request());
    futures::pin_mut!(stream);
    let update = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(update.update_oneof, Some(UpdateOneof::Account(_))));
    assert_eq!(server.requests.lock().unwrap()[0].headers(), (None, None));
}

#[tokio::test]
async fn intra_slot_client_sends_only_the_intra_slot_header() {
    let server = TestServer::start(Reply::Data).await;
    let options = SubscribeOptions::default().with_intra_slot_updates(true);
    assert_delivers_data(&server, server.config(), options, (Some("true"), None)).await;
}

#[tokio::test]
async fn default_client_still_retries_out_of_range() {
    for reply in [Reply::InitialOutOfRange, Reply::StreamOutOfRange] {
        let server = TestServer::start(reply).await;
        let (stream, _handle) = subscribe(server.config(), request());
        futures::pin_mut!(stream);
        assert!(tokio::time::timeout(Duration::from_secs(6), stream.next())
            .await
            .is_err());
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests
            .iter()
            .all(|request| request.from_slot == Some(95) && request.headers() == (None, None)));
    }
}

#[tokio::test]
async fn footer_certificates_round_trip_through_the_client() {
    let server = TestServer::start(Reply::Footer).await;
    let request = SubscribeRequest {
        block_footer: HashMap::from([(
            "footer".to_owned(),
            SubscribeRequestFilterBlockFooter {
                include_certificates: Some(true),
            },
        )]),
        ..Default::default()
    };
    let (stream, _handle) = subscribe(server.config(), request);
    futures::pin_mut!(stream);
    let update = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(update, footer_with_certificates());
    assert_eq!(
        server.requests.lock().unwrap()[0].block_footer["footer"].include_certificates,
        Some(true)
    );
}

#[tokio::test]
async fn unary_methods_round_trip() {
    let server = TestServer::start(Reply::Data).await;
    let mut config = server.config();
    config.api_key = "secret".into();
    let client = crate::LaserstreamClient::connect(config).await.unwrap();

    assert_eq!(client.get_slot(None).await.unwrap().slot, 999);
    assert_eq!(
        client.get_slot(Some(CommitmentLevel::Finalized)).await.unwrap().slot,
        1002
    );
    assert_eq!(client.get_block_height(None).await.unwrap().block_height, 900);
    let bh = client
        .get_latest_blockhash(Some(CommitmentLevel::Confirmed))
        .await
        .unwrap();
    assert_eq!((bh.slot, bh.blockhash.as_str(), bh.last_valid_block_height), (1001, "hash", 7));
    assert!(client.is_blockhash_valid(&bh.blockhash, None).await.unwrap().valid);
    assert!(!client.is_blockhash_valid("other", None).await.unwrap().valid);
    assert_eq!(client.ping(7).await.unwrap().count, 7);
    assert_eq!(
        client.subscribe_replay_info().await.unwrap().first_available,
        Some(42)
    );
    assert_eq!(
        client.get_version().await.unwrap().version,
        format!("secret|{SDK_NAME}")
    );
}

#[tokio::test]
async fn unary_connect_fails_for_unreachable_endpoint() {
    let config = LaserstreamConfig::new("http://127.0.0.1:1".into(), String::new());
    assert!(crate::LaserstreamClient::connect(config).await.is_err());
}

#[derive(Clone, Copy, Debug)]
enum Reply {
    StreamOutOfRange,
    InitialOutOfRange,
    Data,
    Footer,
    TransientThenOutOfRange,
}

/// The `x-intra-slot-updates` and `x-disable-geyser-archive` header values.
type Headers = (Option<&'static str>, Option<&'static str>);

#[derive(Debug)]
struct ObservedRequest {
    intra_slot_updates: Option<String>,
    disable_archive: Option<String>,
    from_slot: Option<u64>,
    block_footer: HashMap<String, SubscribeRequestFilterBlockFooter>,
}

impl ObservedRequest {
    fn headers(&self) -> (Option<&str>, Option<&str>) {
        (self.intra_slot_updates.as_deref(), self.disable_archive.as_deref())
    }
}

#[derive(Debug)]
struct TestGeyser {
    reply: Reply,
    requests: Arc<Mutex<Vec<ObservedRequest>>>,
}

type Updates = Pin<Box<dyn Stream<Item = Result<SubscribeUpdate, Status>> + Send>>;

#[tonic::async_trait]
impl geyser_server::Geyser for TestGeyser {
    type SubscribeStream = Updates;
    type SubscribePreprocessedStream =
        Pin<Box<dyn Stream<Item = Result<SubscribePreprocessedUpdate, Status>> + Send>>;

    async fn subscribe(
        &self,
        request: Request<Streaming<SubscribeRequest>>,
    ) -> Result<Response<Updates>, Status> {
        let header = |name: &str| {
            request
                .metadata()
                .get(name)
                .map(|value| value.to_str().unwrap().to_owned())
        };
        let (intra_slot_updates, disable_archive) =
            (header("x-intra-slot-updates"), header("x-disable-geyser-archive"));
        let first = request.into_inner().message().await?.unwrap();
        let attempt = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(ObservedRequest {
                intra_slot_updates,
                disable_archive,
                from_slot: first.from_slot,
                block_footer: first.block_footer,
            });
            requests.len()
        };
        if matches!(self.reply, Reply::InitialOutOfRange) {
            return Err(Status::out_of_range(SLOT_TOO_OLD_MESSAGE));
        }
        let update = match self.reply {
            Reply::StreamOutOfRange => Err(Status::out_of_range(SLOT_TOO_OLD_MESSAGE)),
            Reply::TransientThenOutOfRange if attempt == 1 => Err(Status::unavailable("restart")),
            Reply::TransientThenOutOfRange => Err(Status::out_of_range(SLOT_TOO_OLD_MESSAGE)),
            Reply::Footer => Ok(footer_with_certificates()),
            _ => Ok(SubscribeUpdate {
                filters: vec!["accounts".into()],
                update_oneof: Some(UpdateOneof::Account(SubscribeUpdateAccount {
                    slot: 100,
                    ..Default::default()
                })),
                ..Default::default()
            }),
        };
        Ok(Response::new(
            Box::pin(futures::stream::iter([update])) as Updates
        ))
    }

    async fn subscribe_preprocessed(
        &self,
        _: Request<Streaming<SubscribePreprocessedRequest>>,
    ) -> Result<Response<Self::SubscribePreprocessedStream>, Status> {
        Err(Status::unimplemented("unused"))
    }
    async fn subscribe_replay_info(
        &self,
        _: Request<SubscribeReplayInfoRequest>,
    ) -> Result<Response<SubscribeReplayInfoResponse>, Status> {
        Ok(Response::new(SubscribeReplayInfoResponse { first_available: Some(42) }))
    }
    async fn ping(&self, req: Request<PingRequest>) -> Result<Response<PongResponse>, Status> {
        Ok(Response::new(PongResponse { count: req.into_inner().count }))
    }
    async fn get_latest_blockhash(
        &self,
        req: Request<GetLatestBlockhashRequest>,
    ) -> Result<Response<GetLatestBlockhashResponse>, Status> {
        Ok(Response::new(GetLatestBlockhashResponse {
            slot: 1000 + req.into_inner().commitment.unwrap_or(-1) as u64,
            blockhash: "hash".into(),
            last_valid_block_height: 7,
        }))
    }
    async fn get_block_height(
        &self,
        _: Request<GetBlockHeightRequest>,
    ) -> Result<Response<GetBlockHeightResponse>, Status> {
        Ok(Response::new(GetBlockHeightResponse { block_height: 900 }))
    }
    async fn get_slot(
        &self,
        req: Request<GetSlotRequest>,
    ) -> Result<Response<GetSlotResponse>, Status> {
        // Encode the commitment into the slot so tests can verify it was sent.
        let slot = match req.into_inner().commitment {
            Some(c) => 1000 + c as u64,
            None => 999,
        };
        Ok(Response::new(GetSlotResponse { slot }))
    }
    async fn is_blockhash_valid(
        &self,
        req: Request<IsBlockhashValidRequest>,
    ) -> Result<Response<IsBlockhashValidResponse>, Status> {
        let valid = req.into_inner().blockhash == "hash";
        Ok(Response::new(IsBlockhashValidResponse { slot: 5, valid }))
    }
    async fn get_version(
        &self,
        req: Request<GetVersionRequest>,
    ) -> Result<Response<GetVersionResponse>, Status> {
        // Echo auth + SDK headers so tests can verify the interceptor ran.
        let md = req.metadata();
        let get = |k: &str| md.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
        Ok(Response::new(GetVersionResponse {
            version: format!("{}|{}", get("x-token"), get("x-sdk-name")),
        }))
    }
}

struct TestServer {
    endpoint: String,
    requests: Arc<Mutex<Vec<ObservedRequest>>>,
    task: tokio::task::JoinHandle<()>,
}

impl TestServer {
    async fn start(reply: Reply) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let service = TestGeyser {
            reply,
            requests: requests.clone(),
        };
        let incoming = async_stream::stream! {
            loop { yield listener.accept().await.map(|(socket, _)| socket); }
        };
        let task = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(geyser_server::GeyserServer::new(service))
                .serve_with_incoming(incoming)
                .await
                .unwrap();
        });
        Self {
            endpoint,
            requests,
            task,
        }
    }

    fn config(&self) -> LaserstreamConfig {
        LaserstreamConfig::new(self.endpoint.clone(), String::new())
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn request() -> SubscribeRequest {
    SubscribeRequest {
        accounts: std::collections::HashMap::from([(
            "accounts".into(),
            SubscribeRequestFilterAccounts::default(),
        )]),
        from_slot: Some(95),
        ..Default::default()
    }
}

fn footer_with_certificates() -> SubscribeUpdate {
    let aggregate = |fill: u8, block_id: Vec<u8>| BlockFooterVotesAggregate {
        signature_kind: BlockFooterSignatureKind::CompressedBls12381G2 as i32,
        signature: vec![fill; 96],
        block_id,
        signer_bitmap: vec![1, 3, 0, 0b101],
    };
    let block_id = vec![0xbb; 32];
    SubscribeUpdate {
        filters: vec!["footer".into()],
        update_oneof: Some(UpdateOneof::BlockFooter(SubscribeUpdateBlockFooter {
            slot: 42,
            bank_id: 7,
            bank_hash: vec![0xaa; 32],
            block_producer_time_nanos: 1_700_000_000_000_000_000,
            block_user_agent: b"agave/4.3".to_vec(),
            block_final_cert: Some(BlockFooterFinalCert {
                slot: 40,
                final_aggregate: Some(aggregate(0x11, Vec::new())),
                notar_aggregate: Some(aggregate(0x12, block_id.clone())),
            }),
            skip_reward_cert: Some(BlockFooterSkipRewardCert {
                slot: 39,
                aggregate: Some(aggregate(0x13, Vec::new())),
            }),
            notar_reward_cert: Some(BlockFooterNotarRewardCert {
                slot: 41,
                aggregate: Some(aggregate(0x14, block_id)),
            }),
        })),
        ..Default::default()
    }
}
async fn assert_terminal(reply: Reply, code: Code, attempts: usize) {
    let server = TestServer::start(reply).await;
    let options = SubscribeOptions::default().with_intra_slot_updates(true);
    assert_terminal_with_config(&server, server.config(), options, code, attempts, (Some("true"), None)).await;
}

async fn assert_delivers_data(server: &TestServer, config: LaserstreamConfig, options: SubscribeOptions, headers: Headers) {
    let (stream, _handle) = subscribe_with_options(config, request(), options);
    futures::pin_mut!(stream);
    let update = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(update.update_oneof, Some(UpdateOneof::Account(_))));
    assert_eq!(server.requests.lock().unwrap()[0].headers(), headers);
}

async fn assert_terminal_with_config(
    server: &TestServer,
    config: LaserstreamConfig,
    options: SubscribeOptions,
    code: Code,
    attempts: usize,
    expected_headers: Headers,
) {
    let (stream, _handle) = subscribe_with_options(config, request(), options);
    futures::pin_mut!(stream);
    let next = tokio::time::timeout(Duration::from_secs(8), stream.next())
        .await
        .expect("non-retryable errors must surface without endless retries");
    match next {
        Some(Err(LaserstreamError::Status(status))) => {
            assert_eq!(status.code(), code);
            assert_eq!(status.message(), SLOT_TOO_OLD_MESSAGE);
            assert!(status.details().is_empty());
        }
        other => panic!("expected terminal {code:?}, got {other:?}"),
    }
    assert!(stream.next().await.is_none());
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), attempts);
    for request in requests.iter() {
        assert_eq!(request.headers(), expected_headers);
        assert_eq!(request.from_slot, Some(95));
    }
}

#[test]
fn merge_subscribe_requests_replaces_footer_filters_and_keeps_internal_slot_tracker() {
    let internal_slot_sub_id = "__internal_slot_tracker_test";
    let mut current = SubscribeRequest {
        slots: HashMap::from([(
            internal_slot_sub_id.to_owned(),
            SubscribeRequestFilterSlots {
                filter_by_commitment: Some(true),
                ..Default::default()
            },
        )]),
        block_footer: HashMap::from([(
            "old-footer".to_owned(),
            SubscribeRequestFilterBlockFooter::default(),
        )]),
        ..Default::default()
    };

    let modification = SubscribeRequest {
        block_footer: HashMap::from([(
            "new-footer".to_owned(),
            SubscribeRequestFilterBlockFooter::default(),
        )]),
        ..Default::default()
    };

    merge_subscribe_requests(&mut current, modification, internal_slot_sub_id);

    assert!(current.slots.contains_key(internal_slot_sub_id));
    assert!(current.block_footer.contains_key("new-footer"));
    assert!(!current.block_footer.contains_key("old-footer"));
}

#[test]
fn merge_subscribe_requests_can_remove_footer_filters() {
    let internal_slot_sub_id = "__internal_slot_tracker_test";
    let mut current = SubscribeRequest {
        slots: HashMap::from([(
            internal_slot_sub_id.to_owned(),
            SubscribeRequestFilterSlots::default(),
        )]),
        block_footer: HashMap::from([("footer".to_owned(), SubscribeRequestFilterBlockFooter::default())]),
        ..Default::default()
    };

    merge_subscribe_requests(
        &mut current,
        SubscribeRequest::default(),
        internal_slot_sub_id,
    );

    assert!(current.block_footer.is_empty());
    assert!(current.slots.contains_key(internal_slot_sub_id));
}

#[test]
fn merge_subscribe_requests_replaces_every_map_and_keeps_connection_fields() {
    let internal_slot_sub_id = "__internal_slot_tracker_test";
    let mut current = SubscribeRequest {
        accounts: HashMap::from([("old-acc".to_owned(), SubscribeRequestFilterAccounts::default())]),
        slots: HashMap::from([
            (internal_slot_sub_id.to_owned(), SubscribeRequestFilterSlots::default()),
            ("old-slot".to_owned(), SubscribeRequestFilterSlots::default()),
        ]),
        transactions: HashMap::from([("old-tx".to_owned(), SubscribeRequestFilterTransactions::default())]),
        transactions_status: HashMap::from([("old-tx-status".to_owned(), SubscribeRequestFilterTransactions::default())]),
        blocks: HashMap::from([("old-block".to_owned(), SubscribeRequestFilterBlocks::default())]),
        blocks_meta: HashMap::from([("old-block-meta".to_owned(), SubscribeRequestFilterBlocksMeta::default())]),
        block_footer: HashMap::from([("old-footer".to_owned(), SubscribeRequestFilterBlockFooter::default())]),
        entry: HashMap::from([("old-entry".to_owned(), SubscribeRequestFilterEntry::default())]),
        accounts_data_slice: vec![SubscribeRequestAccountsDataSlice { offset: 1, length: 2 }],
        commitment: Some(1),
        from_slot: Some(99),
        ping: Some(SubscribeRequestPing { id: 7 }),
    };
    let modification = SubscribeRequest {
        accounts: HashMap::from([("new-acc".to_owned(), SubscribeRequestFilterAccounts::default())]),
        slots: HashMap::from([("new-slot".to_owned(), SubscribeRequestFilterSlots::default())]),
        transactions: HashMap::from([("new-tx".to_owned(), SubscribeRequestFilterTransactions::default())]),
        transactions_status: HashMap::from([("new-tx-status".to_owned(), SubscribeRequestFilterTransactions::default())]),
        blocks: HashMap::from([("new-block".to_owned(), SubscribeRequestFilterBlocks::default())]),
        blocks_meta: HashMap::from([("new-block-meta".to_owned(), SubscribeRequestFilterBlocksMeta::default())]),
        block_footer: HashMap::from([("new-footer".to_owned(), SubscribeRequestFilterBlockFooter::default())]),
        entry: HashMap::from([("new-entry".to_owned(), SubscribeRequestFilterEntry::default())]),
        accounts_data_slice: vec![SubscribeRequestAccountsDataSlice { offset: 10, length: 20 }],
        commitment: Some(2),
        from_slot: Some(1),
        ping: Some(SubscribeRequestPing { id: 1 }),
    };

    merge_subscribe_requests(&mut current, modification, internal_slot_sub_id);

    // Every subscription map is replaced by the modification's, not merged with the old one.
    assert_eq!(current.accounts.keys().map(String::as_str).collect::<Vec<_>>(), ["new-acc"]);
    assert_eq!(current.transactions.keys().map(String::as_str).collect::<Vec<_>>(), ["new-tx"]);
    assert_eq!(
        current.transactions_status.keys().map(String::as_str).collect::<Vec<_>>(),
        ["new-tx-status"]
    );
    assert_eq!(current.blocks.keys().map(String::as_str).collect::<Vec<_>>(), ["new-block"]);
    assert_eq!(
        current.blocks_meta.keys().map(String::as_str).collect::<Vec<_>>(),
        ["new-block-meta"]
    );
    assert_eq!(current.block_footer.keys().map(String::as_str).collect::<Vec<_>>(), ["new-footer"]);
    assert_eq!(current.entry.keys().map(String::as_str).collect::<Vec<_>>(), ["new-entry"]);
    assert_eq!(
        current.accounts_data_slice,
        [SubscribeRequestAccountsDataSlice { offset: 10, length: 20 }]
    );

    // Slots are replaced too, but the internal slot tracker survives.
    let mut slots: Vec<_> = current.slots.keys().map(String::as_str).collect();
    slots.sort_unstable();
    assert_eq!(slots, [internal_slot_sub_id, "new-slot"]);

    assert_eq!(current.commitment, Some(2));
    // Connection-specific fields are never taken from the modification.
    assert_eq!(current.from_slot, Some(99));
    assert_eq!(current.ping, Some(SubscribeRequestPing { id: 7 }));
}

#[test]
fn footer_resume_slot_tracks_block_footer_updates() {
    let update = SubscribeUpdate {
        update_oneof: Some(subscribe_update::UpdateOneof::BlockFooter(
            SubscribeUpdateBlockFooter {
                slot: 42,
                bank_id: 7,
                bank_hash: vec![1; 32],
                block_producer_time_nanos: 123,
                block_user_agent: b"agave".to_vec(),
                ..Default::default()
            },
        )),
        ..Default::default()
    };

    assert_eq!(footer_resume_slot(&update), Some(42));
}

#[test]
fn footer_resume_slot_ignores_non_footer_updates() {
    let update = SubscribeUpdate {
        update_oneof: Some(subscribe_update::UpdateOneof::Account(
            SubscribeUpdateAccount {
                slot: 42,
                ..Default::default()
            },
        )),
        ..Default::default()
    };

    assert_eq!(footer_resume_slot(&update), None);
}
