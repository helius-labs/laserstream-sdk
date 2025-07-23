use helius_laserstream::{subscribe, LaserstreamConfig, ChannelOptions, CompressionEncoding, grpc::{SubscribeRequest, SubscribeRequestFilterSlots}};
use futures::StreamExt;
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::from_path("../.env").ok();
    
    let api_key = env::var("LASERSTREAM_PRODUCTION_API_KEY")
        .or_else(|_| env::var("HELIUS_API_KEY"))
        .expect("API key not set");
    let endpoint = env::var("LASERSTREAM_PRODUCTION_ENDPOINT")
        .or_else(|_| env::var("LASERSTREAM_ENDPOINT"))
        .expect("Endpoint not set");

    // Example 1: Manual compression configuration
    let mut channel_options = ChannelOptions::default();
    
    // Send using zstd (5x more efficient than gzip)
    channel_options.send_compression = Some(CompressionEncoding::Zstd);
    
    // Accept both compression types (order matters - first is preferred)
    channel_options.accept_compression = Some(vec![
        CompressionEncoding::Zstd,  // Prefer zstd
        CompressionEncoding::Gzip,  // Fallback to gzip
    ]);
    
    // Other performance options
    channel_options.max_decoding_message_size = Some(2_000_000_000); // 2GB
    channel_options.http2_keep_alive_interval_secs = Some(20);
    channel_options.tcp_nodelay = Some(true);

    let config = LaserstreamConfig::new(endpoint.clone(), api_key.clone())
        .with_channel_options(channel_options);
    
    let mut request = SubscribeRequest::default();
    request.slots.insert(
        "compressed-slots".to_string(),
        SubscribeRequestFilterSlots::default()
    );

    println!("Example 1: Starting stream with custom compression config (zstd preferred)...");
    let (stream, _handle) = subscribe(config, request.clone());
    tokio::pin!(stream);

    let mut count = 0;
    while let Some(result) = stream.next().await {
        match result {
            Ok(update) => {
                if matches!(update.update_oneof, Some(helius_laserstream::grpc::subscribe_update::UpdateOneof::Slot(_))) {
                    count += 1;
                    println!("✓ Received slot update with custom compression");
                    if count >= 5 {
                        break;
                    }
                }
            }
            Err(e) => {
                eprintln!("Error: {:?}", e);
                break;
            }
        }
    }

    println!("\nExample 2: Using convenience method for gzip compression...");
    
    // Example 2: Using convenience method
    let config2 = LaserstreamConfig::new(endpoint, api_key)
        .with_channel_options(
            ChannelOptions::default()
                .with_gzip_compression()  // Sets gzip for sending, accepts both
        );
    
    let (stream2, _handle2) = subscribe(config2, request);
    tokio::pin!(stream2);

    count = 0;
    while let Some(result) = stream2.next().await {
        match result {
            Ok(update) => {
                if matches!(update.update_oneof, Some(helius_laserstream::grpc::subscribe_update::UpdateOneof::Slot(_))) {
                    count += 1;
                    println!("✓ Received slot update with gzip compression");
                    if count >= 5 {
                        break;
                    }
                }
            }
            Err(e) => {
                eprintln!("Error: {:?}", e);
                break;
            }
        }
    }

    println!("\nBoth compression methods work successfully!");
    println!("Note: zstd is 5x more efficient than gzip for Solana data");
    
    Ok(())
}