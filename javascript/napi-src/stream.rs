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
    ) -> Result<Self> {
        let (cancel_tx, mut cancel_rx) = oneshot::channel();
        let (write_tx, mut write_rx) = mpsc::unbounded_channel();
        let tracked_slot = Arc::new(AtomicU64::new(0));
        let made_progress = Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Generate unique internal slot subscription ID to avoid conflicts with user subscriptions
        let internal_slot_sub_id = format!("__internal_slot_tracker_{}", uuid::Uuid::new_v4());
        
        // Add internal slot subscription for tracking (will be filtered out)
        initial_request.slots.insert(internal_slot_sub_id.clone(), geyser::SubscribeRequestFilterSlots {
            filter_by_commitment: Some(true),
            interslot_updates: Some(false),
            ..Default::default()
        });

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

                        if last_tracked_slot > 0 {
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
            builder = builder
                .connect_timeout(Duration::from_secs(opts.connect_timeout_secs.unwrap_or(10)))
                .timeout(Duration::from_secs(opts.timeout_secs.unwrap_or(30)))
                .max_decoding_message_size(opts.max_decoding_message_size.unwrap_or(1_000_000_000))
                .max_encoding_message_size(opts.max_encoding_message_size.unwrap_or(32_000_000));
            
            if let Some(interval) = opts.http2_keep_alive_interval_secs {
                builder = builder.http2_keep_alive_interval(Duration::from_secs(interval));
            }
            if let Some(timeout) = opts.keep_alive_timeout_secs {
                builder = builder.keep_alive_timeout(Duration::from_secs(timeout));
            }
            if let Some(idle) = opts.keep_alive_while_idle {
                builder = builder.keep_alive_while_idle(idle);
            }
            if let Some(size) = opts.initial_stream_window_size {
                builder = builder.initial_stream_window_size(Some(size));
            }
            if let Some(size) = opts.initial_connection_window_size {
                builder = builder.initial_connection_window_size(Some(size));
            }
            if let Some(adaptive) = opts.http2_adaptive_window {
                builder = builder.http2_adaptive_window(adaptive);
            }
            if let Some(nodelay) = opts.tcp_nodelay {
                builder = builder.tcp_nodelay(nodelay);
            }
            if let Some(keepalive) = opts.tcp_keepalive_secs {
                builder = builder.tcp_keepalive(Some(Duration::from_secs(keepalive)));
            }
            if let Some(size) = opts.buffer_size {
                builder = builder.buffer_size(Some(size));
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
        
        loop {
            tokio::select! {
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
                else => break,
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
