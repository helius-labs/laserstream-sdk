// tokenAccounts (ATA) transaction filter.
//
// Subscribe to transactions touching a wallet *and* its Associated Token
// Accounts (ATAs) by setting the `token_accounts` field on a transaction
// filter alongside `account_include`. Modes:
//
//   - Unset / None                                       — no expansion (default).
//   - TokenAccountExpansionControlFlag::BalanceChanged   — also match txs touching
//       an ATA owned by an `account_include` wallet whose token balance changed.
//   - TokenAccountExpansionControlFlag::All              — match any tx touching
//       an ATA owned by an `account_include` wallet.
//
// Run with: cargo run --example token_accounts_filter
use helius_laserstream::grpc::{
    SubscribeRequest, SubscribeRequestFilterTransactions, TokenAccountExpansionControlFlag,
};
use helius_laserstream::{subscribe, LaserstreamConfig};
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

    // Example wallet to watch; replace with your own.
    let wallet = env::var("WATCH_WALLET")
        .unwrap_or_else(|_| "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg".to_string());

    let config = LaserstreamConfig::new(endpoint, api_key);
    let mut request = SubscribeRequest::default();

    request.transactions.insert(
        "wallet-and-atas".to_string(),
        SubscribeRequestFilterTransactions {
            vote: Some(false),
            failed: Some(false),
            account_include: vec![wallet],
            // Expand the subscription to ATAs owned by the watched wallet whose
            // token balance changed in the transaction.
            token_accounts: Some(TokenAccountExpansionControlFlag::BalanceChanged as i32),
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
                if count >= 5 {
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
