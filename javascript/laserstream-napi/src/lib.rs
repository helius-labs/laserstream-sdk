// Remove unused macro import

mod buffer_pool;
mod client;
mod metrics;
mod proto;
mod stream;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Env, JsObject};
use napi_derive::napi;
use std::sync::Arc;

// Re-export the generated protobuf types
pub use proto::*;

// Simple test function for basic verification
#[napi]
pub fn hello_world() -> String {
    "Hello from LaserStream NAPI + Tonic!".to_string()
}

// Main client struct that wraps the real implementation
#[napi]
pub struct LaserStreamClient {
    inner: Arc<client::ClientInner>,
}

#[napi]
impl LaserStreamClient {
    #[napi(constructor)]
    pub fn new(endpoint: String, token: Option<String>) -> Result<Self> {
        let inner = Arc::new(client::ClientInner::new(endpoint, token)?);
        Ok(Self { inner })
    }

    #[napi(ts_return_type = "Promise<StreamHandle>")]
    pub fn subscribe(&self, env: Env, request: Object, callback: JsFunction) -> Result<JsObject> {
        // Extract all needed data from JS objects synchronously
        let subscribe_request = self.inner.js_to_subscribe_request(request)?;

        // Create threadsafe function immediately (while we have access to JS context)
        let ts_callback: ThreadsafeFunction<Vec<u8>, ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let buffer = ctx.env.create_buffer_with_data(ctx.value)?;
                Ok(vec![buffer.into_unknown()])
            })?;

        let client_inner = self.inner.clone();

        // Create async task
        env.spawn_future(async move {
            client_inner
                .subscribe_internal_with_tsfn(subscribe_request, ts_callback)
                .await
        })
    }

    #[napi(getter)]
    pub fn metrics(&self) -> GlobalMetrics {
        self.inner.get_metrics()
    }
}

// Stream handle for managing individual streams
#[napi]
pub struct StreamHandle {
    id: String,
    inner: Arc<stream::StreamInner>,
}

#[napi]
impl StreamHandle {
    #[napi(getter)]
    pub fn id(&self) -> String {
        self.id.clone()
    }

    #[napi]
    pub fn cancel(&self) -> Result<()> {
        self.inner.cancel()
    }

    #[napi(getter)]
    pub fn metrics(&self) -> StreamMetrics {
        self.inner.get_metrics()
    }
}

// Metrics types with NAPI attributes
#[napi(object)]
#[derive(Clone)]
pub struct StreamMetrics {
    pub messages_per_sec: f64,
    pub bytes_per_sec: f64,
    pub total_messages: f64,
    pub total_bytes: f64,
    pub avg_latency_ms: f64,
}

#[napi(object)]
#[derive(Clone)]
pub struct GlobalMetrics {
    pub active_streams: u32,
    pub total_messages_per_sec: f64,
    pub total_bytes_per_sec: f64,
    pub total_messages: f64,
    pub total_bytes: f64,
}
