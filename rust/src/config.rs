use serde::{Deserialize, Serialize};

/// Compression encoding options
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompressionEncoding {
    /// Gzip compression
    Gzip,
    /// Zstd compression
    Zstd,
}

#[derive(Debug, Clone)]
pub struct LaserstreamConfig {
    /// API Key for authentication.
    pub api_key: String,
    /// The Laserstream endpoint URL.
    pub endpoint: String,
    /// Maximum number of reconnection attempts. Defaults to 10.
    /// A hard cap of 240 attempts (20 minutes / 5 seconds) is enforced internally.
    pub max_reconnect_attempts: Option<u32>,
    /// gRPC channel options
    pub channel_options: ChannelOptions,
    /// When true, enable replay on reconnects (uses from_slot and internal slot tracking).
    /// When false, no replay - start from current slot on reconnects.
    /// Default: true
    pub replay: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ChannelOptions {
    /// Connect timeout in seconds. Default: 10
    pub connect_timeout_secs: Option<u64>,
    /// Request timeout in seconds. Default: 30
    pub timeout_secs: Option<u64>,
    /// Max message size for receiving in bytes. Default: 1GB
    pub max_decoding_message_size: Option<usize>,
    /// Max message size for sending in bytes. Default: 32MB
    pub max_encoding_message_size: Option<usize>,
    /// HTTP/2 keep-alive interval in seconds. Default: 30
    pub http2_keep_alive_interval_secs: Option<u64>,
    /// Keep-alive timeout in seconds. Default: 5
    pub keep_alive_timeout_secs: Option<u64>,
    /// Enable keep-alive while idle. Default: true
    pub keep_alive_while_idle: Option<bool>,
    /// Initial stream window size in bytes. Default: 4MB
    pub initial_stream_window_size: Option<u32>,
    /// Initial connection window size in bytes. Default: 8MB
    pub initial_connection_window_size: Option<u32>,
    /// Enable HTTP/2 adaptive window. Default: true
    pub http2_adaptive_window: Option<bool>,
    /// Enable TCP no-delay. Default: true
    pub tcp_nodelay: Option<bool>,
    /// TCP keep-alive interval in seconds. Default: 60
    pub tcp_keepalive_secs: Option<u64>,
    /// Buffer size in bytes. Default: 64KB
    pub buffer_size: Option<usize>,
    /// Compression encodings to accept from server. Default: ["gzip", "zstd"]
    pub accept_compression: Option<Vec<CompressionEncoding>>,
    /// Compression encoding to use when sending. Default: None
    pub send_compression: Option<CompressionEncoding>,
}


impl ChannelOptions {
    /// Enable zstd compression for both sending and receiving
    pub fn with_zstd_compression(mut self) -> Self {
        self.send_compression = Some(CompressionEncoding::Zstd);
        self.accept_compression = Some(vec![CompressionEncoding::Zstd, CompressionEncoding::Gzip]);
        self
    }
    
    /// Enable gzip compression for both sending and receiving
    pub fn with_gzip_compression(mut self) -> Self {
        self.send_compression = Some(CompressionEncoding::Gzip);
        self.accept_compression = Some(vec![CompressionEncoding::Gzip, CompressionEncoding::Zstd]);
        self
    }
}

impl Default for LaserstreamConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            endpoint: String::new(),
            max_reconnect_attempts: None, // Default to None
            channel_options: ChannelOptions::default(),
            replay: true, // Default to true
        }
    }
}

impl LaserstreamConfig {
    pub fn new(endpoint: String, api_key: String) -> Self {
        Self {
            endpoint,
            api_key,
            max_reconnect_attempts: None, // Default to None
            channel_options: ChannelOptions::default(),
            replay: true, // Default to true
        }
    }

    /// Sets the maximum number of reconnection attempts.
    pub fn with_max_reconnect_attempts(mut self, attempts: u32) -> Self {
        self.max_reconnect_attempts = Some(attempts);
        self
    }

    /// Sets custom channel options.
    pub fn with_channel_options(mut self, options: ChannelOptions) -> Self {
        self.channel_options = options;
        self
    }

    /// Sets replay behavior on reconnects.
    /// When true (default), uses from_slot and internal slot tracking for replay.
    /// When false, starts from current slot on reconnects (no replay).
    pub fn with_replay(mut self, replay: bool) -> Self {
        self.replay = replay;
        self
    }
}
