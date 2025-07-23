use helius_laserstream::{subscribe, LaserstreamConfig, ChannelOptions, grpc::{SubscribeRequest, SubscribeRequestFilterSlots}};
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

    // Configure compression options - use the convenient helper method
    let channel_options = ChannelOptions::default()
        .with_zstd_compression();  // This sets zstd for sending and accepts both zstd and gzip

    let config = LaserstreamConfig::new(endpoint, api_key)
        .with_channel_options(channel_options);
    
    let mut request = SubscribeRequest::default();
    request.slots.insert(
        "compressed-slots".to_string(),
        SubscribeRequestFilterSlots::default()
    );

    println!("Starting stream with zstd compression...");
    let (stream, _handle) = subscribe(config, request);
    tokio::pin!(stream);

    let mut count = 0;
    while let Some(result) = stream.next().await {
        match result {
            Ok(update) => {
                if matches!(update.update_oneof, Some(helius_laserstream::grpc::subscribe_update::UpdateOneof::Slot(_))) {
                    println!("Received slot update #{}: slot={:?}", count + 1, 
                        update.update_oneof.as_ref().map(|u| match u {
                            helius_laserstream::grpc::subscribe_update::UpdateOneof::Slot(s) => s.slot,
                            _ => 0
                        }).unwrap_or(0)
                    );
                    count += 1;
                    if count >= 10 {
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

    println!("Received {} compressed slot updates", count);
    Ok(())
}