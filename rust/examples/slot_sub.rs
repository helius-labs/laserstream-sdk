use helius_laserstream::{subscribe, LaserstreamConfig};
use yellowstone_grpc_proto::geyser::{SubscribeRequest, SubscribeRequestFilterSlots};
use futures::StreamExt;
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load .env file from root directory
    dotenv::from_path("../.env").ok();
    
    // Load environment variables
    let api_key = env::var("LASERSTREAM_PRODUCTION_API_KEY")
        .or_else(|_| env::var("HELIUS_API_KEY"))
        .expect("LASERSTREAM_PRODUCTION_API_KEY or HELIUS_API_KEY not set");
    let endpoint = env::var("LASERSTREAM_PRODUCTION_ENDPOINT")
        .or_else(|_| env::var("LASERSTREAM_ENDPOINT"))
        .expect("LASERSTREAM_PRODUCTION_ENDPOINT or LASERSTREAM_ENDPOINT not set");

    // Create configuration
    let config = LaserstreamConfig::new(endpoint, api_key);

    // Create slot subscription request
    let mut request = SubscribeRequest::default();
    request.slots.insert(
        "slot-subscription".to_string(),
        SubscribeRequestFilterSlots {
            filter_by_commitment: Some(true),
            ..Default::default()
        },
    );

    let (stream, _handle) = subscribe(config, request);
    tokio::pin!(stream);

    while let Some(result) = stream.next().await {
        match result {
            Ok(update) => {
                println!("{:?}", update);
            }
            Err(e) => {
                eprintln!("Error: {:?}", e);
                break;
            }
        }
    }

    Ok(())
}