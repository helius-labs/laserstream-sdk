use helius_laserstream::{subscribe, ChannelOptions, LaserstreamConfig, SubscribeRequest, SubscribeRequestFilterSlots};
use futures::StreamExt;
use std::collections::HashMap;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let endpoint = std::env::var("LASERSTREAM_PRODUCTION_ENDPOINT")
        .unwrap_or_else(|_| "".to_string());
    let api_key = std::env::var("LASERSTREAM_PRODUCTION_API_KEY")
        .expect("LASERSTREAM_PRODUCTION_API_KEY environment variable must be set");

    // Create custom channel options
    let channel_options = ChannelOptions {
        // Connection timeouts
        connect_timeout_secs: Some(20),              // 20 seconds instead of default 10
        timeout_secs: Some(60),                      // 60 seconds instead of default 30
        
        // Message size limits
        max_decoding_message_size: Some(2_000_000_000),  // 2GB instead of default 1GB
        max_encoding_message_size: Some(64_000_000),     // 64MB instead of default 32MB
        
        // Keep-alive settings
        http2_keep_alive_interval_secs: Some(15),   // 15 seconds instead of default 30
        keep_alive_timeout_secs: Some(10),           // 10 seconds instead of default 5
        keep_alive_while_idle: Some(true),
        
        // Window sizes for flow control
        initial_stream_window_size: Some(8 * 1024 * 1024),      // 8MB instead of default 4MB
        initial_connection_window_size: Some(16 * 1024 * 1024), // 16MB instead of default 8MB
        
        // Performance options
        http2_adaptive_window: Some(true),
        tcp_nodelay: Some(true),
        tcp_keepalive_secs: Some(30),               // 30 seconds instead of default 60
        buffer_size: Some(128 * 1024),               // 128KB instead of default 64KB
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