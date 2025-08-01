use helius_laserstream::{subscribe, LaserstreamConfig};
use yellowstone_grpc_proto::geyser::{SubscribeRequest, SubscribeRequestFilterSlots};
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
    
    // Test 1: Empty request (only internal subscription)
    println!("Test 1: Empty request - should receive NO updates");
    let request = SubscribeRequest::default();
    let (stream, _handle) = subscribe(config.clone(), request);
    tokio::pin!(stream);
    
    let mut count = 0;
    let timeout = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        async {
            while let Some(result) = stream.next().await {
                match result {
                    Ok(update) => {
                        println!("UNEXPECTED: Received update with filters: {:?}", update.filters);
                        count += 1;
                        if count >= 3 {
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("Error: {:?}", e);
                        break;
                    }
                }
            }
        }
    ).await;
    
    match timeout {
        Ok(_) => {
            if count > 0 {
                println!("WARNING: Received {} updates when none were expected!", count);
            }
        }
        Err(_) => {
            println!("✓ Correctly timed out - no updates received (as expected)");
        }
    }
    
    // Test 2: User slot subscription
    println!("\nTest 2: User slot subscription - verifying no internal filters");
    let mut request = SubscribeRequest::default();
    request.slots.insert(
        "user-slot-sub".to_string(),
        SubscribeRequestFilterSlots::default()
    );
    
    let (stream, _handle) = subscribe(config, request);
    tokio::pin!(stream);
    
    let mut verified_count = 0;
    while verified_count < 10 {
        match stream.next().await {
            Some(Ok(update)) => {
                // Check for internal filters
                let has_internal = update.filters.iter().any(|f| f.starts_with("internal-"));
                if has_internal {
                    println!("ERROR: Found internal filter in update: {:?}", update.filters);
                    break;
                }
                
                // Verify user filter is present in slot updates
                if matches!(update.update_oneof, Some(yellowstone_grpc_proto::geyser::subscribe_update::UpdateOneof::Slot(_))) {
                    if update.filters.contains(&"user-slot-sub".to_string()) {
                        println!("✓ Slot update correctly contains user filter: {:?}", update.filters);
                    } else {
                        println!("ERROR: Slot update missing user filter: {:?}", update.filters);
                    }
                    verified_count += 1;
                }
            }
            Some(Err(e)) => {
                eprintln!("Stream error: {:?}", e);
                break;
            }
            None => {
                println!("Stream ended");
                break;
            }
        }
    }
    
    println!("\n✓ Successfully verified {} slot updates contain no internal filters", verified_count);
    
    Ok(())
}