use crate::{
    config::CompressionEncoding as ConfigCompressionEncoding, LaserstreamConfig, LaserstreamError,
};
use async_stream::stream;
use futures::StreamExt;
use futures_channel::mpsc as futures_mpsc;
use futures_util::{sink::SinkExt, Stream};
use std::{pin::Pin, time::Duration};
use tokio::sync::mpsc;
use tokio::time::sleep;
use tracing::{error, instrument, warn};
use uuid;
use yellowstone_grpc_client::{ClientTlsConfig, Interceptor};
use yellowstone_grpc_proto::geyser::{
    subscribe_update::UpdateOneof, SubscribeRequest, SubscribeRequestFilterSlots,
    SubscribeRequestPing, SubscribeUpdate,
};
use yellowstone_grpc_proto::prelude::geyser_client::GeyserClient;
use yellowstone_grpc_proto::tonic::{
    codec::CompressionEncoding, metadata::MetadataValue, transport::Endpoint, Request, Status,
};

const HARD_CAP_RECONNECT_ATTEMPTS: u32 = (20 * 60) / 5; // 20 mins / 5 sec interval
const FIXED_RECONNECT_INTERVAL_MS: u64 = 5000; // 5 seconds fixed interval
const SDK_NAME: &str = "laserstream-rust";
const SDK_VERSION: &str = "0.1.3";

/// Custom interceptor that adds SDK metadata headers to all gRPC requests
#[derive(Clone)]
struct SdkMetadataInterceptor {
    x_token: Option<yellowstone_grpc_proto::tonic::metadata::AsciiMetadataValue>,
}

impl SdkMetadataInterceptor {
    fn new(api_key: String) -> Result<Self, Status> {
        let x_token = if !api_key.is_empty() {
            Some(
                api_key
                    .parse()
                    .map_err(|e| Status::invalid_argument(format!("Invalid API key: {}", e)))?,
            )
        } else {
            None
        };
        Ok(Self { x_token })
    }
}

impl Interceptor for SdkMetadataInterceptor {
    fn call(&mut self, mut request: Request<()>) -> Result<Request<()>, Status> {
        // Add x-token if present
        if let Some(ref x_token) = self.x_token {
            request.metadata_mut().insert("x-token", x_token.clone());
        }

        // Add SDK metadata headers
        request
            .metadata_mut()
            .insert("x-sdk-name", MetadataValue::from_static(SDK_NAME));
        request
            .metadata_mut()
            .insert("x-sdk-version", MetadataValue::from_static(SDK_VERSION));

        Ok(request)
    }
}

/// Handle for managing a bidirectional streaming subscription.
#[derive(Clone)]
pub struct StreamHandle {
    write_tx: mpsc::UnboundedSender<SubscribeRequest>,
}

impl StreamHandle {
    /// Send a new subscription request to update the active subscription.
    pub async fn write(&self, request: SubscribeRequest) -> Result<(), LaserstreamError> {
        self.write_tx
            .send(request)
            .map_err(|_| LaserstreamError::ConnectionError("Write channel closed".to_string()))
    }
}

/// Merge a stream-write update into the cached request that will be reused on reconnect.
fn merge_subscribe_requests(
    base: &mut SubscribeRequest,
    update: &SubscribeRequest,
    internal_slot_sub_id: &str,
    replay_enabled: bool,
) {
    // Preserve the internal slot subscription (if present) so we don't drop it during merges.
    let internal_slot_entry = if replay_enabled && !internal_slot_sub_id.is_empty() {
        base.slots.get(internal_slot_sub_id).cloned()
    } else {
        None
    };

    if !update.accounts.is_empty() {
        base.accounts.extend(update.accounts.clone());
    }
    if !update.slots.is_empty() {
        base.slots.extend(update.slots.clone());
    }
    if !update.transactions.is_empty() {
        base.transactions.extend(update.transactions.clone());
    }
    if !update.transactions_status.is_empty() {
        base.transactions_status
            .extend(update.transactions_status.clone());
    }
    if !update.blocks.is_empty() {
        base.blocks.extend(update.blocks.clone());
    }
    if !update.blocks_meta.is_empty() {
        base.blocks_meta.extend(update.blocks_meta.clone());
    }
    if !update.entry.is_empty() {
        base.entry.extend(update.entry.clone());
    }
    if !update.accounts_data_slice.is_empty() {
        base.accounts_data_slice
            .extend_from_slice(&update.accounts_data_slice);
    }

    if let Some(commitment) = update.commitment {
        base.commitment = Some(commitment);
    }
    if let Some(from_slot) = update.from_slot {
        base.from_slot = Some(from_slot);
    }

    // Re-apply the internal slot subscription after merging to ensure it survives overwrites.
    if let Some(slot_entry) = internal_slot_entry {
        base.slots
            .insert(internal_slot_sub_id.to_string(), slot_entry);
    }
}

