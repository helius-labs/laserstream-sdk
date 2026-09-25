//! Unary (request/response) Geyser RPCs.
//!
//! ```no_run
//! use helius_laserstream::{LaserstreamClient, LaserstreamConfig, grpc::CommitmentLevel};
//!
//! # async fn run() -> Result<(), helius_laserstream::LaserstreamError> {
//! let config = LaserstreamConfig::new("https://laserstream-mainnet-ewr.helius-rpc.com".into(), "API_KEY".into());
//! let client = LaserstreamClient::connect(config).await?;
//!
//! let slot = client.get_slot(Some(CommitmentLevel::Confirmed)).await?.slot;
//! let bh = client.get_latest_blockhash(None).await?;
//! let valid = client.is_blockhash_valid(&bh.blockhash, None).await?.valid;
//! # Ok(()) }
//! ```

use crate::client::{build_geyser_client, SdkGeyserClient};
use crate::{LaserstreamConfig, LaserstreamError};
use laserstream_core_proto::geyser::{
    CommitmentLevel, GetBlockHeightRequest, GetBlockHeightResponse, GetLatestBlockhashRequest,
    GetLatestBlockhashResponse, GetSlotRequest, GetSlotResponse, GetVersionRequest,
    GetVersionResponse, IsBlockhashValidRequest, IsBlockhashValidResponse, PingRequest,
    PongResponse, SubscribeReplayInfoRequest, SubscribeReplayInfoResponse,
};

/// Client for the unary Geyser RPCs (`get_slot`, `get_latest_blockhash`, ...).
///
/// Holds one multiplexed HTTP/2 channel; cloning is cheap and clones share the
/// connection, so create it once and reuse it. The channel reconnects
/// transparently if the connection drops. Per-call deadline is
/// `channel_options.timeout_secs` (default 30s).
#[derive(Clone)]
pub struct LaserstreamClient {
    shared_grpc_client: SdkGeyserClient,
}

impl LaserstreamClient {
    /// Connects to `config.endpoint` using the same auth, TLS, and channel
    /// options as [`crate::subscribe`].
    pub async fn connect(config: LaserstreamConfig) -> Result<Self, LaserstreamError> {
        let api_key = config.api_key.clone();
        let shared_grpc_client = build_geyser_client(&config, api_key).await?;
        Ok(Self { shared_grpc_client })
    }

    /// Returns a handle to the shared gRPC client for one call.
    ///
    /// The generated tonic methods take `&mut self`; handing each call its own
    /// clone lets our methods take `&self`, so one `LaserstreamClient` can be
    /// used from many tasks at once without a `Mutex`. The clone is cheap: the
    /// channel is a handle to the same shared connection (tonic: "cloning the
    /// `Channel` type is cheap and encouraged"), and the auth token in the
    /// interceptor is reference-counted. No new connection is opened.
    fn grpc_client(&self) -> SdkGeyserClient {
        self.shared_grpc_client.clone()
    }

    /// Current slot at the given commitment (server default when `None`).
    pub async fn get_slot(
        &self,
        commitment: Option<CommitmentLevel>,
    ) -> Result<GetSlotResponse, LaserstreamError> {
        let req = GetSlotRequest { commitment: commitment.map(|c| c as i32) };
        Ok(self.grpc_client().get_slot(req).await?.into_inner())
    }

    /// Current block height at the given commitment.
    pub async fn get_block_height(
        &self,
        commitment: Option<CommitmentLevel>,
    ) -> Result<GetBlockHeightResponse, LaserstreamError> {
        let req = GetBlockHeightRequest { commitment: commitment.map(|c| c as i32) };
        Ok(self.grpc_client().get_block_height(req).await?.into_inner())
    }

    /// Latest blockhash, its slot, and last valid block height.
    pub async fn get_latest_blockhash(
        &self,
        commitment: Option<CommitmentLevel>,
    ) -> Result<GetLatestBlockhashResponse, LaserstreamError> {
        let req = GetLatestBlockhashRequest { commitment: commitment.map(|c| c as i32) };
        Ok(self.grpc_client().get_latest_blockhash(req).await?.into_inner())
    }

    /// Whether `blockhash` (base58) is still valid.
    pub async fn is_blockhash_valid(
        &self,
        blockhash: impl Into<String>,
        commitment: Option<CommitmentLevel>,
    ) -> Result<IsBlockhashValidResponse, LaserstreamError> {
        let req = IsBlockhashValidRequest {
            blockhash: blockhash.into(),
            commitment: commitment.map(|c| c as i32),
        };
        Ok(self.grpc_client().is_blockhash_valid(req).await?.into_inner())
    }

    /// Server version info (JSON string).
    pub async fn get_version(&self) -> Result<GetVersionResponse, LaserstreamError> {
        Ok(self.grpc_client().get_version(GetVersionRequest {}).await?.into_inner())
    }

    /// Round-trip ping; the server echoes `count`.
    pub async fn ping(&self, count: i32) -> Result<PongResponse, LaserstreamError> {
        Ok(self.grpc_client().ping(PingRequest { count }).await?.into_inner())
    }

    /// Oldest slot this endpoint can replay from: the smallest usable
    /// `SubscribeRequest::from_slot` (`first_available` is `None` if the
    /// server reports no replay data).
    ///
    /// Call it right before subscribing with an explicit `from_slot` (the value
    /// moves forward as old data is evicted). A `from_slot` below it may not be
    /// servable, and the subscription can fail (e.g. `OUT_OF_RANGE`) instead of
    /// streaming. Clamp with `from_slot.max(first_available)` and treat the
    /// skipped slots as missed.
    ///
    /// It only reports this lower bound; it can't detect gaps in storage above
    /// it. Despite the name, this is a single request/response call, not a stream.
    pub async fn subscribe_replay_info(
        &self,
    ) -> Result<SubscribeReplayInfoResponse, LaserstreamError> {
        Ok(self
            .grpc_client()
            .subscribe_replay_info(SubscribeReplayInfoRequest {})
            .await?
            .into_inner())
    }
}
