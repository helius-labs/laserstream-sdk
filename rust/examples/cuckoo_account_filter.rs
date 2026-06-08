//! Compressed account (cuckoo) filter example.
//!
//! Tracks a large set of accounts using a compact probabilistic filter instead
//! of an explicit pubkey list, then streams account updates and re-checks each
//! incoming account locally against the exact set (the server may deliver <1%
//! false positives).
//!
//! Run with:
//!   LASERSTREAM_ENDPOINT=... LASERSTREAM_API_KEY=... cargo run --example cuckoo_account_filter

use {
    futures::StreamExt,
    helius_laserstream::{
        cuckoo::{CompressedAccountFilterSet, Pubkey},
        grpc::{subscribe_update::UpdateOneof, SubscribeRequest},
        subscribe, LaserstreamConfig,
    },
    std::str::FromStr,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenv::dotenv();
    let endpoint = std::env::var("LASERSTREAM_ENDPOINT")?;
    let api_key = std::env::var("LASERSTREAM_API_KEY")?;

    // The exact set of accounts we care about.
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

    let mut request = SubscribeRequest::default();
    set.insert_into_subscribe_request(&mut request, "tracked_accounts");

    let config = LaserstreamConfig::new(endpoint, api_key);

    let (stream, _handle) = subscribe(config, request);
    tokio::pin!(stream);
    while let Some(message) = stream.next().await {
        match message {
            Ok(update) => {
                if let Some(UpdateOneof::Account(account_update)) = update.update_oneof {
                    if let Some(info) = account_update.account {
                        let pk = Pubkey::try_from(info.pubkey.as_slice()).ok();
                        // Re-check locally: drop server-side false positives.
                        match pk {
                            Some(pk) if set.contains(pk) => {
                                println!("tracked account update: {pk} (slot {})", account_update.slot);
                            }
                            Some(pk) => {
                                println!("(false positive, ignored): {pk}");
                            }
                            None => {}
                        }
                    }
                }
            }
            Err(e) => eprintln!("stream error: {e}"),
        }
    }

    Ok(())
}
