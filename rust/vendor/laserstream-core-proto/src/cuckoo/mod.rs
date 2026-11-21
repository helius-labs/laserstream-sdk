//! Compressed account filtering via cuckoo filters.
//!
//! For clients tracking large pubkey sets (100k–millions): instead of re-uploading an
//! explicit pubkey list, the client uploads a compact cuckoo filter (~3 bytes/pubkey at
//! 95% load) and the server matches accounts against it.
//!
//! - [`CompressedAccountFilterSet`] — safe, tracked client-side builder (`convert` feature).
//! - [`CuckooFilter`] — raw filter for server-side matching; has a `remove` footgun, so
//!   clients should prefer [`CompressedAccountFilterSet`].
//!
//! Server-side matching accepts <1% false positives; clients re-check locally with
//! [`CompressedAccountFilterSet::contains`].

mod constants;
mod error;
mod filter;
mod hasher;
// Client-side builder; needs `solana-pubkey` via the `convert` feature. Server uses only the raw filter.
#[cfg(feature = "convert")]
mod set;

#[cfg(feature = "convert")]
pub use set::CompressedAccountFilterSet;
pub use {
    constants::DEFAULT_HASH_SEED,
    error::{CuckooBuildError, TableFullError},
    filter::CuckooFilter,
    hasher::YellowstoneHasherBuilder,
};
