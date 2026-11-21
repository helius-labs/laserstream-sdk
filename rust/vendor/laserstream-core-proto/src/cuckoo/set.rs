//! Safe, tracked wrapper around [`CuckooFilter`] for client-side filter construction.
//!
//! [`CompressedAccountFilterSet`] keeps an exact [`HashSet`] alongside the probabilistic
//! filter, so `remove` is safe (never evicts a fingerprint-colliding item) and `contains`
//! is exact. The cuckoo filter is used only on the wire; the server accepts false positives
//! and clients filter locally on receipt.
//!
//! [`HashSet`]: std::collections::HashSet

use {
    super::{
        error::{CuckooBuildError, TableFullError},
        filter::CuckooFilter,
    },
    crate::geyser::{
        CuckooFilter as ProtoCuckooFilter, SubscribeRequest, SubscribeRequestFilterAccounts,
    },
    solana_pubkey::Pubkey,
    std::collections::HashSet,
};

/// Safe builder for cuckoo filters sent in subscribe requests.
///
/// Holds two parallel collections: a [`HashSet`] (exact source of truth for `contains`/`len`
/// and the guard for writes) and a [`CuckooFilter`] (compact wire form). Writes go to both;
/// serialization reads the filter. Strictly safer than a raw [`CuckooFilter`], whose `remove`
/// can silently evict the wrong fingerprint-colliding item.
///
/// [`HashSet`]: std::collections::HashSet
pub struct CompressedAccountFilterSet {
    items: HashSet<[u8; 32]>,
    filter: CuckooFilter<[u8; 32]>,
    dirty: bool,
}

impl CompressedAccountFilterSet {
    /// Empty map pre-sized for `max_capacity` items (both the `HashSet` and filter are
    /// allocated up front). Errors [`CuckooBuildError::CapacityOverflow`] if it can't be allocated.
    pub fn with_capacity(max_capacity: usize) -> Result<Self, CuckooBuildError> {
        let filter = CuckooFilter::with_capacity(max_capacity)?;

        let mut items: HashSet<[u8; 32]> = HashSet::new();
        items
            .try_reserve(max_capacity)
            .map_err(|_| CuckooBuildError::CapacityOverflow)?;

        Ok(Self {
            items,
            filter,
            dirty: false,
        })
    }

    /// Inserts a key. `Ok(true)` if newly added, `Ok(false)` if already present (idempotent).
    /// Errors [`TableFullError`] if the filter is saturated (map under-sized); state is
    /// unchanged on error.
    pub fn insert(&mut self, key: Pubkey) -> Result<bool, TableFullError> {
        let bytes = key.to_bytes();

        if self.items.contains(&bytes) {
            return Ok(false);
        }
        self.filter.insert(&bytes)?;
        self.items.insert(bytes);
        self.dirty = true;
        Ok(true)
    }

    /// Removes a key; returns whether it was present. Safe unlike [`CuckooFilter::remove`]:
    /// checks the `HashSet` first and only touches the filter when the key genuinely exists.
    pub fn remove(&mut self, key: Pubkey) -> bool {
        let bytes = key.to_bytes();

        if self.items.remove(&bytes) {
            self.filter.remove(&bytes);
            self.dirty = true;
            true
        } else {
            false
        }
    }

    /// Exact membership (from the `HashSet`, no false positives), unlike [`CuckooFilter::contains`].
    pub fn contains(&self, key: Pubkey) -> bool {
        self.items.contains(&key.to_bytes())
    }

    /// Returns the number of items in the map.
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// Items the map can hold without reallocating (≥ the `with_capacity` argument; the
    /// `HashSet` rounds up). Useful for headroom checks before a batch of inserts.
    pub fn capacity(&self) -> usize {
        self.items.capacity()
    }

    /// Iterates items in arbitrary `HashSet` order (no ordering guarantee).
    pub fn iter(&self) -> impl Iterator<Item = &[u8; 32]> {
        self.items.iter()
    }

    /// Returns `true` if the map contains no items.
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// `true` if mutated since the last [`take_dirty`](Self::take_dirty) (or construction);
    /// does not clear the flag.
    pub const fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Returns the dirty flag and clears it. Call when transmitting: `true` → rebuild and send.
    pub const fn take_dirty(&mut self) -> bool {
        let dirty = self.dirty;
        self.dirty = false;
        dirty
    }

    /// Serializes the cuckoo filter to proto wire format (carries bucket geometry + hash seed).
    pub fn to_proto(&self) -> ProtoCuckooFilter {
        ProtoCuckooFilter::from(&self.filter)
    }

    /// A `SubscribeRequestFilterAccounts` carrying only this cuckoo filter (no account list,
    /// owner, or predicates) — add it to a request under a name of your choosing.
    pub fn to_account_filter(&self) -> SubscribeRequestFilterAccounts {
        SubscribeRequestFilterAccounts {
            account: vec![],
            owner: vec![],
            filters: vec![],
            nonempty_txn_signature: None,
            cuckoo_accounts_filter: Some(self.to_proto()),
        }
    }

