//! Cuckoo module errors. `Display`/`Error` are hand-written rather than via `thiserror`
//! (an optional dep of this crate; the cuckoo module is always compiled).

use {super::constants::MAX_KICKS, std::fmt};

/// `with_capacity` failure: capacity can't be allocated (next-pow2 bucket count overflows, or OOM).
#[derive(Debug, PartialEq, Eq)]
pub enum CuckooBuildError {
    CapacityOverflow,
}

impl fmt::Display for CuckooBuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CapacityOverflow => {
                f.write_str("capacity overflow: requested capacity exceeds maximum")
            }
        }
    }
}

impl std::error::Error for CuckooBuildError {}

/// `insert` failure: filter full — couldn't relocate a fingerprint after `MAX_KICKS` kicks
/// (typically under-sized). The inserting type's state is unchanged on error.
#[derive(Debug, PartialEq, Eq)]
pub struct TableFullError;

impl fmt::Display for TableFullError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "cuckoo table full after {MAX_KICKS} kicks")
    }
}

impl std::error::Error for TableFullError {}
