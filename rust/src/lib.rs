pub mod client;
pub mod config;
pub mod error;

pub use client::{subscribe, subscribe_preprocessed, StreamHandle, PreprocessedStreamHandle};
pub use config::{ChannelOptions, LaserstreamConfig, CompressionEncoding};
pub use error::LaserstreamError;

// Re-export commonly used types from laserstream-core-proto
pub use laserstream_core_proto::geyser as grpc;
pub use laserstream_core_proto::solana;