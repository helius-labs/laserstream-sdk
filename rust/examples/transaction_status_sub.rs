use helius_laserstream::{subscribe, LaserstreamConfig};
use yellowstone_grpc_proto::geyser::{SubscribeRequest, SubscribeRequestFilterTransactions};
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
    
    request.transactions_status.insert(
        "all".to_string(),
        SubscribeRequestFilterTransactions {
            vote: Some(false),
            ..Default::default()
        },
    );

    let (stream, _handle) = subscribe(config, request);
    tokio::pin!(stream);

    let mut count = 0;
    while let Some(result) = stream.next().await {
        match result {
            Ok(update) => {
                println!("{:?}", update);
                count += 1;
                if count >= 10 {
                    break;
                }
            }
            Err(e) => {
                eprintln!("Error: {:?}", e);
                break;
            }
        }
    }

    Ok(())
}
