mod client;
mod proto;
mod stream;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Env, JsFunction, JsObject, NapiRaw, NapiValue};
use napi_derive::napi;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use parking_lot::Mutex;
use std::sync::LazyLock;
use yellowstone_grpc_proto;
use yellowstone_grpc_proto::geyser::SubscribeUpdate as YellowstoneSubscribeUpdate;
use prost::Message;

// Re-export the generated protobuf types
pub use proto::*;

// Global stream registry for lifecycle management
static STREAM_REGISTRY: LazyLock<Mutex<HashMap<String, Arc<stream::StreamInner>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SIGNAL_HANDLERS_REGISTERED: AtomicBool = AtomicBool::new(false);
static ACTIVE_STREAM_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

// Simple wrapper that contains the protobuf bytes
pub struct SubscribeUpdateBytes(pub Vec<u8>);

impl ToNapiValue for SubscribeUpdateBytes {
    unsafe fn to_napi_value(env: napi::sys::napi_env, val: Self) -> napi::Result<napi::sys::napi_value> {
        // Create a Uint8Array from the protobuf bytes (zero-copy)
        let env = unsafe { napi::Env::from_raw(env) };
        let buffer = env.create_buffer_with_data(val.0)?;
        unsafe { Ok(buffer.into_unknown().raw()) }
    }
}

// Internal function to register a stream in the global registry
pub fn register_stream(id: String, stream: Arc<stream::StreamInner>) {
    let mut registry = STREAM_REGISTRY.lock();
    registry.insert(id, stream);
    ACTIVE_STREAM_COUNT.fetch_add(1, Ordering::SeqCst);
}

// Internal function to unregister a stream from the global registry
pub fn unregister_stream(id: &str) {
    let mut registry = STREAM_REGISTRY.lock();
    if registry.remove(id).is_some() {
        ACTIVE_STREAM_COUNT.fetch_sub(1, Ordering::SeqCst);
    }
}

// Internal function to setup signal handlers and keep-alive
fn setup_global_lifecycle_management(_env: &Env) -> Result<()> {
    // Only register signal handlers once
    if SIGNAL_HANDLERS_REGISTERED.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        // In a production implementation, you would register proper signal handlers here
        // For now, we rely on the tokio runtime and stream references to keep the process alive
    }
    
    Ok(())
}

// Graceful shutdown function
#[napi]
pub fn shutdown_all_streams(_env: Env) -> Result<()> {
    let mut registry = STREAM_REGISTRY.lock();
    
    for (_id, stream) in registry.iter() {
        let _ = stream.cancel();
    }
    
    registry.clear();
    ACTIVE_STREAM_COUNT.store(0, Ordering::SeqCst);
    
    Ok(())
}

// Get active stream count
#[napi]
pub fn get_active_stream_count() -> u32 {
    ACTIVE_STREAM_COUNT.load(Ordering::SeqCst)
}

// Convert SubscribeUpdate to bytes for zero-copy transfer to JS
pub fn subscribe_update_to_bytes(update: YellowstoneSubscribeUpdate) -> Result<Vec<u8>> {
    // Serialize the protobuf message back to bytes
    let mut buf = Vec::new();
    update.encode(&mut buf).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Failed to encode protobuf: {}", e))
    })?;
    Ok(buf)
}

// Commitment levels enum (keeping for API compatibility)
#[napi]
pub enum CommitmentLevel {
    PROCESSED = 0,
    CONFIRMED = 1,
    FINALIZED = 2,
}

// Main client struct
#[napi]
pub struct LaserstreamClient {
    inner: Arc<client::ClientInner>,
}

#[napi]
impl LaserstreamClient {
    #[napi(constructor)]
    pub fn new(
        env: Env,
        endpoint: String,
        token: Option<String>,
        max_reconnect_attempts: Option<u32>,
        channel_options: Option<Object>,
        replay: Option<bool>,
    ) -> Result<Self> {
        let parsed_channel_options = if let Some(opts_obj) = channel_options {
            let opts: client::ChannelOptions = env.from_js_value(opts_obj)?;
            Some(opts)
        } else {
            None
        };
        
        let inner = Arc::new(client::ClientInner::new(
            endpoint,
            token,
            max_reconnect_attempts,
            parsed_channel_options,
            replay,
        )?);
        Ok(Self { inner })
    }

    #[napi(
        ts_args_type = "request: any, callback: (error: Error | null, updateBytes: Uint8Array) => void",
        ts_return_type = "Promise<StreamHandle>"
    )]
    pub fn subscribe(&self, env: Env, request: Object, callback: JsFunction) -> Result<JsObject> {
        // Setup global lifecycle management on first use
        setup_global_lifecycle_management(&env)?;
        
        let subscribe_request = self.inner.js_to_subscribe_request(&env, request)?;

        // Threadsafe function that forwards protobuf bytes to JS
        let ts_callback: ThreadsafeFunction<SubscribeUpdateBytes, ErrorStrategy::CalleeHandled> =
            callback.create_threadsafe_function(0, |ctx| {
                let bytes_wrapper: SubscribeUpdateBytes = ctx.value;
                let js_uint8array = unsafe { SubscribeUpdateBytes::to_napi_value(ctx.env.raw(), bytes_wrapper)? };
                Ok(vec![unsafe { napi::JsUnknown::from_raw(ctx.env.raw(), js_uint8array)? }])
            })?;

        let client_inner = self.inner.clone();

        env.spawn_future(async move {
            client_inner
                .subscribe_internal_bytes(subscribe_request, ts_callback)
                .await
        })
    }
}

// Stream handle
#[napi]
pub struct StreamHandle {
    pub id: String,
    inner: Arc<stream::StreamInner>,
}

#[napi]
impl StreamHandle {
    #[napi]
    pub fn cancel(&self) -> Result<()> {
        // Unregister from global registry first
        unregister_stream(&self.id);
        
        // Then cancel the actual stream
        self.inner.cancel()
    }
    
    #[napi(ts_args_type = "request: any")]
    pub fn write(&self, env: Env, request: Object) -> Result<()> {
        // Parse the JavaScript request object into a protobuf SubscribeRequest
        let client_inner = client::ClientInner::new(
            String::new(), // dummy values, we only need the parsing functionality
            None,
            None,
            None,
            None,
        )?;
        let subscribe_request = client_inner.js_to_subscribe_request(&env, request)?;
        
        // Send the request through the write channel
        self.inner.write(subscribe_request)
    }
}

