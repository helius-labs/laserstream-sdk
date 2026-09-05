use futures::StreamExt;
use helius_laserstream::{grpc::*, subscribe, LaserstreamConfig};
use serde_json::{json, Value};
use std::{collections::HashMap, io::Write};
use tokio::io::{AsyncBufReadExt, BufReader};

fn emit(v: Value) {
    println!("{v}");
    std::io::stdout().flush().unwrap();
}
fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().map(|s| s.as_str().unwrap().to_string()).collect())
        .unwrap_or_default()
}
fn filters(v: &Value) -> HashMap<String, SubscribeRequestFilterTransactions> {
    v.as_object()
        .map(|m| {
            m.iter()
                .map(|(k, f)| {
                    (
                        k.clone(),
                        SubscribeRequestFilterTransactions {
                            vote: f["vote"].as_bool(),
                            failed: f["failed"].as_bool(),
                            signature: f["signature"].as_str().map(str::to_string),
                            account_include: strings(&f["accountInclude"]),
                            account_exclude: strings(&f["accountExclude"]),
                            account_required: strings(&f["accountRequired"]),
                            match_mints: f["matchMints"].as_bool().unwrap_or(false),
                            token_accounts: match f["tokenAccounts"].as_str() {
                                Some("ALL") => Some(0),
                                Some("BALANCE_CHANGED") => Some(1),
                                _ => None,
                            },
                            ..Default::default()
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}
fn request(v: &Value) -> SubscribeRequest {
    SubscribeRequest {
        transactions: filters(&v["transactions"]),
        transactions_status: filters(&v["transactionsStatus"]),
        slots: v["slots"]
            .as_object()
            .map(|m| {
                m.iter()
                    .map(|(k, _)| (k.clone(), SubscribeRequestFilterSlots::default()))
                    .collect()
            })
            .unwrap_or_default(),
        commitment: v["commitment"].as_i64().map(|n| n as i32),
        from_slot: v["fromSlot"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .or_else(|| v["fromSlot"].as_u64()),
        ping: v["ping"]["id"]
            .as_i64()
            .map(|id| SubscribeRequestPing { id: id as i32 }),
        ..Default::default()
    }
}
fn update(u: SubscribeUpdate) {
    match u.update_oneof {
        Some(subscribe_update::UpdateOneof::Transaction(tx)) => {
            let t = tx.transaction.unwrap();
            let mut keys: Vec<String> = t
                .transaction
                .as_ref()
                .and_then(|t| t.message.as_ref())
                .map(|m| {
                    m.account_keys
                        .iter()
                        .map(|k| bs58::encode(k).into_string())
                        .collect()
                })
                .unwrap_or_default();
            let mut pre = vec![];
            let mut post = vec![];
            if let Some(m) = &t.meta {
                keys.extend(
                    m.loaded_writable_addresses
                        .iter()
                        .chain(m.loaded_readonly_addresses.iter())
                        .map(|k| bs58::encode(k).into_string()),
                );
                let balance =
                    |b: &helius_laserstream::solana::storage::confirmed_block::TokenBalance| {
                        json!({
                    "accountIndex":b.account_index,"mint":b.mint,"owner":b.owner,
                    "uiTokenAmount":{"amount":b.ui_token_amount.as_ref().map(|a|a.amount.as_str()).unwrap_or("0")}})
                    };
                pre = m.pre_token_balances.iter().map(balance).collect();
                post = m.post_token_balances.iter().map(balance).collect();
            }
            emit(
                json!({"type":"transaction","filters":u.filters,"slot":tx.slot,
                "signature":bs58::encode(t.signature).into_string(),"vote":t.is_vote,
                "failed":t.meta.as_ref().is_some_and(|m|m.err.is_some()),"keys":keys,"pre":pre,"post":post}),
            );
        }
        Some(subscribe_update::UpdateOneof::TransactionStatus(t)) => {
            emit(json!({"type":"status","filters":u.filters,
            "slot":t.slot,"signature":bs58::encode(t.signature).into_string(),"vote":t.is_vote,"failed":t.err.is_some()}))
        }
        Some(subscribe_update::UpdateOneof::Slot(s)) => {
            emit(json!({"type":"slot","filters":u.filters,"slot":s.slot}))
        }
        _ => {}
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let first: Value = serde_json::from_str(&lines.next_line().await?.ok_or("missing subscribe")?)?;
    let config = LaserstreamConfig::new(
        std::env::var("MINT_ENDPOINT")?,
        std::env::var("MINT_API_KEY").unwrap_or_default(),
    )
    .with_replay(first["replay"].as_bool().unwrap_or(true))
    .with_max_reconnect_attempts(3);
    let (stream, handle) = subscribe(config, request(&first["request"]));
    tokio::pin!(stream);
    emit(json!({"type":"ack","id":first["id"]}));
    loop {
        tokio::select! {
            line=lines.next_line()=>{
                let Some(line)=line? else {break};
                let c:Value=serde_json::from_str(&line)?;
                if c["action"]=="stop" {break}
                match handle.write(request(&c["request"])).await {
                    Ok(())=>emit(json!({"type":"ack","id":c["id"]})),
                    Err(e)=>emit(json!({"type":"commandError","id":c["id"],"message":e.to_string()}))
                }
            },
            item=stream.next()=>match item {
                Some(Ok(u))=>update(u), Some(Err(e))=>emit(json!({"type":"error","message":e.to_string()})), None=>break
            }
        }
    }
    Ok(())
}
