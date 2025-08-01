use helius_laserstream::{
    subscribe, LaserstreamConfig, ChannelOptions, CompressionEncoding,
    grpc::{SubscribeRequest, SubscribeRequestFilterSlots}
};
use futures::StreamExt;
use std::collections::HashMap;
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();

    let endpoint = env::var("LASERSTREAM_PRODUCTION_ENDPOINT")
        .or_else(|_| env::var("LASERSTREAM_ENDPOINT"))
        .unwrap_or_else(|_| "".to_string());
    let api_key = env::var("LASERSTREAM_PRODUCTION_API_KEY")
        .or_else(|_| env::var("LASERSTREAM_API_KEY"))
        .expect("LASERSTREAM_PRODUCTION_API_KEY or LASERSTREAM_API_KEY environment variable must be set");

    // Custom channel options for optimal performance
    let channel_options = ChannelOptions {
        max_decoding_message_size: Some(1_000_000_000), // 1GB
        max_encoding_message_size: Some(100_000_000),   // 100MB
        http2_keep_alive_interval_secs: Some(30),       // 30 seconds
        keep_alive_timeout_secs: Some(10),              // 10 seconds
        keep_alive_while_idle: Some(true),
        initial_stream_window_size: Some(16_777_216),   // 16MB
        initial_connection_window_size: Some(33_554_432), // 32MB
        http2_adaptive_window: Some(true),
        tcp_nodelay: Some(true),
        tcp_keepalive_secs: Some(60),
        send_compression: Some(CompressionEncoding::Zstd),
        accept_compression: Some(vec![CompressionEncoding::Gzip, CompressionEncoding::Zstd]),
        ..Default::default()
    };

    // Create config with custom channel options
    let config = LaserstreamConfig::new(endpoint, api_key)
        .with_max_reconnect_attempts(5)
        .with_channel_options(channel_options);

    // Create a simple slot subscription request
    let mut slots_filter = HashMap::new();
    slots_filter.insert(
        "client".to_string(),
        SubscribeRequestFilterSlots::default(),
    );

    let request = SubscribeRequest {
        slots: slots_filter,
        ..Default::default()
    };

    println!("Subscribing with custom channel options...");
    println!("- Connect timeout: 20s");
    println!("- Max receive message size: 2GB");
    println!("- Keep-alive interval: 15s");
    println!("- Initial stream window: 8MB");

    let (stream, _handle) = subscribe(config, request);
    let mut stream = Box::pin(stream);

    while let Some(update) = stream.next().await {
        match update {
            Ok(update) => {
                println!("Received update: {:?}", update);
            }
            Err(e) => {
                eprintln!("Stream error: {:?}", e);
                break;
            }
        }
    }

    Ok(())
}