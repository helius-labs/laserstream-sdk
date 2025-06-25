mod client;
mod proto;
mod stream;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Env, JsFunction, JsObject};
use napi_derive::napi;
use std::sync::Arc;

// Re-export the generated protobuf types
pub use proto::*;

// Commitment levels enum
#[napi]
pub enum CommitmentLevel {
    Processed = 0,
    Confirmed = 1,
    Finalized = 2,
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
        endpoint: String,
        token: Option<String>,
        max_reconnect_attempts: Option<u32>,
    ) -> Result<Self> {
        let inner = Arc::new(client::ClientInner::new(
            endpoint,
            token,
            max_reconnect_attempts,
        )?);
        Ok(Self { inner })
    }

    #[napi(
        ts_args_type = "request: any, callback: (error: Error | null, buffer: Buffer) => void",
        ts_return_type = "Promise<StreamHandle>"
    )]
    pub fn subscribe(&self, env: Env, request: Object, callback: JsFunction) -> Result<JsObject> {
        let subscribe_request = self.inner.js_to_subscribe_request(&env, request)?;

        // Create threadsafe function with proper buffer handling following napi-rs docs
        let ts_callback: ThreadsafeFunction<Vec<u8>, ErrorStrategy::CalleeHandled> =
            callback.create_threadsafe_function(0, |ctx| {
                let data: Vec<u8> = ctx.value;
                
                // Create buffer and extract the JsBuffer from JsBufferValue
                let buffer_value = ctx.env.create_buffer_with_data(data)?;
                let js_buffer = buffer_value.into_unknown(); // Convert JsBufferValue to JsUnknown
                
                // According to napi-rs docs, return Vec<V> where V implements ToNapiValue
                // For error-first callback with CalleeHandled strategy
                Ok(vec![js_buffer])
            })?;

        let client_inner = self.inner.clone();

        env.spawn_future(async move {
            client_inner
                .subscribe_internal(subscribe_request, ts_callback)
                .await
        })
    }
}

// Stream handlee
#[napi]
pub struct StreamHandle {
    pub id: String,
    inner: Arc<stream::StreamInner>,
}

#[napi]
impl StreamHandle {
    #[napi]
    pub fn cancel(&self) -> Result<()> {
        self.inner.cancel()
    }
}

impl Drop for StreamHandle {
    fn drop(&mut self) {
        let _ = self.inner.cancel();
    }
}

