use futures::StreamExt;
use helius_laserstream::{
    grpc::{SubscribePreprocessedRequest, SubscribePreprocessedRequestFilterTransactions},
    subscribe_preprocessed, LaserstreamConfig,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    tracing_subscriber::fmt::init();

    // Load configuration from environment
    dotenv::dotenv().ok();
    let endpoint = "https://laserstream-mainnet-sgp.helius-rpc.com".to_string();
    let api_key = "".to_string();

    println!("Subscribing to preprocessed transactions...");
    // Create configuration
    let config = LaserstreamConfig {
        endpoint,
        api_key,
        ..Default::default()
    };

    // Create subscription request - filter out vote transactions
    let mut request = SubscribePreprocessedRequest::default();
    request.transactions.insert(
        "preprocessed-filter".to_string(),
        SubscribePreprocessedRequestFilterTransactions {
            vote: Some(false),
            ..Default::default()
        },
    );

    // Subscribe to preprocessed transactions
    let (stream, _handle) = subscribe_preprocessed(config, request);
    tokio::pin!(stream);

    println!("Successfully subscribed. Listening for preprocessed transactions...");
    println!("Press Ctrl+C to exit\n");

    // Process updates
    while let Some(result) = stream.next().await {
        match result {
            Ok(update) => {
                // Print the raw debug output
                println!("{:#?}", update);
            }
            Err(e) => {
                eprintln!("Stream error: {:?}", e);
                break;
            }
        }
    }

    Ok(())
}
