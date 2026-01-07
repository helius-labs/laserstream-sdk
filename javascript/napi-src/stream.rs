use futures_util::{StreamExt, SinkExt};
use tokio::sync::mpsc;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::bindgen_prelude::*;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;
use laserstream_core_client::{ClientTlsConfig, Interceptor};
use laserstream_core_proto::prelude::{geyser_client::GeyserClient};
use laserstream_core_proto::geyser;
use laserstream_core_proto::tonic::{codec::CompressionEncoding, transport::Endpoint, Request, Status, metadata::MetadataValue};
use uuid;
use prost::Message;
use crate::client::ChannelOptions;

// Constants for reconnect logic
const HARD_CAP_RECONNECT_ATTEMPTS: u32 = (20 * 60) / 5; // 20 mins / 5 sec interval = 240 attempts
const FIXED_RECONNECT_INTERVAL_MS: u64 = 5000; // 5 seconds fixed interval
const FORK_DEPTH_SAFETY_MARGIN: u64 = 31; // Max fork depth for processed commitment

// SDK metadata constants
const SDK_NAME: &str = "laserstream-javascript";
const SDK_VERSION: &str = "0.2.9";

/// Custom interceptor that adds SDK metadata headers to all gRPC requests
#[derive(Clone)]
struct SdkMetadataInterceptor {
    x_token: Option<laserstream_core_proto::tonic::metadata::AsciiMetadataValue>,
}

impl SdkMetadataInterceptor {
    fn new(token: &Option<String>) -> std::result::Result<Self, Status> {
        let x_token = if let Some(token_str) = token {
            if !token_str.is_empty() {
                Some(token_str.parse().map_err(|e| {
                    Status::invalid_argument(format!("Invalid API key: {}", e))
                })?)
            } else {
                None
            }
        } else {
            None
        };
        Ok(Self { x_token })
    }
}

impl Interceptor for SdkMetadataInterceptor {
    fn call(&mut self, mut request: Request<()>) -> std::result::Result<Request<()>, Status> {
        // Add x-token if present
        if let Some(ref x_token) = self.x_token {
            request.metadata_mut().insert("x-token", x_token.clone());
        }

        // Add SDK metadata headers
        request.metadata_mut().insert("x-sdk-name", MetadataValue::from_static(SDK_NAME));
        request.metadata_mut().insert("x-sdk-version", MetadataValue::from_static(SDK_VERSION));

        Ok(request)
    }
}

// Helper struct to hold channel configuration
struct ChannelConfig {
    max_send_msg_size: usize,
    max_recv_msg_size: usize,
    send_compression: Option<CompressionEncoding>,
    accept_compression: Option<CompressionEncoding>,
}

impl ChannelConfig {
    fn from_options(channel_options: &Option<ChannelOptions>) -> Self {
        if let Some(ref opts) = channel_options {
            let send_compression = opts.grpc_default_compression_algorithm.and_then(|algo| match algo {
                2 => Some(CompressionEncoding::Gzip),
                3 => Some(CompressionEncoding::Zstd),
                _ => None,
            });

            Self {
                max_send_msg_size: opts.grpc_max_send_message_length.map(|v| v as usize).unwrap_or(32_000_000),
                max_recv_msg_size: opts.grpc_max_receive_message_length.map(|v| v as usize).unwrap_or(1_000_000_000),
                send_compression,
                accept_compression: send_compression,
            }
        } else {
            Self {
                max_send_msg_size: 32_000_000,
                max_recv_msg_size: 1_000_000_000,
                send_compression: None,
                accept_compression: None,
            }
        }
    }
}

