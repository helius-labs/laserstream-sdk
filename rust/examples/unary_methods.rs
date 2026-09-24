use helius_laserstream::grpc::CommitmentLevel;
use helius_laserstream::{LaserstreamClient, LaserstreamConfig};
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::from_path("../.env").ok();

    let api_key = env::var("LASERSTREAM_PRODUCTION_API_KEY")
        .or_else(|_| env::var("HELIUS_API_KEY"))
        .expect("LASERSTREAM_PRODUCTION_API_KEY or HELIUS_API_KEY not set");
    let endpoint = env::var("LASERSTREAM_PRODUCTION_ENDPOINT")
        .or_else(|_| env::var("LASERSTREAM_ENDPOINT"))
        .expect("LASERSTREAM_PRODUCTION_ENDPOINT or LASERSTREAM_ENDPOINT not set");

    // One client, reused for every call (cheap to clone, shares the connection).
    let client = LaserstreamClient::connect(LaserstreamConfig::new(endpoint, api_key)).await?;

    let slot = client.get_slot(Some(CommitmentLevel::Confirmed)).await?;
    println!("slot (confirmed):  {}", slot.slot);

    let height = client.get_block_height(None).await?;
    println!("block height:      {}", height.block_height);

    let bh = client.get_latest_blockhash(Some(CommitmentLevel::Finalized)).await?;
    println!(
        "latest blockhash:  {} (slot {}, last valid height {})",
        bh.blockhash, bh.slot, bh.last_valid_block_height
    );

    let valid = client.is_blockhash_valid(&bh.blockhash, None).await?;
    println!("blockhash valid:   {} (checked at slot {})", valid.valid, valid.slot);

    println!("version:           {}", client.get_version().await?.version);
    println!("ping:              {}", client.ping(1).await?.count);
    println!(
        "replay from slot:  {:?}",
        client.subscribe_replay_info().await?.first_available
    );

    Ok(())
}
