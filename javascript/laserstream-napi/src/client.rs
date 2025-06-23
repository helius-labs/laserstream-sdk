use dashmap::DashMap;
use napi::bindgen_prelude::*;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::runtime::Runtime;
use tonic::metadata::MetadataValue;
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use uuid::Uuid;

use crate::metrics::MetricsCollector;
use crate::stream::StreamInner;

use crate::proto::geyser;

pub struct ClientInner {
    runtime: Arc<Runtime>,
    channel: Channel,
    token: Option<String>,
    streams: Arc<DashMap<String, Arc<StreamInner>>>,
    metrics: Arc<MetricsCollector>,
}

impl ClientInner {
    pub fn new(endpoint: String, token: Option<String>) -> Result<Self> {
        let runtime = Arc::new(Runtime::new().map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to create runtime: {}", e),
            )
        })?);

        let channel = runtime.block_on(async {
            let mut endpoint = Endpoint::from_shared(endpoint)
                .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid endpoint: {}", e)))?;

            // Configure channel with optimized settings for high throughput
            endpoint = endpoint
                .http2_keep_alive_interval(Duration::from_secs(30))
                .keep_alive_timeout(Duration::from_secs(10))
                .keep_alive_while_idle(true)
                .http2_adaptive_window(true)
                .initial_stream_window_size(Some(256 * 1024 * 1024)) // 256MB - larger window
                .initial_connection_window_size(Some(256 * 1024 * 1024)) // 256MB
                .concurrency_limit(4); // Allow multiple concurrent streams

            // Add TLS if endpoint is HTTPS
            if endpoint.uri().scheme_str() == Some("https") {
                endpoint = endpoint.tls_config(ClientTlsConfig::new()).map_err(|e| {
                    Error::new(Status::GenericFailure, format!("TLS config error: {}", e))
                })?;
            }

            endpoint.connect().await.map_err(|e| {
                Error::new(Status::GenericFailure, format!("Connection failed: {}", e))
            })
        })?;

        Ok(Self {
            runtime,
            channel,
            token,
            streams: Arc::new(DashMap::new()),
            metrics: Arc::new(MetricsCollector::new()),
        })
    }

    pub fn js_to_subscribe_request(&self, js_obj: Object) -> Result<geyser::SubscribeRequest> {
        // Basic implementation - can be extended for full feature set
        let mut request = geyser::SubscribeRequest::default();

        // Check for accounts subscription
        if js_obj.has_named_property("accounts")? {
            let mut accounts_map = HashMap::new();
            accounts_map.insert(
                "default".to_string(),
                geyser::SubscribeRequestFilterAccounts::default(),
            );
            request.accounts = accounts_map;
        }

        // Check for transactions subscription
        if js_obj.has_named_property("transactions")? {
            let mut transactions_map = HashMap::new();
            transactions_map.insert(
                "default".to_string(),
                geyser::SubscribeRequestFilterTransactions::default(),
            );
            request.transactions = transactions_map;
        }

        // Check for blocks subscription
        if js_obj.has_named_property("blocks")? {
            let mut blocks_map = HashMap::new();
            blocks_map.insert(
                "default".to_string(),
                geyser::SubscribeRequestFilterBlocks::default(),
            );
            request.blocks = blocks_map;
        }

        // Check for slots subscription
        if js_obj.has_named_property("slots")? {
            let mut slots_map = HashMap::new();
            slots_map.insert(
                "default".to_string(),
                geyser::SubscribeRequestFilterSlots::default(),
            );
            request.slots = slots_map;
        }

        Ok(request)
    }

    pub async fn subscribe_internal_with_tsfn(
        &self,
        subscribe_request: geyser::SubscribeRequest,
        ts_callback: napi::threadsafe_function::ThreadsafeFunction<
            Vec<u8>,
            napi::threadsafe_function::ErrorStrategy::Fatal,
        >,
    ) -> Result<crate::StreamHandle> {
        let stream_id = Uuid::new_v4().to_string();

        // Create gRPC client with increased message size limits
        let mut client = geyser::geyser_client::GeyserClient::new(self.channel.clone())
            .max_decoding_message_size(64 * 1024 * 1024) // 64MB max message size
            .max_encoding_message_size(64 * 1024 * 1024); // 64MB max message size

        // Create a channel to send subscription requests
        let (tx, rx) = tokio::sync::mpsc::channel(1);

        // Send the initial subscription request
        let _ = tx.send(subscribe_request).await;

        // Convert the receiver to a stream
        let request_stream = tokio_stream::wrappers::ReceiverStream::new(rx);
        let mut request = tonic::Request::new(request_stream);

        // Add authorization if token provided
        if let Some(ref token) = self.token {
            let auth_value = MetadataValue::try_from(token)
                .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid token: {}", e)))?;
            request.metadata_mut().insert("x-token", auth_value);
        }

        // Configure the request with optimizations
        let response = client
            .subscribe(request)
            .await
            .map_err(|e| Error::new(Status::GenericFailure, format!("Subscribe failed: {}", e)))?;

        let stream = response.into_inner();

        // Create stream handler with threadsafe function
        let stream_inner = Arc::new(StreamInner::new_with_tsfn(
            stream_id.clone(),
            stream,
            ts_callback,
            self.runtime.clone(),
            self.metrics.clone(),
        )?);

        self.streams.insert(stream_id.clone(), stream_inner.clone());

        Ok(crate::StreamHandle {
            id: stream_id,
            inner: stream_inner,
        })
    }

    pub fn get_metrics(&self) -> crate::GlobalMetrics {
        self.metrics.get_global_metrics(self.streams.len() as u32)
    }
}
