use futures_util::StreamExt;
use helius_laserstream::{
    grpc::{SubscribeRequest, SubscribeRequestFilterAccounts},
    subscribe, LaserstreamConfig,
};
use std::{collections::HashMap, env};

// Run with LASERSTREAM_ENDPOINT, HELIUS_API_KEY and FROM_SLOT in the environment.
// The server must support disabling Geyser Archive fallback; otherwise this
// exits with FAILED_PRECONDITION instead of accepting an unprotected stream.
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = LaserstreamConfig::new(
        env::var("LASERSTREAM_ENDPOINT")?,
        env::var("HELIUS_API_KEY")?,
    )
    .with_geyser_archive_fallback(false);
    let request = SubscribeRequest {
        accounts: HashMap::from([("accounts".into(), SubscribeRequestFilterAccounts::default())]),
        from_slot: Some(env::var("FROM_SLOT")?.parse()?),
        ..Default::default()
    };
    let (stream, _handle) = subscribe(config, request);
    futures_util::pin_mut!(stream);
    while let Some(update) = stream.next().await {
        // Propagate OUT_OF_RANGE so the caller can recover without GA data.
        let update = update?;
        println!("{update:?}");
    }
    Ok(())
}
