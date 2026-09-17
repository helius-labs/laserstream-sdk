use super::*;
#[cfg(feature = "internal")]
use laserstream_core_proto::tonic::Code;
use laserstream_core_proto::{
    geyser::*,
    tonic::{self, Response, Streaming},
};
use std::sync::{Arc, Mutex};

const SLOT_TOO_OLD_MESSAGE: &str = "Requested slot 95 is older than the oldest available slot 100. Please request a more recent slot.";

#[cfg(feature = "internal")]
#[test]
fn only_opted_in_out_of_range_is_terminal() {
    for config in [
        LaserstreamConfig::default(),
        LaserstreamConfig::default().internal_disable_geyser_archive_fallback(),
    ] {
        for value in 1..=16 {
            let code = Code::from_i32(value);
            assert_eq!(
                is_terminal_error(&config, &Status::new(code, "test")),
                config.internal_disable_geyser_archive_fallback && code == Code::OutOfRange,
                "{code:?}"
            );
        }
    }
}

#[cfg(feature = "internal")]
#[test]
fn fallback_is_enabled_by_default_and_independent_of_replay() {
    assert!(!LaserstreamConfig::default().internal_disable_geyser_archive_fallback);
    assert!(
        !LaserstreamConfig::new(String::new(), String::new())
            .internal_disable_geyser_archive_fallback
    );
    let config = LaserstreamConfig::default().internal_disable_geyser_archive_fallback();
    assert!(config.replay);
    assert!(config.internal_disable_geyser_archive_fallback);
    assert!(
        config
            .internal_disable_geyser_archive_fallback()
            .internal_disable_geyser_archive_fallback
    );
}

#[cfg(feature = "internal")]
#[tokio::test]
async fn stream_out_of_range_is_terminal() {
    assert_terminal(Reply::StreamOutOfRange, Code::OutOfRange, 1).await;
}
#[cfg(feature = "internal")]
#[tokio::test]
async fn initial_out_of_range_preserves_status() {
    assert_terminal(Reply::InitialOutOfRange, Code::OutOfRange, 1).await;
}
#[cfg(feature = "internal")]
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
    assert!(server.requests.lock().unwrap()[0].disable_archive.is_none());
}

#[cfg(feature = "internal")]
#[tokio::test]
async fn disabled_client_delivers_data_without_acknowledgement() {
    let server = TestServer::start(Reply::Data).await;
    let (stream, _handle) = subscribe(
        server.config().internal_disable_geyser_archive_fallback(),
        request(),
    );
    futures::pin_mut!(stream);
    let update = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(update.update_oneof, Some(UpdateOneof::Account(_))));
    assert_eq!(
        server.requests.lock().unwrap()[0]
            .disable_archive
            .as_deref(),
        Some("true")
    );
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
            .all(|request| request.from_slot == Some(95) && request.disable_archive.is_none()));
    }
}

#[derive(Clone, Copy, Debug)]
enum Reply {
    StreamOutOfRange,
    InitialOutOfRange,
    Data,
    #[cfg(feature = "internal")]
    TransientThenOutOfRange,
}

#[derive(Debug)]
struct ObservedRequest {
    disable_archive: Option<String>,
    from_slot: Option<u64>,
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
        let disable_archive = request
            .metadata()
            .get("x-disable-geyser-archive")
            .map(|value| value.to_str().unwrap().to_owned());
        let first = request.into_inner().message().await?.unwrap();
        let _attempt = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(ObservedRequest {
                disable_archive,
                from_slot: first.from_slot,
            });
            requests.len()
        };
        if matches!(self.reply, Reply::InitialOutOfRange) {
            return Err(Status::out_of_range(SLOT_TOO_OLD_MESSAGE));
        }
        let update = match self.reply {
            Reply::StreamOutOfRange => Err(Status::out_of_range(SLOT_TOO_OLD_MESSAGE)),
            #[cfg(feature = "internal")]
            Reply::TransientThenOutOfRange if _attempt == 1 => Err(Status::unavailable("restart")),
            #[cfg(feature = "internal")]
            Reply::TransientThenOutOfRange => Err(Status::out_of_range(SLOT_TOO_OLD_MESSAGE)),
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
        Err(Status::unimplemented("unused"))
    }
    async fn ping(&self, _: Request<PingRequest>) -> Result<Response<PongResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }
    async fn get_latest_blockhash(
        &self,
        _: Request<GetLatestBlockhashRequest>,
    ) -> Result<Response<GetLatestBlockhashResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }
    async fn get_block_height(
        &self,
        _: Request<GetBlockHeightRequest>,
    ) -> Result<Response<GetBlockHeightResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }
    async fn get_slot(
        &self,
        _: Request<GetSlotRequest>,
    ) -> Result<Response<GetSlotResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }
    async fn is_blockhash_valid(
        &self,
        _: Request<IsBlockhashValidRequest>,
    ) -> Result<Response<IsBlockhashValidResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }
    async fn get_version(
        &self,
        _: Request<GetVersionRequest>,
    ) -> Result<Response<GetVersionResponse>, Status> {
        Err(Status::unimplemented("unused"))
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

#[cfg(feature = "internal")]
async fn assert_terminal(reply: Reply, code: Code, attempts: usize) {
    let server = TestServer::start(reply).await;
    assert_terminal_with_config(
        &server,
        server.config().internal_disable_geyser_archive_fallback(),
        code,
        attempts,
        Some("true"),
    )
    .await;
}

#[cfg(feature = "internal")]
async fn assert_terminal_with_config(
    server: &TestServer,
    config: LaserstreamConfig,
    code: Code,
    attempts: usize,
    expected_header: Option<&str>,
) {
    let (stream, _handle) = subscribe(config, request());
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
        assert_eq!(request.disable_archive.as_deref(), expected_header);
        assert_eq!(request.from_slot, Some(95));
    }
}