/// Establishes a gRPC connection, handles the subscription lifecycle,
/// and provides a stream of updates. Automatically reconnects on failure.
#[instrument(skip(config, request))]
pub fn subscribe(
    config: LaserstreamConfig,
    request: SubscribeRequest,
) -> (
    impl Stream<Item = Result<SubscribeUpdate, LaserstreamError>>,
    StreamHandle,
) {
    let (write_tx, mut write_rx) = mpsc::unbounded_channel::<SubscribeRequest>();
    let handle = StreamHandle { write_tx };
    let update_stream = stream! {
        let mut reconnect_attempts = 0;
        let mut tracked_slot: u64 = 0;

        // Determine the effective max reconnect attempts
        let effective_max_attempts = config
            .max_reconnect_attempts
            .unwrap_or(HARD_CAP_RECONNECT_ATTEMPTS) // Default to hard cap if not set
            .min(HARD_CAP_RECONNECT_ATTEMPTS); // Enforce hard cap

        // Keep original request for reconnection attempts
        let mut current_request = request.clone();
        let internal_slot_sub_id = format!("internal-{}", uuid::Uuid::new_v4().to_string().split('-').next().unwrap());

        // Get replay behavior from config
        let replay_enabled = config.replay;

        // Add internal slot subscription only when replay is enabled
        if replay_enabled {
            current_request.slots.insert(
                internal_slot_sub_id.clone(),
                SubscribeRequestFilterSlots {
                    filter_by_commitment: Some(true), // Use same commitment as user request
                    ..Default::default()
                }
            );
        }

        // Clear any user-provided from_slot if replay is disabled
        if !replay_enabled {
            current_request.from_slot = None;
        }

        let api_key_string = config.api_key.clone();

        loop {

            let mut attempt_request = current_request.clone();

            // On reconnection, use the last tracked slot with fork safety only if replay is enabled
            if reconnect_attempts > 0 && tracked_slot > 0 && replay_enabled {
                // Apply fork safety margin for PROCESSED commitment (default)
                let commitment_level = attempt_request.commitment.unwrap_or(0);
                let from_slot = match commitment_level {
                    0 => tracked_slot.saturating_sub(31), // PROCESSED: rewind by 31 slots
                    1 | 2 => tracked_slot,                 // CONFIRMED/FINALIZED: exact slot
                    _ => tracked_slot.saturating_sub(31),  // Unknown: default to safe behavior
                    };

                attempt_request.from_slot = Some(from_slot);
            } else if !replay_enabled {
                // Ensure from_slot is always None when replay is disabled
                attempt_request.from_slot = None;
            }

            match connect_and_subscribe_once(&config, attempt_request, api_key_string.clone()).await {
                Ok((sender, stream)) => {
                    // Successful connection – reset attempt counter so we don't hit the cap
                    reconnect_attempts = 0;

                    // Box sender and stream here before processing
                    let mut sender: Pin<Box<dyn futures_util::Sink<SubscribeRequest, Error = futures_mpsc::SendError> + Send>> = Box::pin(sender);
                    // Ensure the boxed stream yields Result<_, Status>
                    let mut stream: Pin<Box<dyn Stream<Item = Result<SubscribeUpdate, Status>> + Send>> = Box::pin(stream);

                    // Ping interval timer
                    let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
                    ping_interval.tick().await; // Skip first immediate tick
                    let mut ping_id = 0i32;

                    loop {
                        tokio::select! {
                            // Send periodic ping
                            _ = ping_interval.tick() => {
                                ping_id = ping_id.wrapping_add(1);
                                let ping_request = SubscribeRequest {
                                    ping: Some(SubscribeRequestPing { id: ping_id }),
                                    ..Default::default()
                                };
                                let _ = sender.send(ping_request).await;
                            },
                            // Handle incoming messages from the server
                            result = stream.next() => {
                                if let Some(result) = result {
                                    match result {
                                        Ok(update) => {

                                            // Handle ping/pong
                                            if matches!(&update.update_oneof, Some(UpdateOneof::Ping(_))) {
                                                let pong_req = SubscribeRequest { ping: Some(SubscribeRequestPing { id: 1 }), ..Default::default() };
                                                if let Err(e) = sender.send(pong_req).await {
                                                    warn!(error = %e, "Failed to send pong");
                                                    break;
                                                }
                                                continue;
                                            }

                                            // Do not forward server 'Pong' updates to consumers either
                                            if matches!(&update.update_oneof, Some(UpdateOneof::Pong(_))) {
                                                continue;
                                            }

                                // Track the latest slot from any slot update (including internal subscription)
                                if let Some(UpdateOneof::Slot(s)) = &update.update_oneof {
                                    if replay_enabled {
                                        tracked_slot = s.slot;
                                    }

                                    // Skip if this slot update is EXCLUSIVELY from our internal subscription
                                    if update.filters.len() == 1 && update.filters.contains(&internal_slot_sub_id) {
                                        continue;
                                    }
                                }

                                            // Filter out internal subscription from filters before yielding (only if replay is enabled)
                                            let mut clean_update = update;
                                            if replay_enabled {
                                                clean_update.filters.retain(|f| f != &internal_slot_sub_id);

                                                // Only yield if there are still filters after cleaning
                                                if !clean_update.filters.is_empty() {
                                                    yield Ok(clean_update);
                                                }
                                            } else {
                                                // When replay is disabled, yield all updates as-is
                                                yield Ok(clean_update);
                                            }
                                        }
                                        Err(status) => {
                                            // Yield the error to consumer AND continue with reconnection
                                            warn!(error = %status, "Stream error, will reconnect after 5s delay");
                                            yield Err(LaserstreamError::Status(status.clone()));
                                            break;
                                        }
                                    }
                                } else {
                                    // Stream ended
                                    break;
                                }
                            }

                            // Handle write requests from the user
                            Some(write_request) = write_rx.recv() => {
                                // Persist the update so future reconnects reuse the latest subscription
                                merge_subscribe_requests(&mut current_request, &write_request, &internal_slot_sub_id, replay_enabled);

                                if let Err(e) = sender.send(write_request).await {
                                    warn!(error = %e, "Failed to send write request");
                                    break;
                                }
                            }
                        }
                    }
                }
                Err(err) => {
                    // Increment reconnect attempts
                    reconnect_attempts += 1;

                    // Log error internally but don't yield to consumer until max attempts exhausted
                    error!(error = %err, attempt = reconnect_attempts, max_attempts = effective_max_attempts, "Connection failed, will retry after 5s delay");

                    // Check if exceeded max reconnect attempts
                    if reconnect_attempts >= effective_max_attempts {
                        error!(attempts = effective_max_attempts, "Max reconnection attempts reached");
                        // Only report error to consumer after exhausting all retries
                        yield Err(LaserstreamError::MaxReconnectAttempts(Status::cancelled(
                            format!("Connection failed after {} attempts", effective_max_attempts)
                        )));
                        return;
                    }
                }
            }

            // Wait 5s before retry
            let delay = Duration::from_millis(FIXED_RECONNECT_INTERVAL_MS);
            sleep(delay).await;
        }
    };

    (update_stream, handle)
}

