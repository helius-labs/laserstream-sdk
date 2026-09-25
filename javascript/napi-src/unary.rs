//! Unary (request/response) Geyser RPCs exposed to JS.
//!
//! u64 fields are returned as decimal strings, matching how `subscribe` decodes
//! uint64 (`longs: String`) and avoiding precision loss above 2^53.

use laserstream_core_proto::geyser;
use laserstream_core_proto::prelude::geyser_client::GeyserClient;
use laserstream_core_proto::tonic::{
    service::interceptor::InterceptedService, transport::Channel, Response as TonicResponse,
    Status as TonicStatus,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::future::Future;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use crate::client::ChannelOptions;
use crate::stream::{configure_endpoint, ChannelConfig, SdkMetadataInterceptor};

type SdkGeyserClient = GeyserClient<InterceptedService<Channel, SdkMetadataInterceptor>>;

/// Per-call deadline when `timeoutMs` is not given (matches the Rust and Go SDKs).
const DEFAULT_TIMEOUT_MS: u32 = 30_000;

#[napi(object)]
pub struct GetSlotResponse {
    pub slot: String,
}

#[napi(object)]
pub struct GetBlockHeightResponse {
    pub block_height: String,
}

#[napi(object)]
pub struct GetLatestBlockhashResponse {
    pub slot: String,
    pub blockhash: String,
    pub last_valid_block_height: String,
}

#[napi(object)]
pub struct IsBlockhashValidResponse {
    pub slot: String,
    pub valid: bool,
}

#[napi(object)]
pub struct GetVersionResponse {
    pub version: String,
}

#[napi(object)]
pub struct PongResponse {
    pub count: i32,
}

#[napi(object)]
pub struct SubscribeReplayInfoResponse {
    pub first_available: Option<String>,
}

fn status_err(s: TonicStatus) -> Error {
    Error::new(Status::GenericFailure, format!("gRPC {:?}: {}", s.code(), s.message()))
}

/// Native client for unary RPCs. All calls share one HTTP/2 connection, opened
/// on the first call and re-opened automatically if it drops.
#[napi]
pub struct UnaryClient {
    endpoint: String,
    token: Option<String>,
    channel_options: Option<ChannelOptions>,
    /// Deadline for each whole call, including connecting.
    timeout: Duration,
    /// Shared gRPC client: created on the first call, cleared by `close()`.
    grpc_client: Mutex<Option<SdkGeyserClient>>,
}

impl UnaryClient {
    /// Returns the shared gRPC client, creating it on first use.
    ///
    /// Creating it does no network I/O (see `build_lazy_grpc_client`), so the
    /// lock is only held briefly and calls never wait behind a connection attempt.
    fn get_or_create_grpc_client(&self) -> Result<SdkGeyserClient> {
        let mut grpc_client = self.grpc_client.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(existing) = grpc_client.as_ref() {
            return Ok(existing.clone());
        }
        let created = self.build_lazy_grpc_client()?;
        *grpc_client = Some(created.clone());
        Ok(created)
    }

    /// Builds a gRPC client on a lazily-connected channel: the connection is
    /// opened by the first request (and re-opened by tonic if it drops), so
    /// connecting counts against that request's deadline.
    fn build_lazy_grpc_client(&self) -> Result<SdkGeyserClient> {
        let interceptor = SdkMetadataInterceptor::new(&self.token).map_err(status_err)?;
        let cfg = ChannelConfig::from_options(&self.channel_options);
        // Also set the channel's own request timeout to `timeoutMs`, otherwise
        // the endpoint default (10s or 30s) would cut off longer deadlines.
        let channel = configure_endpoint(&self.endpoint, &self.channel_options)
            .map_err(|e| Error::from_reason(format!("Invalid endpoint: {e}")))?
            .timeout(self.timeout)
            .connect_lazy();
        let mut grpc_client = GeyserClient::with_interceptor(channel, interceptor)
            .max_decoding_message_size(cfg.max_recv_msg_size)
            .max_encoding_message_size(cfg.max_send_msg_size);
        if let Some(enc) = cfg.send_compression {
            grpc_client = grpc_client.send_compressed(enc);
        }
        if let Some(enc) = cfg.accept_compression {
            grpc_client = grpc_client.accept_compressed(enc);
        }
        Ok(grpc_client)
    }

    /// Runs one RPC on the shared client. `timeoutMs` bounds the whole call,
    /// including connecting, so a call never waits longer than its deadline.
    async fn call_with_deadline<T, F, Fut>(&self, rpc: F) -> Result<T>
    where
        F: FnOnce(SdkGeyserClient) -> Fut,
        Fut: Future<Output = std::result::Result<TonicResponse<T>, TonicStatus>>,
    {
        let grpc_client = self.get_or_create_grpc_client()?;
        match tokio::time::timeout(self.timeout, rpc(grpc_client)).await {
            Ok(result) => result.map(TonicResponse::into_inner).map_err(status_err),
            Err(_elapsed) => Err(Error::new(
                Status::GenericFailure,
                format!("gRPC DeadlineExceeded: call timed out after {} ms", self.timeout.as_millis()),
            )),
        }
    }
}

#[napi]
impl UnaryClient {
    #[napi(constructor)]
    pub fn new(
        env: Env,
        endpoint: String,
        token: Option<String>,
        channel_options: Option<Object>,
        timeout_ms: Option<u32>,
    ) -> Result<Self> {
        crate::init_rustls();
        let channel_options = match channel_options {
            Some(o) => Some(env.from_js_value::<ChannelOptions, _>(o)?),
            None => None,
        };
        let timeout_ms = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        if timeout_ms == 0 {
            return Err(Error::from_reason("timeoutMs must be greater than 0"));
        }
        Ok(Self {
            endpoint,
            token,
            channel_options,
            timeout: Duration::from_millis(timeout_ms as u64),
            grpc_client: Mutex::new(None),
        })
    }

    /// Drops the shared connection. Calls already in flight finish normally;
    /// a later call opens a new connection.
    #[napi]
    pub fn close(&self) {
        self.grpc_client.lock().unwrap_or_else(PoisonError::into_inner).take();
    }

    #[napi]
    pub async fn get_slot(&self, commitment: Option<i32>) -> Result<GetSlotResponse> {
        let r = self
            .call_with_deadline(|mut c| async move {
                c.get_slot(geyser::GetSlotRequest { commitment }).await
            })
            .await?;
        Ok(GetSlotResponse { slot: r.slot.to_string() })
    }

    #[napi]
    pub async fn get_block_height(&self, commitment: Option<i32>) -> Result<GetBlockHeightResponse> {
        let r = self
            .call_with_deadline(|mut c| async move {
                c.get_block_height(geyser::GetBlockHeightRequest { commitment }).await
            })
            .await?;
        Ok(GetBlockHeightResponse { block_height: r.block_height.to_string() })
    }

    #[napi]
    pub async fn get_latest_blockhash(
        &self,
        commitment: Option<i32>,
    ) -> Result<GetLatestBlockhashResponse> {
        let r = self
            .call_with_deadline(|mut c| async move {
                c.get_latest_blockhash(geyser::GetLatestBlockhashRequest { commitment }).await
            })
            .await?;
        Ok(GetLatestBlockhashResponse {
            slot: r.slot.to_string(),
            blockhash: r.blockhash,
            last_valid_block_height: r.last_valid_block_height.to_string(),
        })
    }

    #[napi]
    pub async fn is_blockhash_valid(
        &self,
        blockhash: String,
        commitment: Option<i32>,
    ) -> Result<IsBlockhashValidResponse> {
        let r = self
            .call_with_deadline(|mut c| async move {
                c.is_blockhash_valid(geyser::IsBlockhashValidRequest { blockhash, commitment }).await
            })
            .await?;
        Ok(IsBlockhashValidResponse { slot: r.slot.to_string(), valid: r.valid })
    }

    #[napi]
    pub async fn get_version(&self) -> Result<GetVersionResponse> {
        let r = self
            .call_with_deadline(|mut c| async move {
                c.get_version(geyser::GetVersionRequest {}).await
            })
            .await?;
        Ok(GetVersionResponse { version: r.version })
    }

    #[napi]
    pub async fn ping(&self, count: Option<i32>) -> Result<PongResponse> {
        let count = count.unwrap_or(1);
        let r = self
            .call_with_deadline(|mut c| async move {
                c.ping(geyser::PingRequest { count }).await
            })
            .await?;
        Ok(PongResponse { count: r.count })
    }

    /// Oldest slot this endpoint can replay from (smallest usable `fromSlot`).
    /// See `LaserstreamClient.subscribeReplayInfo` in client.d.ts for usage.
    #[napi]
    pub async fn subscribe_replay_info(&self) -> Result<SubscribeReplayInfoResponse> {
        let r = self
            .call_with_deadline(|mut c| async move {
                c.subscribe_replay_info(geyser::SubscribeReplayInfoRequest {}).await
            })
            .await?;
        Ok(SubscribeReplayInfoResponse { first_available: r.first_available.map(|s| s.to_string()) })
    }
}
