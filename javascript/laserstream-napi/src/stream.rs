use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ErrorStrategy, ThreadsafeFunctionCallMode};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::runtime::Runtime;
use tokio::sync::oneshot;
use tonic::Streaming;
// Remove unused crossbeam imports
use parking_lot::Mutex;
use prost::Message;

use crate::buffer_pool::BufferPool;
use crate::metrics::MetricsCollector;

use crate::proto::geyser;

const BATCH_SIZE: usize = 1000;  // Increase batch size for better throughput
const BATCH_TIMEOUT_MS: u64 = 5;  // Reduce timeout for lower latency
const EXPECTED_MESSAGE_SIZE: usize = 1024;  // Typical message size for pre-allocation

pub struct StreamInner {
    id: String,
    cancel_tx: Mutex<Option<oneshot::Sender<()>>>,
    metrics: Arc<MetricsCollector>,
    buffer_pool: Arc<BufferPool>,
}

impl StreamInner {
    pub fn new_with_tsfn(
        id: String,
        mut stream: Streaming<geyser::SubscribeUpdate>,
        ts_callback: ThreadsafeFunction<Vec<u8>, ErrorStrategy::Fatal>,
        runtime: Arc<Runtime>,
        metrics: Arc<MetricsCollector>,
    ) -> Result<Self> {
        let (cancel_tx, mut cancel_rx) = oneshot::channel();
        let buffer_pool = Arc::new(BufferPool::new());
        
        let stream_metrics = metrics.clone();
        let stream_id = id.clone();
        let _stream_buffer_pool = buffer_pool.clone();
        
        // ThreadsafeFunction is already created and passed in

        // Spawn stream processing task
        runtime.spawn(async move {
            // Pre-allocate batch vector
            let mut batch = Vec::with_capacity(BATCH_SIZE);
            let mut last_flush = Instant::now();
            
            // Statistics for monitoring
            let mut total_messages = 0u64;
            let mut total_bytes = 0u64;
            let stream_start = Instant::now();
            
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
                                
                                // Pre-allocate buffer with expected size
                                let mut buf = Vec::with_capacity(EXPECTED_MESSAGE_SIZE);
                                
                                // TODO: In the future, get raw bytes directly from stream
                                // For now, optimize the encoding process
                                if let Err(e) = message.encode(&mut buf) {
                                    eprintln!("Failed to encode message: {}", e);
                                    continue;
                                }
                                
                                // Shrink to fit if we over-allocated
                                buf.shrink_to_fit();
                                
                                // Update statistics before moving buf
                                let buf_len = buf.len();
                                total_messages += 1;
                                total_bytes += buf_len as u64;
                                
                                batch.push((buf, start_time));
                                
                                // Flush batch if full
                                if batch.len() >= BATCH_SIZE {
                                    Self::flush_batch(&mut batch, &ts_callback, &stream_metrics, &stream_id).await;
                                    last_flush = Instant::now();
                                    
                                    // Log progress periodically
                                    if total_messages % 10000 == 0 {
                                        let elapsed = stream_start.elapsed().as_secs_f64();
                                        let mbps = (total_bytes as f64 * 8.0) / (elapsed * 1_000_000.0);
                                        eprintln!("Stream {}: {} messages, {:.2} MB, {:.2} Mbps", 
                                                 stream_id, total_messages, 
                                                 total_bytes as f64 / 1_048_576.0, mbps);
                                    }
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
        
        // Option 1: Send individual messages (current approach)
        // This is better for lower latency per message
        for (buffer, start_time) in batch.drain(..) {
            total_bytes += buffer.len();
            total_latency += start_time.elapsed();
            
            // Send to JavaScript (non-blocking)
            let _ = callback.call(buffer, ThreadsafeFunctionCallMode::NonBlocking);
        }
        
        // Option 2: Combine into single buffer (commented out)
        // This would reduce JS callback overhead but requires protocol change
        /*
        let combined_size: usize = batch.iter().map(|(buf, _)| buf.len() + 4).sum();
        let mut combined = Vec::with_capacity(combined_size);
        
        for (buffer, start_time) in batch.drain(..) {
            total_bytes += buffer.len();
            total_latency += start_time.elapsed();
            
            // Write length prefix
            combined.extend_from_slice(&(buffer.len() as u32).to_le_bytes());
            // Write data
            combined.extend_from_slice(&buffer);
        }
        
        let _ = callback.call(combined, ThreadsafeFunctionCallMode::NonBlocking);
        */

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

    pub fn get_metrics(&self) -> crate::StreamMetrics {
        self.metrics.get_stream_metrics(&self.id)
    }
}