#[instrument(skip(config, request, api_key))]
async fn connect_and_subscribe_once(
    config: &LaserstreamConfig,
    request: SubscribeRequest,
    api_key: String,
) -> Result<
    (
        impl futures_util::Sink<SubscribeRequest, Error = futures_mpsc::SendError> + Send,
        impl Stream<Item = Result<SubscribeUpdate, yellowstone_grpc_proto::tonic::Status>> + Send,
    ),
    Status,
> {
    let options = &config.channel_options;

    // Create our custom interceptor with SDK metadata
    let interceptor = SdkMetadataInterceptor::new(api_key)?;

    // Build endpoint with all options
    let mut endpoint = Endpoint::from_shared(config.endpoint.clone())
        .map_err(|e| Status::internal(format!("Failed to parse endpoint: {}", e)))?
        .connect_timeout(Duration::from_secs(
            options.connect_timeout_secs.unwrap_or(10),
        ))
        .timeout(Duration::from_secs(options.timeout_secs.unwrap_or(30)))
        .http2_keep_alive_interval(Duration::from_secs(
            options.http2_keep_alive_interval_secs.unwrap_or(30),
        ))
        .keep_alive_timeout(Duration::from_secs(
            options.keep_alive_timeout_secs.unwrap_or(5),
        ))
        .keep_alive_while_idle(options.keep_alive_while_idle.unwrap_or(true))
        .initial_stream_window_size(options.initial_stream_window_size.or(Some(1024 * 1024 * 4)))
        .initial_connection_window_size(
            options
                .initial_connection_window_size
                .or(Some(1024 * 1024 * 8)),
        )
        .http2_adaptive_window(options.http2_adaptive_window.unwrap_or(true))
        .tcp_nodelay(options.tcp_nodelay.unwrap_or(true))
        .buffer_size(options.buffer_size.or(Some(1024 * 64)));

    if let Some(tcp_keepalive_secs) = options.tcp_keepalive_secs {
        endpoint = endpoint.tcp_keepalive(Some(Duration::from_secs(tcp_keepalive_secs)));
    }

    // Configure TLS
    endpoint = endpoint
        .tls_config(ClientTlsConfig::new().with_enabled_roots())
        .map_err(|e| Status::internal(format!("TLS config error: {}", e)))?;

    // Connect to create channel
    let channel = endpoint
        .connect()
        .await
        .map_err(|e| Status::unavailable(format!("Connection failed: {}", e)))?;

    // Create geyser client with our custom interceptor
    let mut geyser_client = GeyserClient::with_interceptor(channel, interceptor);

    // Configure message size limits
    geyser_client = geyser_client
        .max_decoding_message_size(options.max_decoding_message_size.unwrap_or(1_000_000_000))
        .max_encoding_message_size(options.max_encoding_message_size.unwrap_or(32_000_000));

    // Configure compression if specified
    if let Some(send_comp) = options.send_compression {
        let encoding = match send_comp {
            ConfigCompressionEncoding::Gzip => CompressionEncoding::Gzip,
            ConfigCompressionEncoding::Zstd => CompressionEncoding::Zstd,
        };
        geyser_client = geyser_client.send_compressed(encoding);
    }

    // Configure accepted compression encodings
    if let Some(ref accept_comps) = options.accept_compression {
        for comp in accept_comps {
            let encoding = match comp {
                ConfigCompressionEncoding::Gzip => CompressionEncoding::Gzip,
                ConfigCompressionEncoding::Zstd => CompressionEncoding::Zstd,
            };
            geyser_client = geyser_client.accept_compressed(encoding);
        }
    } else {
        // Default: accept both gzip and zstd like yellowstone-grpc
        geyser_client = geyser_client
            .accept_compressed(CompressionEncoding::Gzip)
            .accept_compressed(CompressionEncoding::Zstd);
    }

    // Create bidirectional stream
    let (mut subscribe_tx, subscribe_rx) = futures_mpsc::unbounded();
    subscribe_tx
        .send(request)
        .await
        .map_err(|e| Status::internal(format!("Failed to send initial request: {}", e)))?;

    let response = geyser_client
        .subscribe(subscribe_rx)
        .await
        .map_err(|e| Status::internal(format!("Subscription failed: {}", e)))?;

    Ok((subscribe_tx, response.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use yellowstone_grpc_proto::geyser::{
        SubscribeRequest, SubscribeRequestAccountsDataSlice, SubscribeRequestFilterAccounts,
        SubscribeRequestFilterBlocks, SubscribeRequestFilterBlocksMeta,
        SubscribeRequestFilterEntry, SubscribeRequestFilterSlots, SubscribeRequestFilterTransactions,
    };

    fn slot_filter(commit: bool, interslot: bool) -> SubscribeRequestFilterSlots {
        SubscribeRequestFilterSlots {
            filter_by_commitment: Some(commit),
            interslot_updates: Some(interslot),
            ..Default::default()
        }
    }

    fn account_filter(tag: &str) -> SubscribeRequestFilterAccounts {
        SubscribeRequestFilterAccounts {
            account: vec![format!("acct-{tag}")],
            owner: vec![format!("owner-{tag}")],
            nonempty_txn_signature: Some(tag.len() % 2 == 0),
            ..Default::default()
        }
    }

    fn transaction_filter(tag: &str) -> SubscribeRequestFilterTransactions {
        SubscribeRequestFilterTransactions {
            vote: Some(tag.len() % 2 == 0),
            failed: Some(tag.len() % 2 == 1),
            signature: Some(format!("sig-{tag}")),
            account_include: vec![format!("inc-{tag}")],
            account_exclude: vec![format!("exc-{tag}")],
            account_required: vec![format!("req-{tag}")],
        }
    }

    fn block_filter(tag: &str) -> SubscribeRequestFilterBlocks {
        SubscribeRequestFilterBlocks {
            account_include: vec![format!("block-{tag}")],
            include_transactions: Some(true),
            include_accounts: Some(false),
            include_entries: Some(tag.len() % 2 == 0),
        }
    }

    fn data_slice(offset: u64, length: u64) -> SubscribeRequestAccountsDataSlice {
        SubscribeRequestAccountsDataSlice { offset, length }
    }

    fn base_request() -> SubscribeRequest {
        SubscribeRequest::default()
    }

    #[test]
    fn merge_accounts_map_additive_and_override() {
        let mut base = base_request();
        base.accounts.insert("a".into(), account_filter("base"));
        let mut update = base_request();
        update.accounts.insert("b".into(), account_filter("new"));
        update.accounts.insert("a".into(), account_filter("updated"));

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.accounts.len(), 2);
        assert_eq!(base.accounts.get("b"), update.accounts.get("b"));
        assert_eq!(base.accounts.get("a"), update.accounts.get("a"));
    }

    #[test]
    fn merge_slots_additive_and_preserves_internal_on_conflict() {
        let internal_id = "internal-slot";
        let mut base = base_request();
        base.slots
            .insert(internal_id.into(), slot_filter(true, false));
        base.slots.insert("existing".into(), slot_filter(false, false));

        let mut update = base_request();
        update.slots.insert("user".into(), slot_filter(false, true));
        update
            .slots
            .insert(internal_id.into(), slot_filter(false, false));

        let preserved = base.slots.get(internal_id).cloned();
        merge_subscribe_requests(&mut base, &update, internal_id, true);

        assert_eq!(base.slots.get("user"), update.slots.get("user"));
        assert_eq!(base.slots.get("existing"), Some(&slot_filter(false, false)));
        assert_eq!(base.slots.get(internal_id), preserved.as_ref());
    }

    #[test]
    fn merge_transactions_map_additive_and_override() {
        let mut base = base_request();
        base.transactions
            .insert("txn-a".into(), transaction_filter("old"));
        let mut update = base_request();
        update
            .transactions
            .insert("txn-b".into(), transaction_filter("new"));
        update
            .transactions
            .insert("txn-a".into(), transaction_filter("override"));

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.transactions.len(), 2);
        assert_eq!(base.transactions.get("txn-a"), update.transactions.get("txn-a"));
        assert_eq!(base.transactions.get("txn-b"), update.transactions.get("txn-b"));
    }

    #[test]
    fn merge_transactions_status_map_additive_and_override() {
        let mut base = base_request();
        base.transactions_status
            .insert("status-a".into(), transaction_filter("old-status"));
        let mut update = base_request();
        update.transactions_status.insert("status-b".into(), transaction_filter("new-status"));
        update.transactions_status.insert("status-a".into(), transaction_filter("override-status"));

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.transactions_status.len(), 2);
        assert_eq!(
            base.transactions_status.get("status-a"),
            update.transactions_status.get("status-a")
        );
        assert_eq!(
            base.transactions_status.get("status-b"),
            update.transactions_status.get("status-b")
        );
    }

    #[test]
    fn merge_blocks_map_additive_and_override() {
        let mut base = base_request();
        base.blocks.insert("block-a".into(), block_filter("old"));
        let mut update = base_request();
        update.blocks.insert("block-b".into(), block_filter("new"));
        update.blocks.insert("block-a".into(), block_filter("override"));

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.blocks.len(), 2);
        assert_eq!(base.blocks.get("block-a"), update.blocks.get("block-a"));
        assert_eq!(base.blocks.get("block-b"), update.blocks.get("block-b"));
    }

    #[test]
    fn merge_blocks_meta_map_additive() {
        let mut base = base_request();
        base.blocks_meta.insert("meta-a".into(), SubscribeRequestFilterBlocksMeta::default());
        let mut update = base_request();
        update.blocks_meta.insert("meta-b".into(), SubscribeRequestFilterBlocksMeta::default());

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.blocks_meta.len(), 2);
        assert!(base.blocks_meta.contains_key("meta-a"));
        assert!(base.blocks_meta.contains_key("meta-b"));
    }

    #[test]
    fn merge_entry_map_additive_and_override() {
        let mut base = base_request();
        base.entry
            .insert("entry-a".into(), SubscribeRequestFilterEntry::default());
        let mut update = base_request();
        update
            .entry
            .insert("entry-b".into(), SubscribeRequestFilterEntry::default());
        update
            .entry
            .insert("entry-a".into(), SubscribeRequestFilterEntry::default());

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.entry.len(), 2);
        assert!(base.entry.contains_key("entry-a"));
        assert!(base.entry.contains_key("entry-b"));
    }

    #[test]
    fn merge_appends_accounts_data_slice() {
        let mut base = base_request();
        base.accounts_data_slice.push(data_slice(1, 2));

        let mut update = base_request();
        update.accounts_data_slice.push(data_slice(3, 4));
        update.accounts_data_slice.push(data_slice(5, 6));

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.accounts_data_slice.len(), 3);
        assert_eq!(base.accounts_data_slice[1], data_slice(3, 4));
        assert_eq!(base.accounts_data_slice[2], data_slice(5, 6));
    }

    #[test]
    fn merge_overrides_commitment_from_none() {
        let mut base = base_request();
        base.commitment = None;
        let mut update = base_request();
        update.commitment = Some(2);

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.commitment, Some(2));
    }

    #[test]
    fn merge_overrides_commitment_from_some() {
        let mut base = base_request();
        base.commitment = Some(0);
        let mut update = base_request();
        update.commitment = Some(1);

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.commitment, Some(1));
    }

    #[test]
    fn merge_leaves_commitment_when_absent() {
        let mut base = base_request();
        base.commitment = Some(2);
        let mut update = base_request();
        update.commitment = None;

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.commitment, Some(2));
    }

    #[test]
    fn merge_overrides_from_slot_none_to_some() {
        let mut base = base_request();
        base.from_slot = None;
        let mut update = base_request();
        update.from_slot = Some(42);

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.from_slot, Some(42));
    }

    #[test]
    fn merge_overrides_from_slot_some_to_some() {
        let mut base = base_request();
        base.from_slot = Some(5);
        let mut update = base_request();
        update.from_slot = Some(99);

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.from_slot, Some(99));
    }

    #[test]
    fn merge_leaves_from_slot_when_absent() {
        let mut base = base_request();
        base.from_slot = Some(7);
        let mut update = base_request();
        update.from_slot = None;

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.from_slot, Some(7));
    }

    #[test]
    fn merge_empty_update_is_noop() {
        let mut base = base_request();
        base.accounts.insert("a".into(), account_filter("base"));
        base.commitment = Some(2);
        let snapshot = base.clone();
        let update = base_request();

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base, snapshot);
    }

    #[test]
    fn merge_empty_base_takes_update() {
        let mut base = base_request();
        let mut update = base_request();
        update.accounts.insert("a".into(), account_filter("new"));
        update.slots.insert("s".into(), slot_filter(true, false));
        update.commitment = Some(1);
        update.from_slot = Some(10);

        merge_subscribe_requests(&mut base, &update, "internal", true);

        assert_eq!(base.accounts.get("a"), update.accounts.get("a"));
        assert_eq!(base.slots.get("s"), update.slots.get("s"));
        assert_eq!(base.commitment, Some(1));
        assert_eq!(base.from_slot, Some(10));
    }

    #[test]
    fn merge_preserves_internal_when_update_overwrites_slot() {
        let internal_id = "internal-id";
        let mut base = base_request();
        base.slots
            .insert(internal_id.into(), slot_filter(true, false));
        let mut update = base_request();
        update
            .slots
            .insert(internal_id.into(), slot_filter(false, true));

        let preserved = base.slots.get(internal_id).cloned();
        merge_subscribe_requests(&mut base, &update, internal_id, true);

        assert_eq!(base.slots.get(internal_id), preserved.as_ref());
    }

    #[test]
    fn merge_does_not_preserve_internal_when_replay_disabled() {
        let internal_id = "internal-id";
        let mut base = base_request();
        base.slots
            .insert(internal_id.into(), slot_filter(true, false));
        let mut update = base_request();
        update
            .slots
            .insert(internal_id.into(), slot_filter(false, true));

        merge_subscribe_requests(&mut base, &update, internal_id, false);

        assert_eq!(base.slots.get(internal_id), update.slots.get(internal_id));
    }

    #[test]
    fn merge_does_not_preserve_internal_when_id_empty() {
        let mut base = base_request();
        base.slots
            .insert("internal".into(), slot_filter(true, false));
        let mut update = base_request();
        update
            .slots
            .insert("internal".into(), slot_filter(false, true));

        merge_subscribe_requests(&mut base, &update, "", true);

        assert_eq!(base.slots.get("internal"), update.slots.get("internal"));
    }

    #[test]
    fn merge_handles_large_maps_and_preserves_internal() {
        let internal_id = "internal-large";
        let mut base = base_request();
        base.slots
            .insert(internal_id.into(), slot_filter(true, false));
        for i in 0..120 {
            base.accounts
                .insert(format!("acct-{i}"), account_filter(&format!("b{i}")));
        }

        let mut update = base_request();
        for i in 100..200 {
            update
                .accounts
                .insert(format!("acct-{i}"), account_filter(&format!("u{i}")));
        }
        update
            .slots
            .insert(internal_id.into(), slot_filter(false, true));

        let preserved = base.slots.get(internal_id).cloned();
        merge_subscribe_requests(&mut base, &update, internal_id, true);

        assert_eq!(base.accounts.len(), 200);
        assert_eq!(base.slots.get(internal_id), preserved.as_ref());
        assert_eq!(
            base.accounts.get("acct-150"),
            update.accounts.get("acct-150")
        );
    }

    proptest! {
        #[test]
        fn prop_map_union_and_internal_preservation(
            base_slots in proptest::collection::hash_map("slot-[a-z]{1,3}", any::<bool>(), 0..5),
            update_slots in proptest::collection::hash_map("slot-[a-z]{1,3}", any::<bool>(), 0..5),
            replay_enabled in any::<bool>(),
        ) {
            let internal_id = "internal-prop";
            let mut base = base_request();
            for (k, v) in base_slots.iter() {
                base.slots.insert(k.clone(), slot_filter(*v, !*v));
            }
            let internal_filter = slot_filter(true, false);
            base.slots.insert(internal_id.to_string(), internal_filter.clone());

            let mut update = base_request();
            for (k, v) in update_slots.iter() {
                update.slots.insert(k.clone(), slot_filter(*v, *v));
            }

            let base_snapshot = base.slots.clone();
            let update_snapshot = update.slots.clone();

            merge_subscribe_requests(&mut base, &update, internal_id, replay_enabled);

            for (k, v) in update_snapshot.iter() {
                prop_assert_eq!(base.slots.get(k), Some(v));
            }

            for (k, v) in base_snapshot.iter() {
                if k == internal_id {
                    continue;
                }
                if !update_snapshot.contains_key(k) {
                    prop_assert_eq!(base.slots.get(k), Some(v));
                }
            }

            if replay_enabled {
                prop_assert_eq!(base.slots.get(internal_id), Some(&internal_filter));
            } else if let Some(update_val) = update_snapshot.get(internal_id) {
                prop_assert_eq!(base.slots.get(internal_id), Some(update_val));
            }
        }
    }
}
