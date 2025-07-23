pub mod client;
pub mod config;
pub mod error;

pub use client::{subscribe, StreamHandle};
pub use config::{ChannelOptions, LaserstreamConfig, CompressionEncoding};
pub use error::LaserstreamError;

// Re-export commonly used types from yellowstone-grpc-proto
pub use yellowstone_grpc_proto::geyser as grpc;