use napi::bindgen_prelude::*;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::runtime::Runtime;
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use tonic::metadata::{MetadataMap, MetadataValue};
use dashmap::DashMap;
use uuid::Uuid;

use crate::stream::StreamInner;
use crate::metrics::{GlobalMetrics, MetricsCollector};

// Generated protobuf code will be available after build
pub mod geyser {
    tonic::include_proto!("geyser");
}

pub struct ClientInner {
    runtime: Arc<Runtime>,
    channel: Channel,
    token: Option<String>,
    streams: Arc<DashMap<String, Arc<StreamInner>>>,
    metrics: Arc<MetricsCollector>,
}

impl ClientInner {
    pub fn new(endpoint: String, token: Option<String>) -> Result<Self> {
        let runtime = Arc::new(
            Runtime::new()
                .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to create runtime: {}", e)))?
        );

        let channel = runtime.block_on(async {
            let mut endpoint = Endpoint::from_shared(endpoint)
                .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid endpoint: {}", e)))?;

            // Configure channel with optimized settings
            endpoint = endpoint
                .http2_keep_alive_interval(Duration::from_secs(30))
                .keep_alive_timeout(Duration::from_secs(10))
                .keep_alive_while_idle(true)
                .http2_adaptive_window(true)
                .initial_stream_window_size(Some(65 * 1024 * 1024)) // 65MB
                .initial_connection_window_size(Some(65 * 1024 * 1024)) // 65MB
                .max_decoding_message_size(100 * 1024 * 1024) // 100MB
                .max_encoding_message_size(10 * 1024 * 1024); // 10MB

            // Add TLS if endpoint is HTTPS
            if endpoint.uri().scheme_str() == Some("https") {
                endpoint = endpoint.tls_config(ClientTlsConfig::new())
                    .map_err(|e| Error::new(Status::GenericFailure, format!("TLS config error: {}", e)))?;
            }

            endpoint.connect().await
                .map_err(|e| Error::new(Status::GenericFailure, format!("Connection failed: {}", e)))
        })?;

        Ok(Self {
            runtime,
            channel,
            token,
            streams: Arc::new(DashMap::new()),
            metrics: Arc::new(MetricsCollector::new()),
        })
    }

    pub async fn subscribe(
        &self,
        request: Object,
        callback: JsFunction,
    ) -> Result<crate::StreamHandle> {
        let stream_id = Uuid::new_v4().to_string();
        
        // Convert JS request to protobuf
        let subscribe_request = self.js_to_subscribe_request(request)?;
        
        // Create gRPC client
        let mut client = geyser::geyser_client::GeyserClient::new(self.channel.clone());
        
        // Add authorization if token provided
        let mut metadata = MetadataMap::new();
        if let Some(ref token) = self.token {
            let auth_value = MetadataValue::try_from(format!("Bearer {}", token))
                .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid token: {}", e)))?;
            metadata.insert("authorization", auth_value);
        }

        // Create stream
        let request = tonic::Request::new(subscribe_request);
        let mut request = request;
        *request.metadata_mut() = metadata;

        let response = client.subscribe(request).await
            .map_err(|e| Error::new(Status::GenericFailure, format!("Subscribe failed: {}", e)))?;

        let stream = response.into_inner();

        // Create stream handler
        let stream_inner = Arc::new(StreamInner::new(
            stream_id.clone(),
            stream,
            callback,
            self.runtime.clone(),
            self.metrics.clone(),
        )?);

        self.streams.insert(stream_id.clone(), stream_inner.clone());

        Ok(crate::StreamHandle {
            id: stream_id,
            inner: stream_inner,
        })
    }

    pub fn get_metrics(&self) -> GlobalMetrics {
        self.metrics.get_global_metrics(self.streams.len() as u32)
    }

    fn js_to_subscribe_request(&self, js_obj: Object) -> Result<geyser::SubscribeRequest> {
        // Basic implementation - can be extended for full feature set
        let mut request = geyser::SubscribeRequest::default();
        
        // Check for accounts subscription
        if js_obj.has_named_property("accounts")? {
            request.accounts = Some(geyser::SubscribeRequestFilterAccounts::default()).into();
        }
        
        // Check for transactions subscription  
        if js_obj.has_named_property("transactions")? {
            request.transactions = Some(geyser::SubscribeRequestFilterTransactions::default()).into();
        }
        
        // Check for blocks subscription
        if js_obj.has_named_property("blocks")? {
            request.blocks = Some(geyser::SubscribeRequestFilterBlocks::default()).into();
        }
        
        // Check for slots subscription
        if js_obj.has_named_property("slots")? {
            request.slots = Some(geyser::SubscribeRequestFilterSlots::default()).into();
        }

        Ok(request)
    }
}