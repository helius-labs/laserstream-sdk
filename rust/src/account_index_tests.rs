use crate::grpc::{
    subscribe_update::UpdateOneof, AccountTransactionIndex, SubscribeUpdate,
    SubscribeUpdateAccountInfo,
};
use laserstream_core_proto::prost::Message;
use prost::Message as _;

#[test]
fn scalar32_independent_wire_and_legacy_schema() {
    // Independent bytes for all eight original fields, then field 32.
    let old = vec![
        0x0a, 1, 1, 0x10, 7, 0x1a, 1, 2, 0x20, 1, 0x28, 8, 0x32, 1, 3, 0x38, 9, 0x42, 1, 4,
    ];
    for (suffix, value) in [
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
        let info = [old.clone(), suffix].concat();
        let expected = AccountTransactionIndex::from_wire(value);
        let mut raw = SubscribeUpdateAccountInfo::decode(info.as_slice()).unwrap();
        assert_eq!(raw.account_transaction_index(), expected);
        raw.set_account_transaction_index(expected).unwrap();
        assert_eq!(raw.transaction_index, value);
        assert!(raw
            .set_account_transaction_index(AccountTransactionIndex::Transaction(u64::MAX))
            .is_err());
        assert_eq!(raw.transaction_index, value);
        for block in [false, true] {
            let inner = [
                vec![if block { 0x5a } else { 0x0a }, info.len() as u8],
                info.clone(),
            ]
            .concat();
            let wire = [
                vec![if block { 0x2a } else { 0x12 }, inner.len() as u8],
                inner,
            ]
            .concat();
            let decoded = SubscribeUpdate::decode(wire.as_slice()).unwrap();
            let account = match decoded.update_oneof.unwrap() {
                UpdateOneof::Account(a) => a.account.unwrap(),
                UpdateOneof::Block(b) => b.accounts[0].clone(),
                _ => panic!("wrong update"),
            };
            assert_eq!(account.account_transaction_index(), expected);
            let legacy = LegacyAccount::decode(account.encode_to_vec().as_slice()).unwrap();
            assert_eq!(legacy.encode_to_vec(), old);
            let roundtrip =
                SubscribeUpdateAccountInfo::decode(account.encode_to_vec().as_slice()).unwrap();
            assert_eq!(roundtrip, account);
        }
    }
}

// The pre-feature account schema: all original fields with their original tags.
#[derive(Clone, PartialEq, prost::Message)]
struct LegacyAccount {
    #[prost(bytes = "vec", tag = "1")]
    pubkey: Vec<u8>,
    #[prost(uint64, tag = "2")]
    lamports: u64,
    #[prost(bytes = "vec", tag = "3")]
    owner: Vec<u8>,
    #[prost(bool, tag = "4")]
    executable: bool,
    #[prost(uint64, tag = "5")]
    rent_epoch: u64,
    #[prost(bytes = "vec", tag = "6")]
    data: Vec<u8>,
    #[prost(uint64, tag = "7")]
    write_version: u64,
    #[prost(bytes = "vec", optional, tag = "8")]
    txn_signature: Option<Vec<u8>>,
}
