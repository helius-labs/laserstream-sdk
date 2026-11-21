//! Stable, wire-compatible hasher for the cuckoo filter: SipHash-2-4 with the seed carried
//! on the wire, so client and server (possibly different languages/Rust versions) hash
//! identically. std's `DefaultHasher` is implementation-defined and can't be relied on here.

use {siphasher::sip::SipHasher24, std::hash::BuildHasher};

/// Deterministic `BuildHasher` backed by SipHash-2-4 (stable + cross-language, unlike
/// `std::hash::DefaultHasher`). The seed is serialized to the proto `hash_seed` so the
/// receiver reconstructs a matching hasher. Default `S` for `CuckooFilter`.
#[derive(Debug, Clone)]
pub struct YellowstoneHasherBuilder {
    seed: u64,
}

impl YellowstoneHasherBuilder {
    /// Builds a hasher with `seed`. Prefer `default()` (uses `DEFAULT_HASH_SEED`) unless
    /// reconstructing from a wire seed or pairing with a peer's chosen seed.
    pub const fn new(seed: u64) -> Self {
        Self { seed }
    }

    /// The seed this builder hashes with (serialized to the proto `hash_seed`).
    pub const fn seed(&self) -> u64 {
        self.seed
    }

    /// SipHash-2-4 takes two 64-bit keys; we carry one seed on the wire and derive
    /// `(k0, k1) = (seed, seed.rotate_left(32))`. This derivation is part of the wire
    /// contract — peers must match it, and changing it breaks every serialized filter.
    pub(crate) const fn keys_from_seed(seed: u64) -> (u64, u64) {
        (seed, seed.rotate_left(32))
    }
}

impl Default for YellowstoneHasherBuilder {
    fn default() -> Self {
        Self::new(super::constants::DEFAULT_HASH_SEED)
    }
}

impl BuildHasher for YellowstoneHasherBuilder {
    type Hasher = SipHasher24;

    fn build_hasher(&self) -> SipHasher24 {
        let (k0, k1) = Self::keys_from_seed(self.seed);
        SipHasher24::new_with_keys(k0, k1)
    }
}
