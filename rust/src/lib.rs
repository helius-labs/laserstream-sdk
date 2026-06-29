pub mod client;
pub mod config;
pub mod error;

pub use client::{subscribe, subscribe_preprocessed, StreamHandle, PreprocessedStreamHandle};
pub use config::{ChannelOptions, LaserstreamConfig, CompressionEncoding};
pub use error::LaserstreamError;

// Re-export commonly used types from laserstream-core-proto
pub use laserstream_core_proto::geyser as grpc;
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