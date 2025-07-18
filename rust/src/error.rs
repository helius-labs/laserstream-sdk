use tonic::Status;
use url::ParseError;
use futures_channel::mpsc::SendError;
use yellowstone_grpc_client::{GeyserGrpcClientError, GeyserGrpcBuilderError};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LaserstreamError {
    #[error("gRPC transport error: {0}")]
    Transport(#[from] tonic::transport::Error),

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

    #[error("Yellowstone client error: {0}")]
    ClientError(#[from] GeyserGrpcClientError),

    #[error("Yellowstone builder error: {0}")]
    BuilderError(#[from] GeyserGrpcBuilderError),

    #[error("Invalid API Key format")]
    InvalidApiKeyFormat,
    
    #[error("Connection error: {0}")]
    ConnectionError(String),
}
