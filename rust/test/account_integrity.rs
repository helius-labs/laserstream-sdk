use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;
use futures_util::StreamExt;
use helius_laserstream::{
    grpc::{
        CommitmentLevel, SubscribeRequest, SubscribeRequestAccountsDataSlice,
        SubscribeRequestFilterAccounts,
        subscribe_update::UpdateOneof,
    },
    subscribe, LaserstreamConfig,
};
use laserstream_core_client::{ClientTlsConfig, GeyserGrpcClient};
use bs58;
use tracing::{error, warn};
use std::io::{self, Write};
use sha2::{Sha256, Digest};

// Helper to normalise debug output by zeroing-out volatile fields (e.g. write_version)
fn fingerprint_account(data: &[u8], lamports: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.update(&lamports.to_le_bytes());
    let digest = hasher.finalize();
    format!("{:x}", digest)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_target(false)
        .init();    

    // ---- Configuration ----
    const ACCOUNTS: [&str; 2] = [
        "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // Pump AMM program
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   // SPL Token program
    ];

    let laser_cfg = LaserstreamConfig {
        api_key: "".to_string(),
        endpoint: "".to_string(),
        ..Default::default()
    };

    let yellowstone_endpoint = "".to_string();
    let yellowstone_token = "".to_string();

    // ---- Subscription Request ----
    let mut accounts_map = HashMap::new();
    accounts_map.insert(
        "tracked".to_string(),
        SubscribeRequestFilterAccounts {
            account: ACCOUNTS.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        },
    );

    let subscribe_req = SubscribeRequest {
        accounts: accounts_map,
        commitment: Some(CommitmentLevel::Confirmed as i32),
        accounts_data_slice: Vec::<SubscribeRequestAccountsDataSlice>::new(),
        ..Default::default()
    };

    // ---- Shared State ----
    #[derive(Default, Clone)]
    struct Seen { slot_ls: Option<u64>, slot_ys: Option<u64> }

    let state: Arc<Mutex<HashMap<String, Seen>>> = Arc::new(Mutex::new(HashMap::new()));
    let latest_ls: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
    let latest_ys: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));

    let max_slot_ls = Arc::new(Mutex::new(0u64));
    let max_slot_ys = Arc::new(Mutex::new(0u64));

    let mut handles = Vec::new();

    // ---- Laserstream Task ----
    {
        let req = subscribe_req.clone();
        let state = Arc::clone(&state);
        let latest_ls = Arc::clone(&latest_ls);
        let max_ls_ptr = Arc::clone(&max_slot_ls);
        let handle = tokio::spawn(async move {
            let (stream, _handle) = subscribe(laser_cfg, req);
            futures::pin_mut!(stream);
            while let Some(res) = stream.next().await {
                match res {
                    Ok(update) => {
                        if let Some(UpdateOneof::Account(acc)) = update.update_oneof.as_ref() {
                            // Extract key and slot
                            if let (Some(account_msg), slot) = (acc.account.as_ref(), acc.slot) {
                                let key_b58 = bs58::encode(&account_msg.pubkey).into_string();
                                // Update state
                                {
                                    let mut st = state.lock().await;
                                    let entry = st.entry(key_b58.clone()).or_default();
                                    entry.slot_ls = Some(slot);
                                }
                                {
                                    let mut m = max_ls_ptr.lock().await;
                                    if slot > *m { *m = slot; }
                                }
                                // Store serialised update for comparison
                                {
                                    let mut map = latest_ls.lock().await;
                                    let key_b58_copy = key_b58.clone();
                                    let fp = fingerprint_account(&account_msg.data, account_msg.lamports);
                                    map.insert(key_b58_copy, fp);
                                }
                                println!("[LS] key={} slot={}", key_b58, slot);
                                io::stdout().flush().ok();
                            }
                        }
                    }
                    Err(e) => {
                        error!("LASERSTREAM error: {}", e);
                    }
                }
            }
        });
        handles.push(handle);
    }

    // ---- Yellowstone Task ----
    {
        let req = subscribe_req.clone();
        let state = Arc::clone(&state);
        let latest_ys = Arc::clone(&latest_ys);
        let max_ys_ptr = Arc::clone(&max_slot_ys);
        let handle = tokio::spawn(async move {
            // Build client
            let mut builder = GeyserGrpcClient::build_from_shared(yellowstone_endpoint)
                .unwrap()
                .x_token(Some(yellowstone_token))
                .unwrap()
                .max_decoding_message_size(1_000_000_000)
                .tls_config(ClientTlsConfig::new().with_enabled_roots())
                .unwrap()
                .connect()
                .await
                .unwrap();
            let (_sender, mut stream) = builder.subscribe_with_request(Some(req)).await.unwrap();

            while let Some(result) = stream.next().await {
                match result {
                    Ok(update) => {
                        if let Some(UpdateOneof::Account(acc)) = update.update_oneof.as_ref() {
                            if let (Some(account_msg), slot) = (acc.account.as_ref(), acc.slot) {
                                let key_b58 = bs58::encode(&account_msg.pubkey).into_string();
                                {
                                    let mut st = state.lock().await;
                                    let entry = st.entry(key_b58.clone()).or_default();
                                    entry.slot_ys = Some(slot);
                                }
                                {
                                    let mut m = max_ys_ptr.lock().await;
                                    if slot > *m { *m = slot; }
                                }
                                {
                                    let mut map = latest_ys.lock().await;
                                    let key_b58_copy = key_b58.clone();
                                    let fp = fingerprint_account(&account_msg.data, account_msg.lamports);
                                    map.insert(key_b58_copy, fp);
                                }
                                println!("[YS] key={} slot={}", key_b58, slot);
                                io::stdout().flush().ok();
                            }
                        }
                    }
                    Err(e) => warn!("YELLOWSTONE stream error: {}", e),
                }
            }
        });
        handles.push(handle);
    }

    // ---- Integrity Check Task ----
    {
        const INTERVAL_MS: u64 = 30_000;
        const SLOT_LAG: u64 = 3000;
        let state = Arc::clone(&state);
        let latest_ls = Arc::clone(&latest_ls);
        let latest_ys = Arc::clone(&latest_ys);
        let max_ls_ptr = Arc::clone(&max_slot_ls);
        let max_ys_ptr = Arc::clone(&max_slot_ys);
        let handle = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_millis(INTERVAL_MS));
            loop {
                ticker.tick().await;
                let now = chrono::Utc::now().to_rfc3339();

                let st_guard = state.lock().await;
                let ls_guard = latest_ls.lock().await;
                let ys_guard = latest_ys.lock().await;

                let all_keys: HashSet<String> = ls_guard.keys().chain(ys_guard.keys()).cloned().collect();

                let mut missing_ls = Vec::new();
                let mut missing_ys = Vec::new();
                let mut mismatched = Vec::new();

                let ready_slot;
                {
                    let ls_max = *max_ls_ptr.lock().await;
                    let ys_max = *max_ys_ptr.lock().await;
                    ready_slot = ls_max.min(ys_max).saturating_sub(SLOT_LAG);
                }

                for k in all_keys {
                    let ls_bytes = ls_guard.get(&k);
                    let ys_bytes = ys_guard.get(&k);
                    let slots = st_guard.get(&k).cloned().unwrap_or_default();

                    let ls_slot = slots.slot_ls;
                    let ys_slot = slots.slot_ys;

                    if ls_bytes.is_none() {
                        missing_ls.push(k.clone());
                        continue;
                    }
                    if ys_bytes.is_none() {
                        if let (Some(ls), Some(ys)) = (ls_slot, ys_slot) {
                            if ls - ys > SLOT_LAG {
                                missing_ys.push(k.clone());
                            }
                        }
                        continue;
                    }

                    // compare only when both slots are known, match and are <= ready_slot (so unlikely to change)
                    if ls_slot != ys_slot || ls_slot.unwrap_or(0) > ready_slot || ys_slot.unwrap_or(0) > ready_slot {
                        continue;
                    }
                    if ls_bytes != ys_bytes {
                        error!("ACCOUNT PAYLOAD MISMATCH {}", k);
                        if let Some(a) = ls_bytes { error!("LS payload: {}", a); }
                        if let Some(b) = ys_bytes { error!("YS payload: {}", b); }
                        mismatched.push(k.clone());
                    }
                }

                println!("[{}] Integrity: missing LS={} missing YS={} mismatched={}", now, missing_ls.len(), missing_ys.len(), mismatched.len());
                for k in &missing_ls { error!("ACCOUNT MISSING IN LASERSTREAM {}", k); }
                for k in &missing_ys { error!("ACCOUNT MISSING IN YELLOWSTONE {}", k); }
                for k in &mismatched { error!("ACCOUNT PAYLOAD MISMATCH {}", k); }
            }
        });
        handles.push(handle);
    }

    // ---- Wait forever ----
    futures::future::join_all(handles).await;

    Ok(())
} 