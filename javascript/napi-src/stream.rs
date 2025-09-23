use futures_util::{StreamExt, SinkExt};
use tokio::sync::mpsc;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::bindgen_prelude::*;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;
use yellowstone_grpc_client::{GeyserGrpcClient, ClientTlsConfig};
use yellowstone_grpc_proto::geyser;
use yellowstone_grpc_proto::tonic::codec::CompressionEncoding;
use uuid;
use prost::Message;
use crate::client::ChannelOptions;

// Constants for reconnect logic
const HARD_CAP_RECONNECT_ATTEMPTS: u32 = (20 * 60) / 5; // 20 mins / 5 sec interval = 240 attempts
const FIXED_RECONNECT_INTERVAL_MS: u64 = 5000; // 5 seconds fixed interval
const FORK_DEPTH_SAFETY_MARGIN: u64 = 31; // Max fork depth for processed commitment

pub struct StreamInner {
    cancel_tx: Mutex<Option<oneshot::Sender<()>>>,
    write_tx: Mutex<Option<mpsc::UnboundedSender<geyser::SubscribeRequest>>>,
}

impl StreamInner {
    pub fn new_bytes(
        id: String,
        endpoint: String,
        token: Option<String>,
        mut initial_request: geyser::SubscribeRequest,
        ts_callback: ThreadsafeFunction<crate::SubscribeUpdateBytes, ErrorStrategy::CalleeHandled>,
        max_reconnect_attempts: u32,
        channel_options: Option<ChannelOptions>,
        replay: bool,
    ) -> Result<Self> {
        let (cancel_tx, mut cancel_rx) = oneshot::channel();
        let (write_tx, mut write_rx) = mpsc::unbounded_channel();
        let tracked_slot = Arc::new(AtomicU64::new(0));
        let made_progress = Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Generate unique internal slot subscription ID to avoid conflicts with user subscriptions
        let internal_slot_sub_id = format!("__internal_slot_tracker_{}", uuid::Uuid::new_v4());

        // Add internal slot subscription for tracking only when replay is enabled
        if replay {
            initial_request.slots.insert(internal_slot_sub_id.clone(), geyser::SubscribeRequestFilterSlots {
                filter_by_commitment: Some(true),
                interslot_updates: Some(false),
                ..Default::default()
            });
        }

        // If replay is disabled, ensure any user-provided from_slot is cleared on initial connect
        if !replay {
            initial_request.from_slot = None;
        }

        let id_for_cleanup = id.clone();
        tokio::spawn(async move {
            let mut current_request = initial_request;
            let mut reconnect_attempts = 0u32;
            
            // Determine effective max attempts
            let effective_max_attempts = max_reconnect_attempts.min(HARD_CAP_RECONNECT_ATTEMPTS);
            
            // Extract commitment level for reconnection logic
            let commitment_level = current_request.commitment.unwrap_or(0); // 0 = Processed, 1 = Confirmed, 2 = Finalized

            loop {
                let tracked_slot_clone = tracked_slot.clone();
                let ts_callback_clone = ts_callback.clone();
                let internal_slot_id_clone = internal_slot_sub_id.clone();
                let progress_flag_clone = made_progress.clone();

                // Reset progress flag for this connection attempt
                made_progress.store(false, Ordering::SeqCst);

                tokio::select! {
                    _ = &mut cancel_rx => {
                        break;
                    }

                    result = Self::connect_and_stream_bytes(
                        &endpoint,
                        &token,
                        &current_request,
                        ts_callback_clone,
                        tracked_slot_clone,
                        internal_slot_id_clone,
                        progress_flag_clone,
                        &channel_options,
                        &mut write_rx,
                    ) => {
                        match result {
                            Ok(()) => {
                                reconnect_attempts = 0;
                                // Session ended gracefully, attempts reset
                            }
                            Err(e) => {
                                // Connection error occurred
                                reconnect_attempts += 1; // Always increment first

                                if made_progress.load(Ordering::SeqCst) {
                                    reconnect_attempts = 1; // Reset to 1 since this is the first attempt after progress
                                }

                                // Report every error as it happens
                                let error_msg = format!("Connection error (attempt {}): {}", reconnect_attempts, e);
                                let _ = ts_callback.call(Err(napi::Error::from_reason(error_msg)), ThreadsafeFunctionCallMode::Blocking);

                                // Check if exceeded max reconnect attempts
                            }
                        }

                        if reconnect_attempts >= effective_max_attempts {
                            // Exceeded max reconnect attempts - call error callback one final time
                            let error_msg = format!("Connection failed after {} attempts", effective_max_attempts);
                            let _ = ts_callback.call(Err(napi::Error::from_reason(error_msg)), ThreadsafeFunctionCallMode::Blocking);
                            break;
                        }

                                                // Determine where to resume based on commitment level.
                        let last_tracked_slot = tracked_slot.load(Ordering::SeqCst);

                        // Only use from_slot when replay is enabled
                        if last_tracked_slot > 0 && replay {
                            // Always calculate from_slot based on current tracked_slot and commitment level
                            let from_slot = match commitment_level {
                                // Processed – always rewind by 31 slots for fork safety
                                0 => {
                                    last_tracked_slot.saturating_sub(FORK_DEPTH_SAFETY_MARGIN)
                                }
                                // Confirmed / Finalized – always resume exactly at tracked slot
                                1 | 2 => {
                                    last_tracked_slot
                                }
                                _ => {
                                    last_tracked_slot
                                }
                            };

                            current_request.from_slot = Some(from_slot);
                        } else {
                            current_request.from_slot = None;
                        }

                        // Fixed interval delay between reconnections
                        tokio::time::sleep(Duration::from_millis(FIXED_RECONNECT_INTERVAL_MS)).await;
                    }
                }
            }
            
            // Unregister from global registry when stream ends
            crate::unregister_stream(&id_for_cleanup);
        });

        Ok(Self {
            cancel_tx: Mutex::new(Some(cancel_tx)),
            write_tx: Mutex::new(Some(write_tx)),
        })
    }

