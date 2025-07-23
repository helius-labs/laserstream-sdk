use crate::{LaserstreamConfig, LaserstreamError, config::CompressionEncoding as ConfigCompressionEncoding};
use async_stream::stream;
use futures::{StreamExt, TryStreamExt};
use futures_channel::mpsc as futures_mpsc;
use futures_util::{sink::SinkExt, Stream};
use std::{pin::Pin, time::Duration};
use tokio::sync::mpsc;
use tokio::time::sleep;
use tonic::{Status, codec::CompressionEncoding};
use tracing::{error, instrument, warn};
use uuid;
use yellowstone_grpc_client::{ClientTlsConfig, GeyserGrpcClient};
use yellowstone_grpc_proto::geyser::{
    subscribe_update::UpdateOneof, SubscribeRequest, SubscribeRequestFilterSlots,
    SubscribeRequestPing, SubscribeUpdate,
};

const HARD_CAP_RECONNECT_ATTEMPTS: u32 = (20 * 60) / 5; // 20 mins / 5 sec interval
const FIXED_RECONNECT_INTERVAL_MS: u64 = 5000; // 5 seconds fixed interval

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
        let current_request = request.clone();
        let internal_slot_sub_id = format!("internal-{}", uuid::Uuid::new_v4().to_string().split('-').next().unwrap());

        let api_key_string = config.api_key.clone(); 

        loop {

            let mut attempt_request = current_request.clone();

            // Always add internal slot tracking subscription
            attempt_request.slots.insert(
                internal_slot_sub_id.clone(),
                SubscribeRequestFilterSlots::default()
            );

            // On reconnection, use the last tracked slot with fork safety
            if reconnect_attempts > 0 && tracked_slot > 0 {
                // Apply fork safety margin for PROCESSED commitment (default)
                let commitment_level = attempt_request.commitment.unwrap_or(0);
                let from_slot = match commitment_level {
                    0 => tracked_slot.saturating_sub(31), // PROCESSED: rewind by 31 slots
                    1 | 2 => tracked_slot,                 // CONFIRMED/FINALIZED: exact slot
                    _ => tracked_slot.saturating_sub(31),  // Unknown: default to safe behavior
                };
                attempt_request.from_slot = Some(from_slot);
            }

            match connect_and_subscribe_once(&config, attempt_request, api_key_string.clone()).await {
                Ok((sender, stream)) => {
                    // Successful connection – reset attempt counter so we don't hit the cap
                    reconnect_attempts = 0;

                    // Box sender and stream here before processing
                    let mut sender: Pin<Box<dyn futures_util::Sink<SubscribeRequest, Error = futures_mpsc::SendError> + Send>> = Box::pin(sender);
                    // Ensure the boxed stream yields Result<_, tonic::Status>
                    let mut stream: Pin<Box<dyn Stream<Item = Result<SubscribeUpdate, tonic::Status>> + Send>> =
                        Box::pin(stream.map_err(|ystatus| {
                            // Convert yellowstone_grpc_proto::tonic::Status to tonic::Status
                            let code = tonic::Code::from_i32(ystatus.code() as i32);
                            tonic::Status::new(code, ystatus.message())
                        }));

                    loop {
                        tokio::select! {
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

                                // Always track the latest slot if the update is a Slot update
                                if let Some(UpdateOneof::Slot(s)) = &update.update_oneof {
                                    tracked_slot = s.slot;
                                    
                                    // Skip if this slot update is from our internal subscription
                                    if update.filters.len() == 1 && update.filters.contains(&internal_slot_sub_id) {
                                        continue;
                                    }
                                }

                                            // Filter out internal subscription from filters before yielding
                                            let mut clean_update = update;
                                            clean_update.filters.retain(|f| f != &internal_slot_sub_id);
                                            
                                            // Only yield if there are still filters after cleaning
                                            if !clean_update.filters.is_empty() {
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
                                if let Err(e) = sender.send(write_request).await {
                                    warn!(error = %e, "Failed to send write request");
                                    // Continue processing; don't break the stream
                                }
                            }
                        }
                    }
                }
                Err(err) => {
                    // Log connection error and continue reconnection loop
                    error!(error = %err, "Connection failed, will retry after 5s delay");
                }
            }

            reconnect_attempts += 1;
            if reconnect_attempts >= effective_max_attempts {
                error!(attempts = effective_max_attempts, "Max reconnection attempts reached");
                yield Err(LaserstreamError::MaxReconnectAttempts(Status::cancelled(
                    format!("Max reconnection attempts ({}) reached", effective_max_attempts)
                )));
                return;
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
    tonic::Status,
> {
    let options = &config.channel_options;
    
    let mut builder = GeyserGrpcClient::build_from_shared(config.endpoint.clone())
        .map_err(|e| tonic::Status::internal(format!("Failed to build client: {}", e)))?
        .x_token(Some(api_key))
        .map_err(|e| tonic::Status::unauthenticated(format!("Failed to set API key: {}", e)))?
        .connect_timeout(Duration::from_secs(options.connect_timeout_secs.unwrap_or(10)))
        .timeout(Duration::from_secs(options.timeout_secs.unwrap_or(30)))
        .max_decoding_message_size(options.max_decoding_message_size.unwrap_or(1_000_000_000)) // 1GB default
        .max_encoding_message_size(options.max_encoding_message_size.unwrap_or(32_000_000))    // 32MB default
        .http2_keep_alive_interval(Duration::from_secs(options.http2_keep_alive_interval_secs.unwrap_or(30)))
        .keep_alive_timeout(Duration::from_secs(options.keep_alive_timeout_secs.unwrap_or(5)))  
        .keep_alive_while_idle(options.keep_alive_while_idle.unwrap_or(true))
        .initial_stream_window_size(options.initial_stream_window_size.or(Some(1024 * 1024 * 4)))      // 4MB default
        .initial_connection_window_size(options.initial_connection_window_size.or(Some(1024 * 1024 * 8)))  // 8MB default
        .http2_adaptive_window(options.http2_adaptive_window.unwrap_or(true))                             // Dynamic window sizing
        .tcp_nodelay(options.tcp_nodelay.unwrap_or(true))                                       // Disable Nagle's algorithm
        .tcp_keepalive(options.tcp_keepalive_secs.map(Duration::from_secs))           // TCP keepalive
        .buffer_size(options.buffer_size.or(Some(1024 * 64)))                           // 64KB default
        .tls_config(ClientTlsConfig::new().with_enabled_roots())
        .map_err(|e| tonic::Status::internal(format!("TLS config error: {}", e)))?;
    
    // Configure compression if specified
    if let Some(send_comp) = options.send_compression {
        let encoding = match send_comp {
            ConfigCompressionEncoding::Gzip => CompressionEncoding::Gzip,
            ConfigCompressionEncoding::Zstd => CompressionEncoding::Zstd,
        };
        builder = builder.send_compressed(encoding);
    }
    
    // Configure accepted compression encodings
    if let Some(ref accept_comps) = options.accept_compression {
        for comp in accept_comps {
            let encoding = match comp {
                ConfigCompressionEncoding::Gzip => CompressionEncoding::Gzip,
                ConfigCompressionEncoding::Zstd => CompressionEncoding::Zstd,
            };
            builder = builder.accept_compressed(encoding);
        }
    } else {
        // Default: accept both gzip and zstd like yellowstone-grpc
        builder = builder
            .accept_compressed(CompressionEncoding::Gzip)
            .accept_compressed(CompressionEncoding::Zstd);
    }
    
    let mut builder = builder
        .connect()
        .await
        .map_err(|e| tonic::Status::unavailable(format!("Connection failed: {}", e)))?;

    let (sender, stream) = builder
        .subscribe_with_request(Some(request))
        .await
        .map_err(|e| tonic::Status::internal(format!("Subscription failed: {}", e)))?;

    Ok((sender, stream))
}
