use dashmap::DashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use parking_lot::RwLock;

use crate::{GlobalMetrics, StreamMetrics};

#[derive(Debug)]
pub struct StreamStats {
    pub messages_count: AtomicU64,
    pub bytes_count: AtomicU64,
    pub last_update: RwLock<Instant>,
    pub messages_per_sec: RwLock<f64>,
    pub bytes_per_sec: RwLock<f64>,
    pub avg_latency_ms: RwLock<f64>,
}

impl StreamStats {
    pub fn new() -> Self {
        Self {
            messages_count: AtomicU64::new(0),
            bytes_count: AtomicU64::new(0),
            last_update: RwLock::new(Instant::now()),
            messages_per_sec: RwLock::new(0.0),
            bytes_per_sec: RwLock::new(0.0),
            avg_latency_ms: RwLock::new(0.0),
        }
    }

    pub fn record_batch(&self, message_count: usize, byte_count: usize, avg_latency: Duration) {
        let now = Instant::now();
        let mut last_update = self.last_update.write();
        let elapsed = now.duration_since(*last_update).as_secs_f64();
        
        // Update counters
        self.messages_count.fetch_add(message_count as u64, Ordering::Relaxed);
        self.bytes_count.fetch_add(byte_count as u64, Ordering::Relaxed);
        
        // Update rates if enough time has passed
        if elapsed >= 1.0 {
            let messages_per_sec = message_count as f64 / elapsed;
            let bytes_per_sec = byte_count as f64 / elapsed;
            
            *self.messages_per_sec.write() = messages_per_sec;
            *self.bytes_per_sec.write() = bytes_per_sec;
            *self.avg_latency_ms.write() = avg_latency.as_millis() as f64;
            *last_update = now;
        }
    }

    pub fn get_metrics(&self) -> StreamMetrics {
        StreamMetrics {
            messages_per_sec: *self.messages_per_sec.read(),
            bytes_per_sec: *self.bytes_per_sec.read(),
            total_messages: self.messages_count.load(Ordering::Relaxed) as f64,
            total_bytes: self.bytes_count.load(Ordering::Relaxed) as f64,
            avg_latency_ms: *self.avg_latency_ms.read(),
        }
    }
}

pub struct MetricsCollector {
    streams: DashMap<String, Arc<StreamStats>>,
    global_messages: AtomicU64,
    global_bytes: AtomicU64,
    last_global_update: RwLock<Instant>,
    global_messages_per_sec: RwLock<f64>,
    global_bytes_per_sec: RwLock<f64>,
}

impl MetricsCollector {
    pub fn new() -> Self {
        Self {
            streams: DashMap::new(),
            global_messages: AtomicU64::new(0),
            global_bytes: AtomicU64::new(0),
            last_global_update: RwLock::new(Instant::now()),
            global_messages_per_sec: RwLock::new(0.0),
            global_bytes_per_sec: RwLock::new(0.0),
        }
    }

    pub fn record_batch(
        &self,
        stream_id: &str,
        message_count: usize,
        byte_count: usize,
        avg_latency: Duration,
    ) {
        // Get or create stream stats
        let stats = self.streams
            .entry(stream_id.to_string())
            .or_insert_with(|| Arc::new(StreamStats::new()))
            .clone();

        // Record in stream stats
        stats.record_batch(message_count, byte_count, avg_latency);

        // Update global stats
        self.update_global_stats(message_count, byte_count);
    }

    fn update_global_stats(&self, message_count: usize, byte_count: usize) {
        let now = Instant::now();
        let mut last_update = self.last_global_update.write();
        let elapsed = now.duration_since(*last_update).as_secs_f64();

        // Update global counters
        self.global_messages.fetch_add(message_count as u64, Ordering::Relaxed);
        self.global_bytes.fetch_add(byte_count as u64, Ordering::Relaxed);

        // Update global rates
        if elapsed >= 1.0 {
            let messages_per_sec = message_count as f64 / elapsed;
            let bytes_per_sec = byte_count as f64 / elapsed;

            *self.global_messages_per_sec.write() = messages_per_sec;
            *self.global_bytes_per_sec.write() = bytes_per_sec;
            *last_update = now;
        }
    }

    pub fn get_stream_metrics(&self, stream_id: &str) -> StreamMetrics {
        if let Some(stats) = self.streams.get(stream_id) {
            stats.get_metrics()
        } else {
            StreamMetrics {
                messages_per_sec: 0.0,
                bytes_per_sec: 0.0,
                total_messages: 0.0,
                total_bytes: 0.0,
                avg_latency_ms: 0.0,
            }
        }
    }

    pub fn get_global_metrics(&self, active_streams: u32) -> GlobalMetrics {
        // Aggregate all stream metrics
        let mut total_messages_per_sec = 0.0;
        let mut total_bytes_per_sec = 0.0;
        let mut total_messages = 0.0;
        let mut total_bytes = 0.0;

        for entry in self.streams.iter() {
            let metrics = entry.value().get_metrics();
            total_messages_per_sec += metrics.messages_per_sec;
            total_bytes_per_sec += metrics.bytes_per_sec;
            total_messages += metrics.total_messages;
            total_bytes += metrics.total_bytes;
        }

        GlobalMetrics {
            active_streams,
            total_messages_per_sec,
            total_bytes_per_sec,
            total_messages,
            total_bytes,
        }
    }

    pub fn remove_stream(&self, stream_id: &str) {
        self.streams.remove(stream_id);
    }
}