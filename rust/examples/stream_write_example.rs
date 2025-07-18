use helius_laserstream::{subscribe, LaserstreamConfig, SubscribeRequest, SubscribeRequestFilterSlots};
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio::time::{sleep, Duration};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let endpoint = std::env::var("LASERSTREAM_PRODUCTION_ENDPOINT")
        .unwrap_or_else(|_| "".to_string());
    let api_key = std::env::var("LASERSTREAM_PRODUCTION_API_KEY")
        .expect("LASERSTREAM_PRODUCTION_API_KEY environment variable must be set");

    let config = LaserstreamConfig::new(endpoint, api_key)
        .with_max_reconnect_attempts(5);

    // Initial subscription request - just subscribe to slots
    let mut slots_filter = HashMap::new();
    slots_filter.insert(
        "client".to_string(),
        SubscribeRequestFilterSlots {
            filter_by_commitment: Some(true),
            ..Default::default()
        },
    );

    let initial_request = SubscribeRequest {
        slots: slots_filter,
        commitment: Some(1), // Confirmed
        ..Default::default()
    };

    println!("🚀 Laserstream Bidirectional Stream Example");
    println!("📡 Starting initial subscription to slots...");

    let (stream, handle) = subscribe(config, initial_request);
    let mut stream = Box::pin(stream);

    let message_count = Arc::new(AtomicU32::new(0));
    let handle_clone = handle.clone();
    let count_clone = message_count.clone();

    // Spawn a task to add subscriptions dynamically
    tokio::spawn(async move {
        // Wait for 5 slot updates before adding transaction subscription
        while count_clone.load(Ordering::Relaxed) < 5 {
            sleep(Duration::from_millis(100)).await;
        }

        println!("\n📝 Adding transaction subscription after 5 slots...");
        
        let mut transactions_filter = HashMap::new();
        transactions_filter.insert(
            "client".to_string(),
            helius_laserstream::SubscribeRequestFilterTransactions {
                vote: Some(false),
                failed: Some(false),
                ..Default::default()
            },
        );

        let transaction_request = SubscribeRequest {
            transactions: transactions_filter,
            ..Default::default()
        };

        if let Err(e) = handle_clone.write(transaction_request).await {
            eprintln!("❌ Failed to add transaction subscription: {}", e);
        } else {
            println!("✅ Successfully added transaction subscription");
        }

        // Wait for more messages before adding block subscription
        while count_clone.load(Ordering::Relaxed) < 15 {
            sleep(Duration::from_millis(100)).await;
        }

        println!("\n📦 Adding block subscription...");
        
        let mut blocks_filter = HashMap::new();
        blocks_filter.insert(
            "client".to_string(),
            helius_laserstream::SubscribeRequestFilterBlocks {
                include_transactions: Some(true),
                include_accounts: Some(false),
                include_entries: Some(false),
                ..Default::default()
            },
        );

        let block_request = SubscribeRequest {
            blocks: blocks_filter,
            ..Default::default()
        };

        if let Err(e) = handle_clone.write(block_request).await {
            eprintln!("❌ Failed to add block subscription: {}", e);
        } else {
            println!("✅ Successfully added block subscription");
        }
    });

    // Process the stream
    while let Some(update) = stream.next().await {
        match update {
            Ok(update) => {
                let count = message_count.fetch_add(1, Ordering::Relaxed) + 1;

                match &update.update_oneof {
                    Some(helius_laserstream::grpc::subscribe_update::UpdateOneof::Slot(slot)) => {
                        println!("🎰 Slot update #{}: {}", count, slot.slot);
                    }
                    Some(helius_laserstream::grpc::subscribe_update::UpdateOneof::Transaction(tx)) => {
                        println!("💸 Transaction update: {} bytes", tx.transaction.as_ref().map_or(0, |t| t.data.len()));
                    }
                    Some(helius_laserstream::grpc::subscribe_update::UpdateOneof::Block(block)) => {
                        println!("📦 Block update: slot {}, {} transactions", 
                            block.slot,
                            block.transactions.as_ref().map_or(0, |txs| txs.len())
                        );
                    }
                    _ => {}
                }

                // Stop after 25 messages
                if count >= 25 {
                    println!("\n🛑 Received 25 messages, shutting down...");
                    break;
                }
            }
            Err(e) => {
                eprintln!("❌ Stream error: {}", e);
                // The stream will automatically reconnect
            }
        }
    }

    Ok(())
}