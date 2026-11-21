/// Slots per bucket.
pub(crate) const ENTRIES_PER_BUCKET: usize = 4;

/// Target load factor. 95% occupancy is achievable with 4 entries/bucket.
pub(crate) const LOAD_FACTOR: f64 = 0.95;

/// Maximum relocations before declaring table full.
pub(crate) const MAX_KICKS: usize = 500;

/// Fingerprint width. 16 bits → ~0.01% false-positive rate (2·entries/2^16).
pub(crate) const FINGERPRINT_BITS: u32 = 16;

/// Default SipHash seed (ASCII "yllwstn!"). The seed in use is always serialized into the
/// proto `hash_seed`, so filters built with it stay readable even if this default changes.
pub const DEFAULT_HASH_SEED: u64 = 0x_796c_6c77_7374_6e21;
