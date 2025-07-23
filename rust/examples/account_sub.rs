use helius_laserstream::{subscribe, LaserstreamConfig};
use yellowstone_grpc_proto::geyser::{SubscribeRequest, SubscribeRequestFilterAccounts};
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

    let config = LaserstreamConfig::new(endpoint, api_key);
    let mut request = SubscribeRequest::default();
    
    request.accounts.insert(
        "usdc".to_string(),
        SubscribeRequestFilterAccounts {
            account: vec!["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string()],
            nonempty_txn_signature: Some(true),
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