    async fn connect_and_stream_bytes(
        endpoint: &str,
        token: &Option<String>,
        request: &geyser::SubscribeRequest,
        ts_callback: ThreadsafeFunction<crate::SubscribeUpdateBytes, ErrorStrategy::CalleeHandled>,
        tracked_slot: Arc<AtomicU64>,
        internal_slot_sub_id: String,
        progress_flag: Arc<std::sync::atomic::AtomicBool>,
        channel_options: &Option<ChannelOptions>,
        write_rx: &mut mpsc::UnboundedReceiver<geyser::SubscribeRequest>,
    ) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
        
        let mut builder = GeyserGrpcClient::build_from_shared(endpoint.to_string())?;
        
        // Apply channel options or use defaults
        if let Some(ref opts) = channel_options {
            // Message size limits
            if let Some(max_send) = opts.grpc_max_send_message_length {
                builder = builder.max_encoding_message_size(max_send as usize);
            } else {
                builder = builder.max_encoding_message_size(32_000_000); // 32MB default
            }
            
            if let Some(max_recv) = opts.grpc_max_receive_message_length {
                builder = builder.max_decoding_message_size(max_recv as usize);
            } else {
                builder = builder.max_decoding_message_size(1_000_000_000); // 1GB default
            }
            
            // Keep-alive options
            if let Some(keepalive_time) = opts.grpc_keepalive_time_ms {
                builder = builder.http2_keep_alive_interval(Duration::from_millis(keepalive_time as u64));
            }
            if let Some(keepalive_timeout) = opts.grpc_keepalive_timeout_ms {
                builder = builder.keep_alive_timeout(Duration::from_millis(keepalive_timeout as u64));
            }
            if let Some(permit_without_calls) = opts.grpc_keepalive_permit_without_calls {
                builder = builder.keep_alive_while_idle(permit_without_calls != 0);
            }
            
            // Process other gRPC options from the catch-all HashMap
            for (key, value) in &opts.other {
                match key.as_str() {
                    // Additional keepalive/timeout options
                    "grpc.http2.max_pings_without_data" => {
                        // Not directly supported by yellowstone-grpc-client
                    }
                    "grpc.http2.min_time_between_pings_ms" => {
                        // Could map to http2_keep_alive_interval if not already set
                        if opts.grpc_keepalive_time_ms.is_none() {
                            if let Some(ms) = value.as_i64() {
                                builder = builder.http2_keep_alive_interval(Duration::from_millis(ms as u64));
                            }
                        }
                    }
                    "grpc.http2.max_ping_strikes" => {
                        // Not directly supported
                    }
                    "grpc.client_idle_timeout_ms" => {
                        if let Some(ms) = value.as_i64() {
                            builder = builder.timeout(Duration::from_millis(ms as u64));
                        }
                    }
                    // HTTP/2 flow control
                    "grpc.http2.write_buffer_size" => {
                        if let Some(size) = value.as_i64() {
                            builder = builder.buffer_size(Some(size as usize));
                        }
                    }
                    "grpc-node.max_session_memory" => {
                        // Could influence buffer sizes
                        if let Some(size) = value.as_i64() {
                            // Use a portion of session memory for initial windows
                            let window_size = (size / 4).min(16 * 1024 * 1024) as u32;
                            builder = builder.initial_stream_window_size(Some(window_size));
                        }
                    }
                    // Connection options
                    "grpc.http2.max_frame_size" => {
                        // Not directly supported, but influences message sizes
                    }
                    "grpc.max_connection_idle_ms" => {
                        // Similar to client_idle_timeout
                        if opts.other.get("grpc.client_idle_timeout_ms").is_none() {
                            if let Some(ms) = value.as_i64() {
                                builder = builder.timeout(Duration::from_millis(ms as u64));
                            }
                        }
                    }
                    _ => {
                        // Ignore unknown options
                    }
                }
            }
            
            // Apply sensible defaults for options not specified
            builder = builder
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .http2_adaptive_window(true)
                .tcp_nodelay(true)
                .initial_stream_window_size(Some(4 * 1024 * 1024))      // 4MB
                .initial_connection_window_size(Some(8 * 1024 * 1024)); // 8MB
            
            // Configure compression if specified
            if let Some(compression_algo) = opts.grpc_default_compression_algorithm {
                match compression_algo {
                    0 => {}, // identity (no compression)
                    2 => {
                        // gzip compression
                        builder = builder
                            .send_compressed(CompressionEncoding::Gzip)
                            .accept_compressed(CompressionEncoding::Gzip);
                    },
                    3 => {
                        // zstd compression  
                        builder = builder
                            .send_compressed(CompressionEncoding::Zstd)
                            .accept_compressed(CompressionEncoding::Zstd);
                    },
                    _ => return Err(format!("Unsupported compression algorithm: {}. Supported: identity (0), gzip (2), zstd (3).", compression_algo).into()),
                }
            }
        } else {
            // Use defaults
            builder = builder
                .connect_timeout(Duration::from_secs(10))
                .max_decoding_message_size(1_000_000_000)
                .timeout(Duration::from_secs(10));
        }
        
