use helius_laserstream::{
    grpc::{
        CommitmentLevel, SubscribeRequest, SubscribeRequestFilterSlots,
        subscribe_update::UpdateOneof,
    },
    subscribe, LaserstreamConfig,
};
use tokio_stream::StreamExt;
use reqwest::Client;
use serde_json::json;
use tracing::{error, warn};
use std::io::{self, Write};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_target(false)
        .init();

    let cfg = LaserstreamConfig {
        api_key: "".to_string(),
        endpoint: "".to_string(),
        ..Default::default()
    };

    let mut slots_map = std::collections::HashMap::new();
    slots_map.insert(
        "slotSubscribe".to_string(),
        SubscribeRequestFilterSlots {
            filter_by_commitment: Some(true),
            interslot_updates: Some(false),
            ..Default::default()
        },
    );

    let req = SubscribeRequest {
        slots: slots_map,
        commitment: Some(CommitmentLevel::Confirmed as i32),
        ..Default::default()
    };

    let rpc_endpoint = "https://mainnet.helius-rpc.com";

    let client = Client::builder().gzip(true).build()?;

    let mut last_slot: Option<u64> = None;

    println!("Starting block integrity test. Subscribing to slots…");

    let api_key_clone = cfg.api_key.clone();
    let (stream, _handle) = subscribe(cfg, req);
    futures::pin_mut!(stream);

    while let Some(res) = stream.next().await {
        match res {
            Ok(update) => {
                if let Some(UpdateOneof::Slot(slot_update)) = update.update_oneof {
                    let current_slot = slot_update.slot;
                    if let Some(last) = last_slot {
                        if current_slot != last + 1 {
                            // Iterate through gap slots
                            for missing in (last + 1)..current_slot {
                                if block_exists(&client, rpc_endpoint, &api_key_clone, missing).await? {
                                    error!("ERROR: Missed slot {} – block exists but was not received.", missing);
                                } else {
                                    println!("Skipped slot {} (no block produced)", missing);
                                    io::stdout().flush().ok();
                                }
                            }
                        }
                    }
                    println!("Received slot: {}", current_slot);
                    io::stdout().flush().ok();
                    last_slot = Some(current_slot);
                }
            }
            Err(e) => {
                warn!("Subscription error: {}", e);
            }
        }
    }

    Ok(())
}

async fn block_exists(client: &Client, endpoint: &str, api_key: &str, slot: u64) -> Result<bool, Box<dyn std::error::Error>> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getBlock",
        "params": [
            slot,
            {
                "encoding": "json",
                "transactionDetails": "full",
                "rewards": false,
                "maxSupportedTransactionVersion": 0
            }
        ]
    });

    let resp = client.post(format!("{}?api-key={}", endpoint, api_key))
        .json(&body)
        .send()
        .await?;

    let json_resp: serde_json::Value = resp.json().await?;
    if let Some(error_obj) = json_resp.get("error") {
        if error_obj.get("code") == Some(&serde_json::Value::from(-32007)) {
            // Slot was skipped – no block expected
            return Ok(false);
        }
    }
    Ok(true)
} 