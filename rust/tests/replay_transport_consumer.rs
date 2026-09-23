//! Driven by ../../test/replay-transport.js against a real loopback gRPC server.
use futures::StreamExt;
use helius_laserstream::{grpc::SubscribeRequest, subscribe, LaserstreamConfig};
use laserstream_core_proto::prost::Message;
use std::{env, time::Duration};

#[tokio::test]
#[ignore = "requires the cross-language replay transport harness"]
async fn replay_transport_consumer() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("helius_laserstream=debug")
        .with_writer(std::io::stderr)
        .try_init();
    let endpoint = env::var("SDK_REPLAY_ENDPOINT").unwrap();
    assert!(endpoint.starts_with("http://127.0.0.1:"));
    let config = LaserstreamConfig {
        endpoint,
        replay: env::var("SDK_REPLAY_ENABLED").unwrap() == "true",
        max_reconnect_attempts: Some(10),
        ..Default::default()
    };
    let request = SubscribeRequest {
        from_slot: match env::var("SDK_REPLAY_FROM_SLOT").unwrap().as_str() {
            "" => None,
            slot => Some(slot.parse().unwrap()),
        },
        ..Default::default()
    };
    let (stream, _handle) = subscribe(config, request);
    futures::pin_mut!(stream);
    tokio::time::timeout(Duration::from_secs(100), async {
        while let Some(update) = stream.next().await {
            let update = update.unwrap();
            if update.filters == ["__sdk_test_done"] {
                return;
            }
            let wire: String = update
                .encode_to_vec()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            println!("SDK_UPDATE {{\"hex\":\"{wire}\"}}");
        }
        panic!("stream ended before test barrier");
    })
    .await
    .expect("replay consumer deadline");
}