    /// Inserts this filter into `req.accounts` under `name` (replacing any existing entry,
    /// preserving others) and marks the map clean.
    pub fn insert_into_subscribe_request(&mut self, req: &mut SubscribeRequest, name: &str) {
        req.accounts
            .insert(name.to_string(), self.to_account_filter());
        self.dirty = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // helper: a 32-byte key from a single seed byte
    fn key(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    #[test]
    fn basic_insert_contains() {
        let mut filter = CompressedAccountFilterSet::with_capacity(100).unwrap();
        assert!(filter.insert(key(1)).unwrap());
        assert!(filter.contains(key(1)));
        assert!(!filter.contains(key(2)));
    }

    #[test]
    fn insert_duplicate_returns_false() {
        let mut filter = CompressedAccountFilterSet::with_capacity(100).unwrap();
        assert!(filter.insert(key(1)).unwrap());
        assert!(!filter.insert(key(1)).unwrap());
    }

    #[test]
    fn remove_existing() {
        let mut filter = CompressedAccountFilterSet::with_capacity(100).unwrap();
        filter.insert(key(1)).unwrap();
        assert!(filter.remove(key(1)));
        assert!(!filter.contains(key(1)));
    }

    #[test]
    fn remove_nonexistent_is_safe() {
        let mut filter = CompressedAccountFilterSet::with_capacity(100).unwrap();
        filter.insert(key(1)).unwrap();

        assert!(!filter.remove(key(2)));
        assert!(filter.contains(key(1)));
    }

    #[test]
    fn len_and_is_empty() {
        let mut filter = CompressedAccountFilterSet::with_capacity(100).unwrap();
        assert!(filter.is_empty());
        assert_eq!(filter.len(), 0);

        filter.insert(key(1)).unwrap();
        filter.insert(key(2)).unwrap();
        assert!(!filter.is_empty());
        assert_eq!(filter.len(), 2);

        filter.remove(key(1));
        assert_eq!(filter.len(), 1);
    }

    #[test]
    fn to_proto_round_trip() {
        let mut filter = CompressedAccountFilterSet::with_capacity(100).unwrap();
        filter.insert(key(1)).unwrap();
        filter.insert(key(2)).unwrap();

        let proto = filter.to_proto();
        assert!(!proto.data.is_empty());
        assert!(proto.bucket_count > 0);
    }

    #[test]
    fn to_account_filter_carries_cuckoo_and_no_other_matchers() {
        let mut filter = CompressedAccountFilterSet::with_capacity(100).unwrap();
        filter.insert(key(1)).unwrap();

        let f = filter.to_account_filter();

        assert!(f.cuckoo_accounts_filter.is_some());
        assert!(f.account.is_empty());
        assert!(f.owner.is_empty());
        assert!(f.filters.is_empty());
        assert_eq!(f.nonempty_txn_signature, None);
    }

    #[test]
    fn insert_into_subscribe_request_uses_given_name_and_preserves_other_filters() {
        let mut filter = CompressedAccountFilterSet::with_capacity(100).unwrap();
        filter.insert(key(1)).unwrap();

        let mut req = SubscribeRequest::default();
        req.accounts.insert(
            "pre_existing".to_string(),
            SubscribeRequestFilterAccounts::default(),
        );

        filter.insert_into_subscribe_request(&mut req, "tracked_accounts");

        assert!(req.accounts.contains_key("tracked_accounts"));
        assert!(req.accounts.contains_key("pre_existing"));
        assert_eq!(req.accounts.len(), 2);
        assert!(req
            .accounts
            .get("tracked_accounts")
            .unwrap()
            .cuckoo_accounts_filter
            .is_some());
    }

    #[test]
    fn insert_into_subscribe_request_clears_dirty_flag() {
        let mut filter = CompressedAccountFilterSet::with_capacity(100).unwrap();
        filter.insert(key(1)).unwrap();
        assert!(filter.is_dirty());

        let mut req = SubscribeRequest::default();
        filter.insert_into_subscribe_request(&mut req, "accounts");

        assert!(!filter.is_dirty());
    }

    #[test]
    fn pubkey_like_usage() {
        let mut filter = CompressedAccountFilterSet::with_capacity(1000).unwrap();

        for i in 0..100u8 {
            filter.insert(key(i)).unwrap();
        }

        assert_eq!(filter.len(), 100);

        for i in 0..100u8 {
            assert!(filter.contains(key(i)));
        }

        assert!(!filter.contains(key(255)));
    }

    #[test]
    fn capacity_overflow() {
        let result = CompressedAccountFilterSet::with_capacity(usize::MAX);
        assert!(matches!(result, Err(CuckooBuildError::CapacityOverflow)));
    }
}
