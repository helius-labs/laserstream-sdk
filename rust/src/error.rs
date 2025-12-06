use laserstream_core_proto::tonic::Status;
use url::ParseError;
use futures_channel::mpsc::SendError;
use laserstream_core_client::{GeyserGrpcClientError, GeyserGrpcBuilderError};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LaserstreamError {
    #[error("gRPC transport error: {0}")]
    Transport(#[from] laserstream_core_proto::tonic::transport::Error),

    #[error("gRPC status error: {0}")]
    Status(#[from] Status),

    #[error("Invalid endpoint URL: {0}")]
    InvalidUrl(#[from] ParseError),

    #[error("Stream unexpectedly ended")]
    StreamEnded,

    #[error("Subscription channel send error: {0}")]
    SubscriptionSendError(#[from] SendError),

    #[error("Maximum reconnection attempts reached: {0}")]
    MaxReconnectAttempts(Status),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Laserstream client error: {0}")]
    ClientError(#[from] GeyserGrpcClientError),

    #[error("Laserstream builder error: {0}")]
    BuilderError(#[from] GeyserGrpcBuilderError),

    #[error("Invalid API Key format")]
    InvalidApiKeyFormat,

    #[error("Connection error: {0}")]
    ConnectionError(String),
}
