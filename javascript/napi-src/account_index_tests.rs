use super::subscribe_update_to_bytes;
use laserstream_core_proto::{
    geyser::{subscribe_update::UpdateOneof, AccountTransactionIndex, SubscribeUpdate},
    prost::Message,
};

#[test]
fn account_index_native_reencoding_preserves_scalar32() {
    for (info, expected) in [
        (vec![], 0),
        (vec![0x80, 2, 0], 0),
        (vec![0x80, 2, 42], 42),
        (
            vec![0x80, 2, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1],
            u64::MAX,
        ),
        (
            vec![0x80, 2, 254, 255, 255, 255, 255, 255, 255, 255, 255, 1],
            u64::MAX - 1,
        ),
    ] {
        for block in [false, true] {
            let mut nested = vec![if block { 0x5a } else { 0x0a }, info.len() as u8];
            nested.extend_from_slice(&info);
            let mut wire = vec![if block { 0x2a } else { 0x12 }, nested.len() as u8];
            wire.extend(nested);
            let update = SubscribeUpdate::decode(wire.as_slice()).unwrap();
            let encoded = subscribe_update_to_bytes(update).unwrap();
            let decoded = SubscribeUpdate::decode(encoded.as_slice()).unwrap();
            let account = match decoded.update_oneof.unwrap() {
                UpdateOneof::Account(a) => a.account.unwrap(),
                UpdateOneof::Block(b) => b.accounts[0].clone(),
                _ => panic!("account expected"),
            };
            assert_eq!(
                account.account_transaction_index(),
                AccountTransactionIndex::from_wire(expected)
            );
            // Proto3 canonical encoding omits explicit scalar zero.
            if expected != 0 {
                assert_eq!(encoded, wire);
            }
        }
    }
}
