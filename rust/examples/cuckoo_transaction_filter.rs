//! Transaction cuckoo filter example: track accounts via a compact filter instead
//! of an explicit `account_include` list; re-check matches locally (<1% FPs).
//!
//!   LASERSTREAM_ENDPOINT=... LASERSTREAM_API_KEY=... cargo run --example cuckoo_transaction_filter

use {
    futures::StreamExt,
    helius_laserstream::{
        cuckoo::{CompressedAccountFilterSet, Pubkey},
        grpc::{subscribe_update::UpdateOneof, SubscribeRequest, SubscribeRequestFilterTransactions},
        subscribe, LaserstreamConfig,
    },
    std::str::FromStr,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenv::dotenv();
    let endpoint = std::env::var("LASERSTREAM_ENDPOINT")?;
    let api_key = std::env::var("LASERSTREAM_API_KEY")?;

    // The exact set of accounts we want transactions for.
    let tracked: Vec<Pubkey> = [
        "So11111111111111111111111111111111111111112", // Wrapped SOL
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    ]
    .iter()
    .map(|s| Pubkey::from_str(s).unwrap())
    .collect();

    // Build the cuckoo filter. Size it for your peak tracked-set size.
    let mut set = CompressedAccountFilterSet::with_capacity(1_000_000)?;
    for pk in &tracked {
        set.insert(*pk)?;
    }
    println!(
        "Tracking {} accounts via cuckoo filter ({} bytes on the wire)",
        set.len(),
        set.to_proto().data.len()
    );

    // Rides on the transaction filter's `cuckoo_account_include` (no explicit list sent).
    let mut request = SubscribeRequest::default();
    request.transactions.insert(
        "tracked_accounts".to_string(),
        SubscribeRequestFilterTransactions {
            vote: Some(false),
            failed: Some(false),
            cuckoo_account_include: Some(set.to_proto()),
            ..Default::default()
        },
    );

    let config = LaserstreamConfig::new(endpoint, api_key);

    let (stream, _handle) = subscribe(config, request);
    tokio::pin!(stream);
    while let Some(message) = stream.next().await {
        match message {
            Ok(update) => {
                if let Some(UpdateOneof::Transaction(tx_update)) = update.update_oneof {
                    if let Some(info) = tx_update.transaction {
                        // Re-check locally: keep only txns that really touch a tracked
                        // account (drops server-side false positives).
                        let touches_tracked = info
                            .transaction
                            .as_ref()
                            .and_then(|tx| tx.message.as_ref())
                            .map(|msg| {
                                msg.account_keys.iter().any(|key| {
                                    Pubkey::try_from(key.as_slice())
                                        .map(|pk| set.contains(pk))
                                        .unwrap_or(false)
                                })
                            })
                            .unwrap_or(false);

                        if touches_tracked {
                            println!(
                                "tracked txn: {} (slot {})",
                                bs58::encode(&info.signature).into_string(),
                                tx_update.slot
                            );
                        } else {
                            println!("(false positive, ignored) slot {}", tx_update.slot);
                        }
                    }
                }
            }
            Err(e) => eprintln!("stream error: {e}"),
        }
    }

    Ok(())
}
