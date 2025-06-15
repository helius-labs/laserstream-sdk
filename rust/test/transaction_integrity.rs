use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;
use helius_laserstream::{
    grpc::{
        CommitmentLevel, SubscribeRequest, SubscribeRequestFilterTransactions, subscribe_update::UpdateOneof,
    },
    subscribe, LaserstreamConfig,
};
use yellowstone_grpc_client::{ClientTlsConfig, GeyserGrpcClient};
use tokio_stream::StreamExt;
use tracing::{error, info, warn};
use bs58;
use std::io::{self, Write};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_target(false)
        .init();

    const PUMP_PROGRAM: &str = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

    let laser_cfg = LaserstreamConfig {
        api_key: "".to_string(),
        endpoint: "".to_string(),
        ..Default::default()
    };

    let yellowstone_endpoint = "".to_string();
    let yellowstone_token = "".to_string();

    // --- Subscription Request ---
    let mut tx_filter_map = HashMap::new();
    tx_filter_map.insert(
        "client".to_string(),
        SubscribeRequestFilterTransactions {
            account_include: vec![PUMP_PROGRAM.to_string()],
            vote: Some(false),
            failed: Some(false),
            ..Default::default()
        },
    );

    let subscribe_req = SubscribeRequest {
        transactions: tx_filter_map,
        commitment: Some(CommitmentLevel::Processed as i32),
        ..Default::default()
    };

    // ---- Shared State ----
    let ls_by_slot: Arc<Mutex<HashMap<u64, HashSet<String>>>> = Arc::new(Mutex::new(HashMap::new()));
    let ys_by_slot: Arc<Mutex<HashMap<u64, HashSet<String>>>> = Arc::new(Mutex::new(HashMap::new()));
    let max_slot_ls = Arc::new(Mutex::new(0u64));
    let max_slot_ys = Arc::new(Mutex::new(0u64));

    // For display and match when both slots known
    let status_map: Arc<Mutex<HashMap<String, (Option<u64>, Option<u64>)>>> = Arc::new(Mutex::new(HashMap::new()));

    // Counters for periodic report
    let new_ls = Arc::new(Mutex::new(0u64));
    let new_ys = Arc::new(Mutex::new(0u64));
    let err_ls = Arc::new(Mutex::new(0u64));
    let err_ys = Arc::new(Mutex::new(0u64));

    // --- Laserstream Task ---
    {
        let req = subscribe_req.clone();
        let ls_by_slot = Arc::clone(&ls_by_slot);
        let max_slot_ls = Arc::clone(&max_slot_ls);
        let new_ls_counter = Arc::clone(&new_ls);
        let status_map = Arc::clone(&status_map);
        let err_ls_counter = Arc::clone(&err_ls);
        tokio::spawn(async move {
            let mut stream = subscribe(laser_cfg, req);
            futures::pin_mut!(stream);
            while let Some(res) = stream.next().await {
                match res {
                    Ok(update) => {
                        if let Some(UpdateOneof::Transaction(tx)) = update.update_oneof.as_ref() {
                            if let Some(info) = tx.transaction.as_ref() {
                                // Extract signature (bytes) & slot
                                let sig_bytes: &[u8] = &info.signature;
                                let sig_str = bs58::encode(sig_bytes).into_string();
                                let slot = tx.slot;

                                {
                                    let mut map = ls_by_slot.lock().await;
                                    map.entry(slot).or_default().insert(sig_str.clone());
                                }
                                {
                                    let mut m = max_slot_ls.lock().await;
                                    if slot > *m { *m = slot; }
                                }
                                {
                                    let mut c = new_ls_counter.lock().await; *c += 1; }
                                {
                                    let mut st = status_map.lock().await;
                                    let entry = st.entry(sig_str.clone()).or_insert((None, None));
                                    entry.0 = Some(slot);
                                    if entry.0.is_some() && entry.1.is_some() {
                                        info!("MATCH {}  LS_slot={}  YS_slot={}", sig_str, slot, entry.1.unwrap());
                                        st.remove(&sig_str);
                                        println!("[LS] sig={} slot={}", sig_str, slot);
                                        io::stdout().flush().ok();
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        warn!("LASERSTREAM error: {}", e);
                        *err_ls_counter.lock().await += 1;
                    }
                }
            }
        });
    }

    // --- Yellowstone Task ---
    {
        let req = subscribe_req.clone();
        let ys_by_slot = Arc::clone(&ys_by_slot);
        let max_slot_ys = Arc::clone(&max_slot_ys);
        let new_ys_counter = Arc::clone(&new_ys);
        let status_map = Arc::clone(&status_map);
        let err_ys_counter = Arc::clone(&err_ys);
        tokio::spawn(async move {
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

            while let Some(res) = stream.next().await {
                match res {
                    Ok(update) => {
                        if let Some(UpdateOneof::Transaction(tx)) = update.update_oneof.as_ref() {
                            if let Some(info) = tx.transaction.as_ref() {
                                let sig_bytes: &[u8] = &info.signature;
                                let sig_str = bs58::encode(sig_bytes).into_string();
                                let slot = tx.slot;

                                {
                                    let mut map = ys_by_slot.lock().await;
                                    map.entry(slot).or_default().insert(sig_str.clone());
                                }
                                {
                                    let mut m = max_slot_ys.lock().await; if slot > *m { *m = slot; }
                                }
                                {
                                    let mut c = new_ys_counter.lock().await; *c += 1; }
                                {
                                    let mut st = status_map.lock().await;
                                    let entry = st.entry(sig_str.clone()).or_insert((None, None));
                                    entry.1 = Some(slot);
                                    if entry.0.is_some() && entry.1.is_some() {
                                        info!("MATCH {}  LS_slot={}  YS_slot={}", sig_str, entry.0.unwrap(), slot);
                                        st.remove(&sig_str);
                                        println!("[YS] sig={} slot={}", sig_str, slot);
                                        io::stdout().flush().ok();
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        warn!("YELLOWSTONE error: {}", e);
                        *err_ys_counter.lock().await += 1;
                    }
                }
            }
        });
    }

    // --- Integrity Check Task ---
    {
        const SLOT_LAG: u64 = 3000;
        const INTERVAL_MS: u64 = 30_000;
        let ls_by_slot = Arc::clone(&ls_by_slot);
        let ys_by_slot = Arc::clone(&ys_by_slot);
        let max_slot_ls = Arc::clone(&max_slot_ls);
        let max_slot_ys = Arc::clone(&max_slot_ys);
        let new_ls = Arc::clone(&new_ls);
        let new_ys = Arc::clone(&new_ys);
        let err_ls = Arc::clone(&err_ls);
        let err_ys = Arc::clone(&err_ys);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_millis(INTERVAL_MS));
            loop {
                ticker.tick().await;
                let ready_slot = {
                    let a = *max_slot_ls.lock().await;
                    let b = *max_slot_ys.lock().await;
                    a.min(b).saturating_sub(SLOT_LAG)
                };

                let mut total_missing_ls = 0usize;
                let mut total_missing_ys = 0usize;
                let mut processed_slots = 0usize;

                let mut ls_map = ls_by_slot.lock().await;
                let mut ys_map = ys_by_slot.lock().await;

                let slots: HashSet<u64> = ls_map.keys().chain(ys_map.keys()).cloned().collect();

                for slot in slots {
                    if slot > ready_slot { continue; }
                    processed_slots += 1;
                    let set_ls = ls_map.remove(&slot).unwrap_or_default();
                    let set_ys = ys_map.remove(&slot).unwrap_or_default();
                    let missing_ls: HashSet<_> = set_ys.difference(&set_ls).cloned().collect();
                    let missing_ys: HashSet<_> = set_ls.difference(&set_ys).cloned().collect();

                    if !missing_ls.is_empty() || !missing_ys.is_empty() {
                        error!("[INTEGRITY] transaction_mismatch slot={} missing Laserstream={} missing Yellowstone={}", slot, missing_ls.len(), missing_ys.len());
                        for sig in &missing_ls { error!("SIGNATURE MISSING IN LASERSTREAM {} (YS_slot={})", sig, slot); }
                        for sig in &missing_ys { error!("SIGNATURE MISSING IN YELLOWSTONE {} (LS_slot={})", sig, slot); }
                    }

                    total_missing_ls += missing_ls.len();
                    total_missing_ys += missing_ys.len();
                }

                let now = chrono::Utc::now().to_rfc3339();
                let ls_new = *new_ls.lock().await;
                let ys_new = *new_ys.lock().await;
                let err_l = *err_ls.lock().await;
                let err_y = *err_ys.lock().await;

                println!("[{}] laserstream+{} yellowstone+{} processedSlots:{} missingLS:{} missingYS:{} LS_errors:{} YS_errors:{}", now, ls_new, ys_new, processed_slots, total_missing_ls, total_missing_ys, err_l, err_y);

                *new_ls.lock().await = 0;
                *new_ys.lock().await = 0;
            }
        });
    }

    println!("Starting transaction integrity test …");

    // Keep alive indefinitely
    futures::future::pending::<()>().await;

    Ok(())
} 