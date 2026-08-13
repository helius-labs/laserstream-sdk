//! Regression vectors for V1 transaction config (SIMD-0385) and
//! Reward.commission_bps (SIMD-0291).
//!
//! The base64 payloads are SubscribeUpdate messages encoded with
//! laserstream-core-proto 11.2.0 — the same bytes are asserted against the
//! JS and Go SDKs, so all three decode identically.

use helius_laserstream::grpc::{subscribe_update::UpdateOneof, SubscribeUpdate};
// Use the prost version the proto types were generated with (re-exported by
// the core proto crate), not the SDK's own direct prost dependency.
use laserstream_core_proto::prost::Message as _;

/// SubscribeUpdate{transaction} whose message carries TransactionConfig
const V1_CONFIG_TX_B64: &str = "CgR2ZWMxIpUCCowCCkAHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHGsMBCkAHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHEn8KBAgBGAISIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBEiACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAhogCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkoAToPCJS05PTLAxDAuVUggIAQIgAoKhC72ZGsAQ==";
/// SubscribeUpdate{block} whose rewards carry commission_bps
const COMMISSION_BPS_BLOCK_B64: &str = "CgR2ZWMyKoYBCLzZkawBEgR0ZXN0GngKPgorVm90ZTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMRCIJxigjQYgBCoBNTIDNTUwCjYKK1N0YWtlMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEQj04YwJoMIAM=";

fn decode(b64: &str) -> SubscribeUpdate {
    let raw = b64_decode(b64);
    SubscribeUpdate::decode(raw.as_slice()).expect("decode SubscribeUpdate")
}

/// Minimal std-only base64 decode so the test needs no extra dev-dependency.
fn b64_decode(s: &str) -> Vec<u8> {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &c in s.as_bytes() {
        if c == b'=' {
            break;
        }
        let v = TABLE.iter().position(|&t| t == c).expect("valid base64") as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}

#[test]
fn v1_transaction_config_decodes() {
    let update = decode(V1_CONFIG_TX_B64);
    let Some(UpdateOneof::Transaction(tx)) = update.update_oneof else {
        panic!("expected transaction update");
    };
    assert_eq!(tx.slot, 361_000_123);

    let msg = tx
        .transaction
        .expect("tx info")
        .transaction
        .expect("tx")
        .message
        .expect("message");
    assert!(msg.versioned);

    let config = msg.config.expect("message.config present for V1");
    assert_eq!(config.priority_fee, Some(123_456_789_012));
    assert_eq!(config.compute_unit_limit, Some(1_400_000));
    assert_eq!(config.heap_size, Some(262_144));
    assert_eq!(config.loaded_accounts_data_size_limit, None);
}

#[test]
fn reward_commission_bps_decodes() {
    let update = decode(COMMISSION_BPS_BLOCK_B64);
    let Some(UpdateOneof::Block(block)) = update.update_oneof else {
        panic!("expected block update");
    };
    let rewards = block.rewards.expect("rewards").rewards;
    assert_eq!(rewards.len(), 2);

    assert_eq!(rewards[0].commission_bps, "550");
    assert_eq!(rewards[0].commission, "5");
    assert_eq!(rewards[0].reward_type, 4); // Voting

    // Reward without commission: empty string on the wire
    assert_eq!(rewards[1].commission_bps, "");
}
