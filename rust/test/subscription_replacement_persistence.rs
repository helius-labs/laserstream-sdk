use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration, Instant};
use futures_util::StreamExt;
use helius_laserstream::{
    grpc::{
        CommitmentLevel, SubscribeRequest,
        SubscribeRequestFilterTransactions,
        subscribe_update::UpdateOneof,
    },
    subscribe, LaserstreamConfig,
};

const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT: &str = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// Grace period after write/reconnect before tracking filters.
// Needs to be generous: write goes channel → select → server, then server
// processes it and stops sending old-subscription data, plus any messages
// already in the TCP/gRPC send buffer still arrive.
const GRACE_PERIOD: Duration = Duration::from_secs(10);

// Minimum messages needed in each phase to consider the test conclusive
const MIN_PHASE1_MSGS: u64 = 3;
const MIN_PHASE3_MSGS: u64 = 5;

/// Test for subscription replacement behavior and persistence across reconnections.
///
/// Requires the JS chaos proxy running:
///   cd javascript && npx ts-node test/laserstreamChaosProxy.ts
///
/// Run:
///   LASERSTREAM_API_KEY=<key> cargo run --bin subscription_replacement_persistence_test
///
/// Verifies:
/// 1. Initial subscribe(USDC) receives USDC transactions
/// 2. write(USDT) replaces subscription — only USDT arrives, USDC stops
/// 3. After chaos proxy forces a reconnection AFTER the write, USDT persists (not reverted to USDC)
/// 4. Actual message counts prove data flowed in every phase
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let endpoint = std::env::var("LASERSTREAM_CHAOS_ENDPOINT")
        .unwrap_or_else(|_| "http://127.0.0.1:4003".to_string());
    let api_key = std::env::var("LASERSTREAM_API_KEY")
        .or_else(|_| std::env::var("LASERSTREAM_PRODUCTION_API_KEY"))
        .unwrap_or_default();

    println!("Connecting through chaos proxy at {}", endpoint);

    let config = LaserstreamConfig::new(endpoint, api_key);

    // --- Counters per phase ---
    let usdc_phase1 = Arc::new(AtomicU64::new(0));
    let usdt_phase1 = Arc::new(AtomicU64::new(0));
    let usdc_phase2 = Arc::new(AtomicU64::new(0));
    let usdt_phase2 = Arc::new(AtomicU64::new(0));
    let usdc_phase3 = Arc::new(AtomicU64::new(0));
    let usdt_phase3 = Arc::new(AtomicU64::new(0));

    // --- State ---
    let reconnected_after_write = Arc::new(AtomicBool::new(false));
    let total_reconnects = Arc::new(AtomicU64::new(0));
    let reconnects_after_write = Arc::new(AtomicU64::new(0));
    let reconnect_after_write_time = Arc::new(Mutex::new(None::<Instant>));
    let write_completed_time = Arc::new(Mutex::new(None::<Instant>));
    // Signal: set to true once enough Phase 1 USDC data has been received
    let ready_for_write = Arc::new(AtomicBool::new(false));

    // --- Initial subscription: USDC transactions ---
    let mut txn_filter = HashMap::new();
    txn_filter.insert(
        "usdc-filter".to_string(),
        SubscribeRequestFilterTransactions {
            vote: Some(false),
            failed: Some(false),
            account_include: vec![USDC_MINT.to_string()],
            ..Default::default()
        },
    );

    let initial_request = SubscribeRequest {
        transactions: txn_filter,
        commitment: Some(CommitmentLevel::Processed as i32),
        ..Default::default()
    };

    let (stream, handle) = subscribe(config, initial_request);
    let mut stream = Box::pin(stream);

    let handle_clone = handle.clone();
    let write_time_setter = write_completed_time.clone();
    let ready_flag = ready_for_write.clone();

    // Spawn task: wait for USDC data to flow, then send write()
    tokio::spawn(async move {
        // Wait until we've received enough Phase 1 data
        println!("[writer] Waiting for USDC data before sending write...");
        loop {
            if ready_flag.load(Ordering::SeqCst) {
                break;
            }
            sleep(Duration::from_millis(200)).await;
        }

        // Small extra delay to ensure a solid baseline
        sleep(Duration::from_secs(2)).await;
        println!("[writer] Sending write() to replace USDC with USDT filter...");

        let mut usdt_filter = HashMap::new();
        usdt_filter.insert(
            "usdt-filter".to_string(),
            SubscribeRequestFilterTransactions {
                vote: Some(false),
                failed: Some(false),
                account_include: vec![USDT_MINT.to_string()],
                ..Default::default()
            },
        );

        let write_request = SubscribeRequest {
            transactions: usdt_filter,
            commitment: Some(CommitmentLevel::Processed as i32),
            ..Default::default()
        };

        match handle_clone.write(write_request).await {
            Ok(()) => {
                *write_time_setter.lock().await = Some(Instant::now());
                println!("[writer] write() sent successfully");
            }
            Err(e) => {
                eprintln!("FATAL: Failed to write: {}", e);
                std::process::exit(1);
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(180);

    while Instant::now() < deadline {
        // Early exit: Phase 3 has enough messages
        let p3_total = usdc_phase3.load(Ordering::Relaxed) + usdt_phase3.load(Ordering::Relaxed);
        if p3_total >= MIN_PHASE3_MSGS {
            println!("[early exit] Phase 3 collected {} messages", p3_total);
            break;
        }

        tokio::select! {
            Some(result) = stream.next() => {
                match result {
                    Ok(update) => {
                        if let Some(UpdateOneof::Transaction(_)) = &update.update_oneof {
                            let now = Instant::now();
                            let write_time = *write_completed_time.lock().await;
                            let recon_time = *reconnect_after_write_time.lock().await;

                            for f in &update.filters {
                                let is_usdc = f == "usdc-filter";
                                let is_usdt = f == "usdt-filter";
                                if !is_usdc && !is_usdt { continue; }

                                match categorize_phase(now, write_time, recon_time) {
                                    Phase::BeforeWrite => {
                                        if is_usdc {
                                            let n = usdc_phase1.fetch_add(1, Ordering::Relaxed) + 1;
                                            if n >= MIN_PHASE1_MSGS {
                                                ready_for_write.store(true, Ordering::SeqCst);
                                            }
                                        }
                                        if is_usdt { usdt_phase1.fetch_add(1, Ordering::Relaxed); }
                                    }
                                    Phase::AfterWrite => {
                                        if is_usdc { usdc_phase2.fetch_add(1, Ordering::Relaxed); }
                                        if is_usdt { usdt_phase2.fetch_add(1, Ordering::Relaxed); }
                                    }
                                    Phase::AfterReconnect => {
                                        if is_usdc { usdc_phase3.fetch_add(1, Ordering::Relaxed); }
                                        if is_usdt { usdt_phase3.fetch_add(1, Ordering::Relaxed); }
                                    }
                                    Phase::GracePeriod => {}
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let recon_num = total_reconnects.fetch_add(1, Ordering::SeqCst) + 1;
                        let write_time = *write_completed_time.lock().await;

                        if write_time.is_some() {
                            let n = reconnects_after_write.fetch_add(1, Ordering::SeqCst) + 1;
                            reconnected_after_write.store(true, Ordering::SeqCst);
                            *reconnect_after_write_time.lock().await = Some(Instant::now());
                            eprintln!("[reconnect #{}] (after write, #{} post-write) {}", recon_num, n, e);
                        } else {
                            eprintln!("[reconnect #{}] (before write) {}", recon_num, e);
                        }
                    }
                }
            }
            _ = sleep(Duration::from_millis(100)) => {}
        }
    }

    // --- Results ---
    let did_reconnect_after_write = reconnected_after_write.load(Ordering::SeqCst);
    let total_recon = total_reconnects.load(Ordering::SeqCst);
    let post_write_recon = reconnects_after_write.load(Ordering::SeqCst);

    let p1_usdc = usdc_phase1.load(Ordering::Relaxed);
    let p1_usdt = usdt_phase1.load(Ordering::Relaxed);
    let p2_usdc = usdc_phase2.load(Ordering::Relaxed);
    let p2_usdt = usdt_phase2.load(Ordering::Relaxed);
    let p3_usdc = usdc_phase3.load(Ordering::Relaxed);
    let p3_usdt = usdt_phase3.load(Ordering::Relaxed);

    println!("\n--- Results ---");
    println!("Phase 1 (before write):                USDC={:<6} USDT={}", p1_usdc, p1_usdt);
    println!("Phase 2 (after write, pre-reconnect):  USDC={:<6} USDT={}", p2_usdc, p2_usdt);
    println!("Phase 3 (after reconnect post-write):  USDC={:<6} USDT={}", p3_usdc, p3_usdt);
    println!("Total reconnections: {} (before write: {}, after write: {})",
        total_recon, total_recon - post_write_recon, post_write_recon);

    // --- Assertions ---
    let mut failed = false;

    if p1_usdc < MIN_PHASE1_MSGS {
        eprintln!("FAIL: Phase 1 — USDC got {} txns before write (expected >= {})", p1_usdc, MIN_PHASE1_MSGS);
        failed = true;
    }
    if p1_usdt > 0 {
        eprintln!("FAIL: Phase 1 — USDT got {} txns before write (expected 0)", p1_usdt);
        failed = true;
    }
    if p2_usdc > 0 {
        eprintln!("FAIL: Phase 2 — USDC got {} txns after write (expected 0)", p2_usdc);
        failed = true;
    }
    if p2_usdt == 0 && !did_reconnect_after_write {
        eprintln!("FAIL: Phase 2 — USDT got 0 txns after write (expected > 0)");
        failed = true;
    }
    if !did_reconnect_after_write {
        eprintln!("FAIL: No reconnection after write — chaos proxy may not be running");
        failed = true;
    }
    if p3_usdc > 0 {
        eprintln!("FAIL: Phase 3 — USDC got {} txns after reconnect (write NOT persisted!)", p3_usdc);
        failed = true;
    }
    if did_reconnect_after_write && p3_usdt < MIN_PHASE3_MSGS {
        eprintln!("FAIL: Phase 3 — USDT got {} txns after reconnect (expected >= {})", p3_usdt, MIN_PHASE3_MSGS);
        failed = true;
    }

    if failed {
        eprintln!("\nTest FAILED");
        std::process::exit(1);
    }

    println!("\nAll assertions passed — write() persisted across {} post-write reconnection(s)", post_write_recon);
    Ok(())
}

enum Phase {
    BeforeWrite,
    AfterWrite,
    AfterReconnect,
    GracePeriod,
}

fn categorize_phase(
    now: Instant,
    write_time: Option<Instant>,
    reconnect_after_write_time: Option<Instant>,
) -> Phase {
    let Some(wt) = write_time else {
        return Phase::BeforeWrite;
    };

    if now.duration_since(wt) <= GRACE_PERIOD {
        return Phase::GracePeriod;
    }

    if let Some(rt) = reconnect_after_write_time {
        if now.duration_since(rt) > GRACE_PERIOD {
            return Phase::AfterReconnect;
        }
        return Phase::GracePeriod;
    }

    Phase::AfterWrite
}
