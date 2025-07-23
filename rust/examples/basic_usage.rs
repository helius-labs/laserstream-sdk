use futures_util::StreamExt;
use helius_laserstream::{
    grpc::{
        SubscribeRequest,
        SubscribeRequestFilterTransactions,
    },
    subscribe, LaserstreamConfig,
};
use std::collections::HashMap;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load .env file from root directory
    dotenv::from_path("../.env").ok();
    

    let api_key = String::from("");
    let endpoint_url = String::from("");

    let config = LaserstreamConfig {
        api_key,
        endpoint: endpoint_url.parse()?,
        ..Default::default()
    };

    // --- Subscription Request ---
    // Subscribe to all confirmed non-vote transactions involving the Token program
    let mut token_transactions_filter = HashMap::new();
    token_transactions_filter.insert(
        "client".to_string(), 
        SubscribeRequestFilterTransactions {
            account_include: vec!["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".to_string()],
            vote: Some(false),
            failed: Some(false),
            ..Default::default()
        },
    );

    let request = SubscribeRequest {
        transactions: token_transactions_filter,
        ..Default::default()
    };

    // --- Subscribe and Process ---
    println!("Connecting and subscribing...");
    let (stream, _handle) = subscribe(config, request);

    // Pin the stream to the stack
    futures::pin_mut!(stream);

    while let Some(result) = stream.next().await {
        match result {
            Ok(update) => {
                // Simple printing for the example
                println!("Received update: {:?}", update);
            }
            Err(e) => {
                eprintln!("Stream error: {}", e);
            }
        }
    }

    println!("Stream finished.");
    Ok(())
}
