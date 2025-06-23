use napi::bindgen_prelude::*;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::runtime::Runtime;
use tokio::sync::oneshot;
use tonic::Streaming;
use crossbeam_channel::{bounded, Receiver, Sender};
use parking_lot::Mutex;
use prost::Message;

use crate::buffer_pool::BufferPool;
use crate::metrics::{MetricsCollector, StreamMetrics};

// Generated protobuf code will be available after build
pub mod geyser {
    tonic::include_proto!("geyser");
}

const BATCH_SIZE: usize = 100;
const BATCH_TIMEOUT_MS: u64 = 10;

pub struct StreamInner {
    id: String,
    cancel_tx: Mutex<Option<oneshot::Sender<()>>>,
    metrics: Arc<MetricsCollector>,
    buffer_pool: Arc<BufferPool>,
}

impl StreamInner {
    pub fn new(
        id: String,
        mut stream: Streaming<geyser::SubscribeUpdate>,
        callback: JsFunction,
        runtime: Arc<Runtime>,
        metrics: Arc<MetricsCollector>,
    ) -> Result<Self> {
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let buffer_pool = Arc::new(BufferPool::new());
        
        let stream_metrics = metrics.clone();
        let stream_id = id.clone();
        let stream_buffer_pool = buffer_pool.clone();
        
        // Create threadsafe callback  
        let ts_callback: ThreadsafeFunction<Vec<u8>, ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let buffer = ctx.env.create_buffer_with_data(ctx.value)?;
                Ok(vec![buffer.into_unknown()])
            })?;

        // Spawn stream processing task
        runtime.spawn(async move {
            let mut batch = Vec::with_capacity(BATCH_SIZE);
            let mut last_flush = Instant::now();
            
            loop {
                tokio::select! {
                    // Handle cancellation
                    _ = &mut cancel_rx => {
                        break;
                    }
                    
                    // Process incoming messages
                    result = stream.message() => {
                        match result {
                            Ok(Some(message)) => {
                                let start_time = Instant::now();
                                
                                // Serialize message to bytes
                                let mut buf = Vec::new();
                                if let Err(e) = message.encode(&mut buf) {
                                    eprintln!("Failed to encode message: {}", e);
                                    continue;
                                }
                                
                                batch.push((buf, start_time));
                                
                                // Flush batch if full or timeout reached
                                if batch.len() >= BATCH_SIZE || 
                                   last_flush.elapsed() > Duration::from_millis(BATCH_TIMEOUT_MS) {
                                    Self::flush_batch(&mut batch, &ts_callback, &stream_metrics, &stream_id).await;
                                    last_flush = Instant::now();
                                }
                            }
                            Ok(None) => {
                                // Stream ended
                                break;
                            }
                            Err(e) => {
                                eprintln!("Stream error: {}", e);
                                break;
                            }
                        }
                    }
                    
                    // Timeout-based flush
                    _ = tokio::time::sleep(Duration::from_millis(BATCH_TIMEOUT_MS)) => {
                        if !batch.is_empty() && last_flush.elapsed() > Duration::from_millis(BATCH_TIMEOUT_MS) {
                            Self::flush_batch(&mut batch, &ts_callback, &stream_metrics, &stream_id).await;
                            last_flush = Instant::now();
                        }
                    }
                }
            }
            
            // Flush remaining messages
            if !batch.is_empty() {
                Self::flush_batch(&mut batch, &ts_callback, &stream_metrics, &stream_id).await;
            }
        });

        Ok(Self {
            id,
            cancel_tx: Mutex::new(Some(cancel_tx)),
            metrics,
            buffer_pool,
        })
    }

    async fn flush_batch(
        batch: &mut Vec<(Vec<u8>, Instant)>,
        callback: &ThreadsafeFunction<Vec<u8>, ErrorStrategy::Fatal>,
        metrics: &Arc<MetricsCollector>,
        stream_id: &str,
    ) {
        if batch.is_empty() {
            return;
        }

        let mut total_bytes = 0;
        let mut total_latency = Duration::ZERO;
        let batch_len = batch.len(); // Save length before draining
        
        for (buffer, start_time) in batch.drain(..) {
            total_bytes += buffer.len();
            total_latency += start_time.elapsed();
            
            // Send to JavaScript (non-blocking)
            let _ = callback.call(buffer, ThreadsafeFunctionCallMode::NonBlocking);
        }

        // Update metrics
        let avg_latency = if batch_len > 0 { 
            total_latency / batch_len as u32 
        } else { 
            Duration::ZERO 
        };
        
        metrics.record_batch(stream_id, batch_len, total_bytes, avg_latency);
    }

    pub fn cancel(&self) -> Result<()> {
        if let Some(tx) = self.cancel_tx.lock().take() {
            let _ = tx.send(());
        }
        Ok(())
    }

    pub fn get_metrics(&self) -> StreamMetrics {
        self.metrics.get_stream_metrics(&self.id)
    }
}