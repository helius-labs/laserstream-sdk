use futures_util::StreamExt;
use helius_laserstream::{
    grpc::{
        SubscribeRequest,
        SubscribeRequestFilterTransactions,
    },
    subscribe, LaserstreamConfig,
};
use solana_client::nonblocking::rpc_client::RpcClient;
use yellowstone_grpc_proto::geyser::{CommitmentLevel, SubscribeRequestFilterAccounts, SubscribeRequestFilterBlocksMeta, SubscribeRequestFilterEntry, SubscribeRequestFilterSlots};
use std::{collections::HashMap, time::Instant};
use clap::Parser;
use prost::Message;

/// Bandwidth tester for Laserstream gRPC
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Laserstream API key
    #[arg(long)]
    api_key: String,

    /// Laserstream endpoint URL
    #[arg(long)]
    laserstream_url: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    let api_key = args.api_key;
    let endpoint_url = args.laserstream_url;

    let config = LaserstreamConfig {
        api_key: api_key.clone(),
        endpoint: endpoint_url.parse()?,
        ..Default::default()
    };

    let rpc_url = format!("https://mainnet.helius-rpc.com/?api-key={}", api_key);
    let rpc_client = RpcClient::new(rpc_url);
    let slot = rpc_client.get_slot().await.unwrap();
    let replay_slot = slot - 300;


    let request = SubscribeRequest {
        accounts: HashMap::from_iter(vec![(
            "".to_string(),
            SubscribeRequestFilterAccounts::default(),
        )]),
        slots: HashMap::from_iter(vec![(
            "".to_string(),
            SubscribeRequestFilterSlots {
                filter_by_commitment: Some(false),
                interslot_updates: Some(true),
            },
        )]),
        transactions: HashMap::from_iter(vec![(
            "".to_string(),
            SubscribeRequestFilterTransactions::default(),
        )]),
        transactions_status: HashMap::default(),
        blocks: HashMap::default(),
        blocks_meta: HashMap::from_iter(vec![(
            "".to_string(),
            SubscribeRequestFilterBlocksMeta::default(),
        )]),
        entry: HashMap::from_iter(vec![(
            "".to_string(),
            SubscribeRequestFilterEntry::default(),
        )]),
        commitment: Some(CommitmentLevel::Processed.into()),
        accounts_data_slice: Vec::new(),
        ping: None,
        from_slot: Some(replay_slot),
    };

    // --- Subscribe and Process ---
    println!("Connecting and subscribing...");
    let stream = subscribe(config, request);


    // Pin the stream to the stack
    futures::pin_mut!(stream);
    let mut last_checkpoint = Instant::now();
    let mut total_bytes = 0;
    let test_duration = 10;
    let checkpoint_interval = 2;
    let num_checkpoints = test_duration / checkpoint_interval;
    let mut checkpoint_num = 1;
    println!("Starting bandwidth test for {}s with checkpoints every {}s", test_duration, checkpoint_interval);
    

    while let Some(result) = stream.next().await {
        let result = result?;
        let bytes = result.encode_to_vec();
        total_bytes += bytes.len();
        if last_checkpoint.elapsed().as_secs() > checkpoint_interval {
            let throughput = total_bytes as f64 / last_checkpoint.elapsed().as_secs() as f64;
            let throughput_mbps = throughput / 1024.0 / 1024.0;
            println!("Checkpoint {}/{}: {:.2} MB/s", checkpoint_num, num_checkpoints, throughput_mbps);
            total_bytes = 0;
            last_checkpoint = Instant::now();
            checkpoint_num += 1;
            if checkpoint_num > num_checkpoints {
                break;
            }
        }
    }

    println!("Test finished.");
    Ok(())
}
