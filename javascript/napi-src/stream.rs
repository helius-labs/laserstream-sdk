use futures_util::StreamExt;
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

// Constants for reconnect logic
const HARD_CAP_RECONNECT_ATTEMPTS: u32 = (20 * 60) / 5; // 20 mins / 5 sec interval = 240 attempts
const FIXED_RECONNECT_INTERVAL_MS: u64 = 5000; // 5 seconds fixed interval
const FORK_DEPTH_SAFETY_MARGIN: u64 = 31; // Max fork depth for processed commitment

pub struct StreamInner {
    cancel_tx: Mutex<Option<oneshot::Sender<()>>>,
}

impl StreamInner {
    pub fn new_bytes(
        id: String,
        endpoint: String,
        token: Option<String>,
        mut initial_request: geyser::SubscribeRequest,
        ts_callback: ThreadsafeFunction<crate::SubscribeUpdateBytes, ErrorStrategy::CalleeHandled>,
        max_reconnect_attempts: u32,
    ) -> Result<Self> {
        let (cancel_tx, mut cancel_rx) = oneshot::channel();
        let tracked_slot = Arc::new(AtomicU64::new(0));
        let id_clone = id.clone();
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
            let mut processed_offset_applied = false;
            
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
                    ) => {
                        match result {
                            Ok(()) => {
                                reconnect_attempts = 0;
                                eprintln!("[Stream {}] Session ended gracefully, attempts reset", id_clone);
                            }
                            Err(e) => {
                                eprintln!("[Stream {}] Connection error: {}", id_clone, e);

                                reconnect_attempts += 1; // Always increment first

                                if made_progress.load(Ordering::SeqCst) {
                                    reconnect_attempts = 1; // Reset to 1 since this is the first attempt after progress
                                }

                                eprintln!("[Stream {}] Reconnect attempt #{}/{}", id_clone, reconnect_attempts, effective_max_attempts);
                            }
                        }

                        if reconnect_attempts >= effective_max_attempts {
                            eprintln!("[Stream {}] Exceeded max reconnect attempts ({})", id_clone, effective_max_attempts);
                            break;
                        }

                        // Determine where to resume based on commitment level.
                        let last_tracked_slot = tracked_slot.load(Ordering::SeqCst);

                        if last_tracked_slot > 0 {
                            let from_slot = match commitment_level {
                                // Processed – apply one-time 31-slot rewind for fork safety
                                0 => {
                                    if !processed_offset_applied {
                                        processed_offset_applied = true;
                                        last_tracked_slot.saturating_sub(FORK_DEPTH_SAFETY_MARGIN)
                                    } else {
                                        last_tracked_slot // subsequent reconnects: no extra offset
                                    }
                                }
                                // Confirmed / Finalized – always resume exactly at tracked slot
                                1 | 2 => last_tracked_slot,
                                _ => last_tracked_slot,
                            };

                            current_request.from_slot = Some(from_slot);
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
    ) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
        
        let mut builder = GeyserGrpcClient::build_from_shared(endpoint.to_string())?
            .connect_timeout(Duration::from_secs(10))
            .max_decoding_message_size(1_000_000_000)
            .timeout(Duration::from_secs(10))
            .tls_config(ClientTlsConfig::new().with_enabled_roots())?;

        if let Some(ref token) = token {
            builder = builder.x_token(Some(token.clone()))?;
        }

        let mut client = builder.connect().await?;
        

        
        let (_sender, mut stream) = client.subscribe_with_request(Some(request.clone())).await?;
        
        while let Some(result) = stream.next().await {
            match result {
                Ok(message) => {
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
                    if let Err(e) = clean_message.encode(&mut buf) {
                        eprintln!("[Stream] Failed to encode protobuf message: {}", e);
                        continue;
                    }
                    

                    
                    let bytes_wrapper = crate::SubscribeUpdateBytes(buf);
                    
                    // mark that at least one message was forwarded in this session
                    progress_flag.store(true, Ordering::SeqCst);
                    
                    // Use Blocking mode to prevent message drops and handle errors
                    let status = ts_callback.call(Ok(bytes_wrapper), ThreadsafeFunctionCallMode::Blocking);
                    if status != napi::Status::Ok {
                        eprintln!("[Stream] Failed to deliver bytes to JavaScript: {:?}", status);
                        // Continue processing other messages instead of breaking the stream
                    }
                }
                Err(e) => {
                    return Err(Box::new(e));
                }
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
}
