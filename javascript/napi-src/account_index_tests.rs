use super::subscribe_update_to_bytes;
use laserstream_core_proto::{geyser::SubscribeUpdate, prost::Message};

#[test]
fn account_index_native_reencoding_preserves_wire_presence() {
    for info in [
        vec![],
        vec![0x48, 0],
        vec![0x48, 42],
        vec![0x48, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1],
    ] {
        for block in [false, true] {
            let mut nested = vec![if block { 0x5a } else { 0x0a }, info.len() as u8];
            nested.extend_from_slice(&info);
            let mut wire = vec![if block { 0x2a } else { 0x12 }, nested.len() as u8];
            wire.extend(nested);
            let update = SubscribeUpdate::decode(wire.as_slice()).unwrap();
            // Exercise the native helper used to pass generated messages back to JS.
            assert_eq!(subscribe_update_to_bytes(update).unwrap(), wire);
        }
    }
}
