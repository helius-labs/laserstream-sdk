// Re-export generated protobuf types and tonic types for user convenience
pub mod grpc {
    pub use yellowstone_grpc_proto::prelude::*;
}
pub use grpc::{CommitmentLevel, SubscribeUpdate};
pub use tonic::Status;

pub mod client;
pub mod config;
pub mod error;

pub use client::{subscribe, StreamHandle};
pub use config::{LaserstreamConfig, ChannelOptions};
pub use error::LaserstreamError;

// Re-export necessary types from yellowstone-grpc-proto
pub use yellowstone_grpc_proto::geyser::{
    subscribe_request_filter_accounts_filter::Filter as AccountsFilterOneof,
    subscribe_request_filter_accounts_filter_lamports::Cmp as AccountsFilterLamports,
    subscribe_request_filter_accounts_filter_memcmp::Data as AccountsFilterMemcmpOneof,
    SubscribeRequest, SubscribeRequestAccountsDataSlice, SubscribeRequestFilterAccounts,
    SubscribeRequestFilterAccountsFilter, SubscribeRequestFilterAccountsFilterLamports,
    SubscribeRequestFilterAccountsFilterMemcmp, SubscribeRequestFilterBlocks,
    SubscribeRequestFilterBlocksMeta, SubscribeRequestFilterEntry, SubscribeRequestFilterSlots,
    SubscribeRequestFilterTransactions, SubscribeRequestPing,
};
