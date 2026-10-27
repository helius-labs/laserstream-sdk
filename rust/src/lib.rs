// RUSTSEC-2026-0258: direct dep holds the h2 >=0.4.19 floor; used only transitively.
use h2 as _;

pub mod client;
pub mod config;
pub mod error;
pub mod unary;

pub use client::{subscribe, subscribe_with_options, StreamHandle};
pub use unary::LaserstreamClient;
pub use config::{ChannelOptions, LaserstreamConfig, CompressionEncoding, SubscribeOptions};
pub use error::LaserstreamError;

// Re-export commonly used types from laserstream-core-proto, with the
// Alpenglow commitment surface exposed by this SDK.
pub mod grpc {
    pub use laserstream_core_proto::geyser::*;

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
    #[repr(i32)]
    pub enum CommitmentLevel {
        #[default]
        Processed = 0,
        Finalized = 2,
    }

    impl CommitmentLevel {
        pub fn is_valid(value: i32) -> bool {
            matches!(value, 0 | 2)
        }

        #[deprecated = "Use the TryFrom<i32> implementation instead"]
        pub fn from_i32(value: i32) -> Option<Self> {
            Self::try_from(value).ok()
        }

        pub fn as_str_name(&self) -> &'static str {
            match self {
                Self::Processed => "PROCESSED",
                Self::Finalized => "FINALIZED",
            }
        }

        pub fn from_str_name(value: &str) -> Option<Self> {
            match value {
                "PROCESSED" => Some(Self::Processed),
                "FINALIZED" => Some(Self::Finalized),
                _ => None,
            }
        }
    }

    impl From<CommitmentLevel> for i32 {
        fn from(value: CommitmentLevel) -> Self {
            value as i32
        }
    }

    impl TryFrom<i32> for CommitmentLevel {
        type Error = laserstream_core_proto::prost::UnknownEnumValue;

        fn try_from(value: i32) -> Result<Self, Self::Error> {
            match value {
                0 => Ok(Self::Processed),
                2 => Ok(Self::Finalized),
                _ => Err(laserstream_core_proto::prost::UnknownEnumValue(value)),
            }
        }
    }
}
pub use laserstream_core_proto::solana;

/// Compressed account (cuckoo) filtering.
///
/// Track large pubkey sets without re-uploading an explicit list every request:
/// build a compact cuckoo filter (~3 bytes/account) and let the server match
/// against it (no false negatives, <1% false positives — re-check locally with
/// [`CompressedAccountFilterSet::contains`]).
///
/// ```no_run
/// use helius_laserstream::cuckoo::{CompressedAccountFilterSet, Pubkey};
/// use helius_laserstream::grpc::SubscribeRequest;
/// # fn tracked_pubkeys() -> Vec<Pubkey> { vec![] }
/// # let new_pk = Pubkey::default();
/// let mut set = CompressedAccountFilterSet::with_capacity(2_000_000).unwrap();
/// for pk in tracked_pubkeys() { set.insert(pk).unwrap(); }
///
/// let mut req = SubscribeRequest::default();
/// set.insert_into_subscribe_request(&mut req, "tracked_accounts");
/// // ... subscribe(req) ...
///
/// // On change, mutate and re-send on the SAME stream:
/// set.insert(new_pk).unwrap();
/// if set.take_dirty() {
///     set.insert_into_subscribe_request(&mut req, "tracked_accounts");
///     // handle.write(req).await
/// }
/// ```
///
/// Also works on transaction subscriptions: put `set.to_proto()` on
/// `SubscribeRequestFilterTransactions.cuckoo_account_include` (see the
/// `cuckoo_transaction_filter` example).
#[cfg(feature = "cuckoo")]
pub mod cuckoo {
    pub use laserstream_core_proto::cuckoo::{
        CompressedAccountFilterSet, CuckooBuildError, CuckooFilter, DEFAULT_HASH_SEED,
        TableFullError, YellowstoneHasherBuilder,
    };
    // Re-exported so callers use the exact Pubkey version the filter API expects.
    pub use solana_pubkey::Pubkey;
}