        builder = builder.tls_config(ClientTlsConfig::new().with_enabled_roots())?;
        
        if let Some(ref token) = token {
            builder = builder.x_token(Some(token.clone()))?;
        }


        let mut client = builder.connect().await?;
        
        let (mut sender, mut stream) = client.subscribe_with_request(Some(request.clone())).await?;
        
        // Ping interval timer
        let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
        ping_interval.tick().await; // Skip first immediate tick
        let mut ping_id = 0i32;

        loop {
            tokio::select! {
                // Send periodic ping
                _ = ping_interval.tick() => {
                    ping_id = ping_id.wrapping_add(1);
                    let ping_request = geyser::SubscribeRequest {
                        ping: Some(geyser::SubscribeRequestPing { id: ping_id }),
                        ..Default::default()
                    };
                    let _ = sender.send(ping_request).await;
                },
                // Handle incoming messages from the server
                Some(result) = stream.next() => {
                    match result {
                Ok(message) => {
                    
                    // Handle ping/pong mechanism for connection health
                    if let Some(geyser::subscribe_update::UpdateOneof::Ping(_ping)) = &message.update_oneof {
                        // Respond with pong to maintain connection (use static ID since ping doesn't contain one)
                        let pong_request = geyser::SubscribeRequest {
                            ping: Some(geyser::SubscribeRequestPing { id: 1 }),
                            ..Default::default()
                        };
                        // Send pong response (ignore errors as connection issues will be handled by reconnect logic)
                        let _ = sender.send(pong_request).await;
                        // Don't forward ping messages to JavaScript - they're internal connection health
                        continue;
                    }
                        // Do not forward server 'Pong' updates to JavaScript either
                        if let Some(geyser::subscribe_update::UpdateOneof::Pong(_pong)) = &message.update_oneof {
                            continue;
                        }
                    
                    // Track slot updates for reconnection (only decode when necessary)
                    if let Some(geyser::subscribe_update::UpdateOneof::Slot(slot)) = &message.update_oneof {
                        tracked_slot.store(slot.slot, Ordering::SeqCst);
                        
                        // Check if this slot update is EXCLUSIVELY from our internal subscription
                        // Only skip if the message contains ONLY the internal filter ID (not mixed with user subscriptions)
                        if message.filters.len() == 1 && message.filters.contains(&internal_slot_sub_id) {
                            continue; // Skip forwarding this message
                        }
                    }
                    
                    // Clean up internal filter ID from ALL message types
                    let mut clean_message = message;
                    clean_message.filters.retain(|filter_id| filter_id != &internal_slot_sub_id);
                    
                    // Serialize the protobuf message to bytes
                    let mut buf = Vec::new();
                    if let Err(_e) = clean_message.encode(&mut buf) {
                        // Failed to encode protobuf message, skip this message
                        continue;
                    }
                    
                    let bytes_wrapper = crate::SubscribeUpdateBytes(buf);
                    
                    // mark that at least one message was forwarded in this session
                    progress_flag.store(true, Ordering::SeqCst);
                    
                    // Use Blocking mode to prevent message drops and handle errors
                    let status = ts_callback.call(Ok(bytes_wrapper), ThreadsafeFunctionCallMode::Blocking);
                    if status != napi::Status::Ok {
                        // Failed to deliver bytes to JavaScript, continue processing
                        // Continue processing other messages instead of breaking the stream
                    }
                }
                        Err(e) => {
                            return Err(Box::new(e));
                        }
                    }
                },
                
                // Handle write requests from the JavaScript client
                Some(write_request) = write_rx.recv() => {
                    if let Err(e) = sender.send(write_request).await {
                        return Err(Box::new(e));
                    }
                },
                
                // If both streams are closed, exit
                else => {
                    break;
                },
            }
        }
        
        Ok(())
    }

    pub fn cancel(&self) -> Result<()> {
        if let Some(tx) = self.cancel_tx.lock().take() {
            let _ = tx.send(());
        }
        Ok(())
    }
    
    pub fn write(&self, request: geyser::SubscribeRequest) -> Result<()> {
        let tx_guard = self.write_tx.lock();
        if let Some(ref tx) = *tx_guard {
            tx.send(request)
                .map_err(|_| napi::Error::from_reason("Failed to send write request: channel closed"))?;
        } else {
            return Err(napi::Error::from_reason("Stream is not active"));
        }
        Ok(())
    }
}
