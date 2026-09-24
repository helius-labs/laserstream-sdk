//! Unary (request/response) Geyser RPCs exposed to JS.
//!
//! u64 fields are returned as decimal strings, matching how `subscribe` decodes
//! uint64 (`longs: String`) and avoiding precision loss above 2^53.

use laserstream_core_proto::geyser;
use laserstream_core_proto::prelude::geyser_client::GeyserClient;
use laserstream_core_proto::tonic::{service::interceptor::InterceptedService, transport::Channel};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::Mutex;
use std::time::Duration;

use crate::client::ChannelOptions;
use crate::stream::{configure_endpoint, ChannelConfig, SdkMetadataInterceptor};

type SdkGeyserClient = GeyserClient<InterceptedService<Channel, SdkMetadataInterceptor>>;

/// Per-call deadline when `timeoutMs` is not given (matches the Rust and Go SDKs).
const DEFAULT_TIMEOUT_MS: u32 = 30_000;

/// Cached connection plus an epoch that `close()` bumps, so a dial that was in
/// flight when `close()` ran does not re-cache its connection.
#[derive(Default)]
struct ClientSlot {
    client: Option<SdkGeyserClient>,
    epoch: u64,
}

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

fn status_err(s: laserstream_core_proto::tonic::Status) -> Error {
    Error::new(Status::GenericFailure, format!("gRPC {:?}: {}", s.code(), s.message()))
}

/// Native client for unary RPCs. One HTTP/2 connection, opened on first call
/// and shared by all subsequent calls (reconnects transparently).
#[napi]
pub struct UnaryClient {
    endpoint: String,
    token: Option<String>,
    channel_options: Option<ChannelOptions>,
    timeout: Duration,
    slot: Mutex<ClientSlot>,
    /// Serializes dials so concurrent first calls share one connection.
    dial_lock: tokio::sync::Mutex<()>,
}

impl UnaryClient {
    fn cached(&self) -> (Option<SdkGeyserClient>, u64) {
        let slot = self.slot.lock().unwrap();
        (slot.client.clone(), slot.epoch)
    }

    async fn client(&self) -> Result<SdkGeyserClient> {
        if let (Some(c), _) = self.cached() {
            return Ok(c);
        }
        let _dial = self.dial_lock.lock().await;
        let (cached, epoch) = self.cached();
        if let Some(c) = cached {
            return Ok(c);
        }
        let c = self.dial().await?;
        let mut slot = self.slot.lock().unwrap();
        if slot.epoch == epoch {
            slot.client = Some(c.clone());
        }
        Ok(c)
    }

    async fn dial(&self) -> Result<SdkGeyserClient> {
        let interceptor = SdkMetadataInterceptor::new(&self.token).map_err(status_err)?;
        let cfg = ChannelConfig::from_options(&self.channel_options);
        // `timeoutMs` is the per-call deadline for unary RPCs; it takes
        // precedence over any timeout derived from channel options.
        let channel = configure_endpoint(&self.endpoint, &self.channel_options)
            .map_err(|e| Error::from_reason(format!("Invalid endpoint: {e}")))?
            .timeout(self.timeout)
            .connect()
            .await
            .map_err(|e| Error::from_reason(format!("Connection failed: {e}")))?;
        let mut c = GeyserClient::with_interceptor(channel, interceptor)
            .max_decoding_message_size(cfg.max_recv_msg_size)
            .max_encoding_message_size(cfg.max_send_msg_size);
        if let Some(enc) = cfg.send_compression {
            c = c.send_compressed(enc);
        }
        if let Some(enc) = cfg.accept_compression {
            c = c.accept_compressed(enc);
        }
        Ok(c)
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
            slot: Mutex::new(ClientSlot::default()),
            dial_lock: tokio::sync::Mutex::new(()),
        })
    }

    /// Drops the shared connection. Calls already in flight finish normally;
    /// a later call opens a new connection.
    #[napi]
    pub fn close(&self) {
        let mut slot = self.slot.lock().unwrap();
        slot.client = None;
        slot.epoch += 1;
    }

    #[napi]
    pub async fn get_slot(&self, commitment: Option<i32>) -> Result<GetSlotResponse> {
        let r = self
            .client()
            .await?
            .get_slot(geyser::GetSlotRequest { commitment })
            .await
            .map_err(status_err)?
            .into_inner();
        Ok(GetSlotResponse { slot: r.slot.to_string() })
    }

    #[napi]
    pub async fn get_block_height(&self, commitment: Option<i32>) -> Result<GetBlockHeightResponse> {
        let r = self
            .client()
            .await?
            .get_block_height(geyser::GetBlockHeightRequest { commitment })
            .await
            .map_err(status_err)?
            .into_inner();
        Ok(GetBlockHeightResponse { block_height: r.block_height.to_string() })
    }

    #[napi]
    pub async fn get_latest_blockhash(
        &self,
        commitment: Option<i32>,
    ) -> Result<GetLatestBlockhashResponse> {
        let r = self
            .client()
            .await?
            .get_latest_blockhash(geyser::GetLatestBlockhashRequest { commitment })
            .await
            .map_err(status_err)?
            .into_inner();
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
            .client()
            .await?
            .is_blockhash_valid(geyser::IsBlockhashValidRequest { blockhash, commitment })
            .await
            .map_err(status_err)?
            .into_inner();
        Ok(IsBlockhashValidResponse { slot: r.slot.to_string(), valid: r.valid })
    }

    #[napi]
    pub async fn get_version(&self) -> Result<GetVersionResponse> {
        let r = self
            .client()
            .await?
            .get_version(geyser::GetVersionRequest {})
            .await
            .map_err(status_err)?
            .into_inner();
        Ok(GetVersionResponse { version: r.version })
    }

    #[napi]
    pub async fn ping(&self, count: Option<i32>) -> Result<PongResponse> {
        let r = self
            .client()
            .await?
            .ping(geyser::PingRequest { count: count.unwrap_or(1) })
            .await
            .map_err(status_err)?
            .into_inner();
        Ok(PongResponse { count: r.count })
    }

    /// Oldest slot this endpoint can replay from (smallest usable `fromSlot`).
    /// See `LaserstreamClient.subscribeReplayInfo` in client.d.ts for usage.
    #[napi]
    pub async fn subscribe_replay_info(&self) -> Result<SubscribeReplayInfoResponse> {
        let r = self
            .client()
            .await?
            .subscribe_replay_info(geyser::SubscribeReplayInfoRequest {})
            .await
            .map_err(status_err)?
            .into_inner();
        Ok(SubscribeReplayInfoResponse { first_available: r.first_available.map(|s| s.to_string()) })
    }
}
