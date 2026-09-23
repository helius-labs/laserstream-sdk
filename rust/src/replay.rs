use laserstream_core_proto::{
    geyser::{subscribe_update::UpdateOneof, SubscribeUpdate},
    prost::Message,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

// Retain the processed reconnect window, inclusive. Never discard an unseen
// update just because its bank was seen, or wait for a completed block.
#[derive(Default)]
pub(crate) struct ReplayDedup {
    newest_slot: u64,
    seen: BTreeMap<u64, HashMap<[u8; 32], Occurrences>>,
}

#[derive(Default)]
struct Occurrences {
    delivered: u64,
    observed: u64,
}

pub(crate) fn update_slot(update: &SubscribeUpdate) -> Option<u64> {
    Some(match update.update_oneof.as_ref()? {
        UpdateOneof::Account(v) => v.slot,
        UpdateOneof::Slot(v) => v.slot,
        UpdateOneof::Transaction(v) => v.slot,
        UpdateOneof::TransactionStatus(v) => v.slot,
        UpdateOneof::Block(v) => v.slot,
        UpdateOneof::BlockMeta(v) => v.slot,
        UpdateOneof::Entry(v) => v.slot,
        _ => return None,
    })
}

impl ReplayDedup {
    pub(crate) fn begin_connection(&mut self) {
        for updates in self.seen.values_mut() {
            for count in updates.values_mut() {
                count.observed = 0;
            }
        }
    }

    pub(crate) fn duplicate(&mut self, update: &SubscribeUpdate) -> bool {
        let Some(slot) = update_slot(update) else {
            return false;
        };
        self.newest_slot = self.newest_slot.max(slot);
        let oldest = self.newest_slot.saturating_sub(31);
        self.seen = self.seen.split_off(&oldest);
        if slot < oldest {
            return false;
        }

        // Optional absence and scalar zero retain legacy delivery. A scalar
        // omission aliases zero, so it cannot establish a bank identity.
        let (kind, payload) = match update.update_oneof.as_ref().unwrap() {
            UpdateOneof::Account(v) if v.bank_id.is_some() => {
                // Native writes have no transaction-owned position. Preserve the
                // existing delivery contract instead of guessing which write a
                // mid-bank subscriber already received. Ingest dedup is separate.
                if v.account.as_ref().is_none_or(|a| {
                    a.txn_signature
                        .as_ref()
                        .is_none_or(|signature| signature.is_empty())
                }) {
                    return false;
                }
                let mut identity = v.clone();
                if let Some(account) = &mut identity.account {
                    account.write_version = 0;
                }
                (2, identity.encode_to_vec())
            }
            UpdateOneof::Slot(v) if v.bank_id.is_some() => (3, v.encode_to_vec()),
            UpdateOneof::Transaction(v) if v.bank_id != 0 => (4, v.encode_to_vec()),
            UpdateOneof::Block(v) if v.bank_id != 0 => {
                let mut identity = v.clone();
                for account in &mut identity.accounts {
                    account.write_version = 0;
                }
                // Block account assembly can follow worker callback order.
                identity.accounts.sort_by_cached_key(|a| a.encode_to_vec());
                (5, identity.encode_to_vec())
            }
            UpdateOneof::BlockMeta(v) if v.bank_id != 0 => (7, v.encode_to_vec()),
            UpdateOneof::Entry(v) if v.bank_id != 0 => (8, v.encode_to_vec()),
            UpdateOneof::TransactionStatus(v) if v.bank_id != 0 => (10, v.encode_to_vec()),
            _ => return false,
        };
        // Retain bank, canonical transaction/entry indices, account pubkey and
        // semantic content, but never worker-local write_version or timestamps.
        let mut digest = Sha256::new();
        digest.update([kind]);
        digest.update(payload);
        let mut filters = update.filters.iter().collect::<Vec<_>>();
        filters.sort_unstable();
        for filter in filters {
            digest.update((filter.len() as u64).to_le_bytes());
            digest.update(filter.as_bytes());
        }
        let count = self
            .seen
            .entry(slot)
            .or_default()
            .entry(digest.finalize().into())
            .or_default();
        // Preserve repeated notifications within one connection while removing
        // their replay overlap. Native account writes bypass this state.
        count.observed += 1;
        if count.observed <= count.delivered {
            true
        } else {
            count.delivered = count.observed;
            false
        }
    }
}