// Helper function to configure endpoint with channel options
fn configure_endpoint(
    endpoint_str: &str,
    channel_options: &Option<ChannelOptions>,
) -> std::result::Result<Endpoint, Box<dyn std::error::Error + Send + Sync>> {
    let mut endpoint = Endpoint::from_shared(endpoint_str.to_string())?;

    if let Some(ref opts) = channel_options {
        // Keep-alive options
        if let Some(keepalive_time) = opts.grpc_keepalive_time_ms {
            endpoint = endpoint.http2_keep_alive_interval(Duration::from_millis(keepalive_time as u64));
        }
        if let Some(keepalive_timeout) = opts.grpc_keepalive_timeout_ms {
            endpoint = endpoint.keep_alive_timeout(Duration::from_millis(keepalive_timeout as u64));
        }
        if let Some(permit_without_calls) = opts.grpc_keepalive_permit_without_calls {
            endpoint = endpoint.keep_alive_while_idle(permit_without_calls != 0);
        }

        // Process other gRPC options from the catch-all HashMap
        for (key, value) in &opts.other {
            match key.as_str() {
                "grpc.http2.min_time_between_pings_ms" => {
                    if opts.grpc_keepalive_time_ms.is_none() {
                        if let Some(ms) = value.as_i64() {
                            endpoint = endpoint.http2_keep_alive_interval(Duration::from_millis(ms as u64));
                        }
                    }
                }
                "grpc.client_idle_timeout_ms" => {
                    if let Some(ms) = value.as_i64() {
                        endpoint = endpoint.timeout(Duration::from_millis(ms as u64));
                    }
                }
                "grpc.http2.write_buffer_size" => {
                    if let Some(size) = value.as_i64() {
                        endpoint = endpoint.buffer_size(Some(size as usize));
                    }
                }
                "grpc-node.max_session_memory" => {
                    if let Some(size) = value.as_i64() {
                        let window_size = (size / 4).min(16 * 1024 * 1024) as u32;
                        endpoint = endpoint.initial_stream_window_size(Some(window_size));
                    }
                }
                "grpc.max_connection_idle_ms" => {
                    if opts.other.get("grpc.client_idle_timeout_ms").is_none() {
                        if let Some(ms) = value.as_i64() {
                            endpoint = endpoint.timeout(Duration::from_millis(ms as u64));
                        }
                    }
                }
                _ => {}
            }
        }

        // Apply sensible defaults for options not specified
        endpoint = endpoint
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .http2_adaptive_window(true)
            .tcp_nodelay(true)
            .initial_stream_window_size(Some(4 * 1024 * 1024))
            .initial_connection_window_size(Some(8 * 1024 * 1024));
    } else {
        // Use defaults
        endpoint = endpoint
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(10));
    }

    // Configure TLS
    endpoint = endpoint.tls_config(ClientTlsConfig::new().with_enabled_roots())?;

    Ok(endpoint)
}

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

        // Wrap current_request in Arc<Mutex> so it can be updated from write() calls
        let current_request = Arc::new(parking_lot::Mutex::new(initial_request));

        tokio::spawn(async move {
            let mut reconnect_attempts = 0u32;

            // Determine effective max attempts
            let effective_max_attempts = max_reconnect_attempts.min(HARD_CAP_RECONNECT_ATTEMPTS);

            // Extract commitment level for reconnection logic
            let commitment_level = current_request.lock().commitment.unwrap_or(0); // 0 = Processed, 1 = Confirmed, 2 = Finalized

            loop {
                let tracked_slot_clone = tracked_slot.clone();
                let ts_callback_clone = ts_callback.clone();
                let internal_slot_id_clone = internal_slot_sub_id.clone();
                let progress_flag_clone = made_progress.clone();

                // Reset progress flag for this connection attempt
                made_progress.store(false, Ordering::SeqCst);

                // Clone the current request for this connection attempt
                let request_snapshot = current_request.lock().clone();

                tokio::select! {
                    _ = &mut cancel_rx => {
                        break;
                    }

                    result = Self::connect_and_stream_bytes(
                        &endpoint,
                        &token,
                        &request_snapshot,
                        ts_callback_clone,
                        tracked_slot_clone,
                        internal_slot_id_clone,
                        progress_flag_clone,
                        &channel_options,
                        &mut write_rx,
                        current_request.clone(),
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

                                // Log error internally but don't yield to consumer until max attempts exhausted
                                eprintln!("RECONNECT: Connection failed (attempt {}/{}): {}", reconnect_attempts, effective_max_attempts, e);

                                // Check if exceeded max reconnect attempts
                                if reconnect_attempts >= effective_max_attempts {
                                    // Only report error to consumer after exhausting all retries
                                    let error_msg = format!("Connection failed after {} attempts: {}", effective_max_attempts, e);
                                    let _ = ts_callback.call(Err(napi::Error::from_reason(error_msg)), ThreadsafeFunctionCallMode::Blocking);
                                    break;
                                }
                            }
                        }

                        // Determine where to resume based on commitment level.
                        let last_tracked_slot = tracked_slot.load(Ordering::SeqCst);
                        eprintln!("RECONNECT: tracked_slot={}", last_tracked_slot);

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

                            current_request.lock().from_slot = Some(from_slot);
                        } else {
                            current_request.lock().from_slot = None;
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
        current_request: Arc<parking_lot::Mutex<geyser::SubscribeRequest>>,
    ) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Create our custom interceptor with SDK metadata
        let interceptor = SdkMetadataInterceptor::new(token)?;

        // Configure endpoint using helper function
        let endpoint_configured = configure_endpoint(endpoint, channel_options)?;
        let channel_config = ChannelConfig::from_options(channel_options);

        // Connect to create channel
        let channel = endpoint_configured.connect().await?;

        // Create geyser client with our custom interceptor and channel config
        let mut geyser_client = GeyserClient::with_interceptor(channel, interceptor)
            .max_decoding_message_size(channel_config.max_recv_msg_size)
            .max_encoding_message_size(channel_config.max_send_msg_size);

        // Configure compression if specified
        if let Some(encoding) = channel_config.send_compression {
            geyser_client = geyser_client.send_compressed(encoding);
        }
        if let Some(encoding) = channel_config.accept_compression {
            geyser_client = geyser_client.accept_compressed(encoding);
        }

        // Create bidirectional stream
        let (mut sender, mut stream) = {
            use futures_channel::mpsc as futures_mpsc;
            let (mut subscribe_tx, subscribe_rx) = futures_mpsc::unbounded();
            subscribe_tx.send(request.clone()).await?;
            let response = geyser_client.subscribe(subscribe_rx).await?;
            (subscribe_tx, response.into_inner())
        };
        
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

                        // If we reach here, user ALSO has a slot subscription
                        // Remove internal filter ID so it doesn't leak to user
                        // OPTIMIZATION: Only clean filters for slot messages (not all messages)
                        let mut clean_message = message;
                        if let Some(pos) = clean_message.filters.iter().position(|id| id == &internal_slot_sub_id) {
                            clean_message.filters.swap_remove(pos);
                        }

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
                        continue; // Skip to next message
                    }

                    // For all non-slot messages, forward as-is (no filter cleanup needed)
                    // Internal slot ID will never appear in account/transaction/block messages
                    let mut buf = Vec::new();
                    if let Err(_e) = message.encode(&mut buf) {
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
                    // IMPORTANT: Merge the write_request into current_request so it persists across reconnections
                    {
                        let mut req = current_request.lock();
                        Self::merge_subscribe_requests(&mut req, &write_request);
                    }

                    // Send the modification to the active stream
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

    pub fn new_preprocessed_bytes(
        id: String,
        endpoint: String,
        token: Option<String>,
        initial_request: geyser::SubscribePreprocessedRequest,
        ts_callback: ThreadsafeFunction<crate::SubscribePreprocessedUpdateBytes, ErrorStrategy::CalleeHandled>,
        max_reconnect_attempts: u32,
        channel_options: Option<ChannelOptions>,
    ) -> Result<Self> {
        let (cancel_tx, mut cancel_rx) = oneshot::channel();
        // Preprocessed subscriptions don't support write(), so we don't create the channel

        let id_for_cleanup = id.clone();

        tokio::spawn(async move {
            let mut reconnect_attempts = 0u32;
            let effective_max_attempts = max_reconnect_attempts.min(HARD_CAP_RECONNECT_ATTEMPTS);

            loop {
                let ts_callback_clone = ts_callback.clone();

                tokio::select! {
                    _ = &mut cancel_rx => {
                        break;
                    }

                    result = Self::connect_and_stream_preprocessed_bytes(
                        &endpoint,
                        &token,
                        &initial_request,
                        ts_callback_clone,
                        &channel_options,
                    ) => {
                        match result {
                            Ok(()) => {
                                reconnect_attempts = 0;
                            }
                            Err(e) => {
                                reconnect_attempts += 1;
                                eprintln!("RECONNECT: Preprocessed connection failed (attempt {}/{}): {}", reconnect_attempts, effective_max_attempts, e);

                                if reconnect_attempts >= effective_max_attempts {
                                    let error_msg = format!("Preprocessed connection failed after {} attempts: {}", effective_max_attempts, e);
                                    let _ = ts_callback.call(Err(napi::Error::from_reason(error_msg)), ThreadsafeFunctionCallMode::Blocking);
                                    break;
                                }
                            }
                        }

                        tokio::time::sleep(Duration::from_millis(FIXED_RECONNECT_INTERVAL_MS)).await;
                    }
                }
            }

            crate::unregister_stream(&id_for_cleanup);
        });

        Ok(Self {
            cancel_tx: Mutex::new(Some(cancel_tx)),
            write_tx: Mutex::new(None), // None indicates write() is not supported for preprocessed
        })
    }

    async fn connect_and_stream_preprocessed_bytes(
        endpoint: &str,
        token: &Option<String>,
        request: &geyser::SubscribePreprocessedRequest,
        ts_callback: ThreadsafeFunction<crate::SubscribePreprocessedUpdateBytes, ErrorStrategy::CalleeHandled>,
        channel_options: &Option<ChannelOptions>,
    ) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Create our custom interceptor with SDK metadata
        let interceptor = SdkMetadataInterceptor::new(token)?;

        // Configure endpoint using helper function
        let endpoint_configured = configure_endpoint(endpoint, channel_options)?;
        let channel_config = ChannelConfig::from_options(channel_options);

        // Connect to create channel
        let channel = endpoint_configured.connect().await?;

        // Create geyser client with our custom interceptor and channel config
        let mut geyser_client = GeyserClient::with_interceptor(channel, interceptor)
            .max_decoding_message_size(channel_config.max_recv_msg_size)
            .max_encoding_message_size(channel_config.max_send_msg_size);

        // Configure compression if specified
        if let Some(encoding) = channel_config.send_compression {
            geyser_client = geyser_client.send_compressed(encoding);
        }
        if let Some(encoding) = channel_config.accept_compression {
            geyser_client = geyser_client.accept_compressed(encoding);
        }

        // Create bidirectional stream for preprocessed
        let (mut sender, mut stream) = {
            use futures_channel::mpsc as futures_mpsc;
            let (mut subscribe_tx, subscribe_rx) = futures_mpsc::unbounded();
            subscribe_tx.send(request.clone()).await?;
            let response = geyser_client.subscribe_preprocessed(subscribe_rx).await?;
            (subscribe_tx, response.into_inner())
        };

        let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
        ping_interval.tick().await;
        let mut ping_id = 0i32;

        loop {
            tokio::select! {
                _ = ping_interval.tick() => {
                    ping_id = ping_id.wrapping_add(1);
                    let ping_request = geyser::SubscribePreprocessedRequest {
                        ping: Some(geyser::SubscribeRequestPing { id: ping_id }),
                        ..Default::default()
                    };
                    let _ = sender.send(ping_request).await;
                },
                Some(result) = stream.next() => {
                    match result {
                        Ok(message) => {
                            // Handle ping/pong
                            if let Some(geyser::subscribe_preprocessed_update::UpdateOneof::Ping(_)) = &message.update_oneof {
                                let pong_request = geyser::SubscribePreprocessedRequest {
                                    ping: Some(geyser::SubscribeRequestPing { id: 1 }),
                                    ..Default::default()
                                };
                                let _ = sender.send(pong_request).await;
                                continue;
                            }
                            if let Some(geyser::subscribe_preprocessed_update::UpdateOneof::Pong(_)) = &message.update_oneof {
                                continue;
                            }

                            // Convert to bytes and send to JavaScript
                            match crate::subscribe_preprocessed_update_to_bytes(message) {
                                Ok(bytes) => {
                                    let _ = ts_callback.call(Ok(crate::SubscribePreprocessedUpdateBytes(bytes)), ThreadsafeFunctionCallMode::NonBlocking);
                                }
                                Err(e) => {
                                    eprintln!("Failed to encode preprocessed update: {}", e);
                                }
                            }
                        }
                        Err(status) => {
                            return Err(Box::new(std::io::Error::new(std::io::ErrorKind::Other, status.to_string())));
                        }
                    }
                }
                else => {
                    break;
                }
            }
        }

        Ok(())
    }

    /// Replaces the current subscription request with a new one.
    /// This ensures modifications made via write() are preserved across reconnections.
    fn merge_subscribe_requests(
        current: &mut geyser::SubscribeRequest,
        modification: &geyser::SubscribeRequest,
    ) {
        // Save the internal slot tracker before replacing slots
        let internal_tracker = current.slots.iter()
            .find(|(k, _)| k.starts_with("__internal_slot_tracker_"))
            .map(|(k, v)| (k.clone(), v.clone()));

        // Replace all subscription types (Yellowstone gRPC replaces, not merges)
        current.accounts = modification.accounts.clone();
        current.slots = modification.slots.clone();
        current.transactions = modification.transactions.clone();
        current.transactions_status = modification.transactions_status.clone();
        current.blocks = modification.blocks.clone();
        current.blocks_meta = modification.blocks_meta.clone();
        current.entry = modification.entry.clone();
        current.accounts_data_slice = modification.accounts_data_slice.clone();

        // Restore the internal slot tracker if it existed
        if let Some((key, value)) = internal_tracker {
            current.slots.insert(key, value);
        }

        // Update commitment if specified
        if modification.commitment.is_some() {
            current.commitment = modification.commitment;
        }

        // Note: from_slot and ping are not replaced as they are connection-specific
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
            return Err(napi::Error::from_reason("write() is not supported for preprocessed subscriptions. Use subscribe() instead of subscribePreprocessed() if you need dynamic subscription updates."));
        }
        Ok(())
    }
}
