mod client;
mod proto;
mod stream;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Env, JsFunction, JsObject};
use napi_derive::napi;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use parking_lot::Mutex;
use std::sync::LazyLock;
use yellowstone_grpc_proto;
use yellowstone_grpc_proto::geyser::SubscribeUpdate as YellowstoneSubscribeUpdate;
use napi::{JsUnknown, NapiValue, NapiRaw};

// Re-export the generated protobuf types
pub use proto::*;

// Global stream registry for lifecycle management
static STREAM_REGISTRY: LazyLock<Mutex<HashMap<String, Arc<stream::StreamInner>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SIGNAL_HANDLERS_REGISTERED: AtomicBool = AtomicBool::new(false);
static ACTIVE_STREAM_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

// Custom wrapper for SubscribeUpdate that implements ToNapiValue
pub struct SubscribeUpdateWrapper(pub YellowstoneSubscribeUpdate);

impl ToNapiValue for SubscribeUpdateWrapper {
    unsafe fn to_napi_value(env: napi::sys::napi_env, val: Self) -> napi::Result<napi::sys::napi_value> {
        // Create a full SubscribeUpdate-compatible class with all methods
        create_subscribe_update_class(env, val.0)
    }
}

// Internal function to register a stream in the global registry
pub fn register_stream(id: String, stream: Arc<stream::StreamInner>) {
    let mut registry = STREAM_REGISTRY.lock();
    registry.insert(id, stream);
    ACTIVE_STREAM_COUNT.fetch_add(1, Ordering::SeqCst);
}

// Internal function to unregister a stream from the global registry
pub fn unregister_stream(id: &str) {
    let mut registry = STREAM_REGISTRY.lock();
    if registry.remove(id).is_some() {
        ACTIVE_STREAM_COUNT.fetch_sub(1, Ordering::SeqCst);
    }
}

// Internal function to setup signal handlers and keep-alive
fn setup_global_lifecycle_management(_env: &Env) -> Result<()> {
    // Only register signal handlers once
    if SIGNAL_HANDLERS_REGISTERED.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        // In a production implementation, you would register proper signal handlers here
        // For now, we rely on the tokio runtime and stream references to keep the process alive
    }
    
    Ok(())
}

// Graceful shutdown function
#[napi]
pub fn shutdown_all_streams(_env: Env) -> Result<()> {
    let mut registry = STREAM_REGISTRY.lock();
    
    for (_id, stream) in registry.iter() {
        let _ = stream.cancel();
    }
    
    registry.clear();
    ACTIVE_STREAM_COUNT.store(0, Ordering::SeqCst);
    
    Ok(())
}

// Get active stream count
#[napi]
pub fn get_active_stream_count() -> u32 {
    ACTIVE_STREAM_COUNT.load(Ordering::SeqCst)
}

// Create a complete SubscribeUpdate class that matches Yellowstone gRPC interface
fn create_subscribe_update_class(env: napi::sys::napi_env, update: YellowstoneSubscribeUpdate) -> napi::Result<napi::sys::napi_value> {
    use yellowstone_grpc_proto::geyser::subscribe_update::UpdateOneof;
    
    let env = unsafe { napi::Env::from_raw(env) };
    let mut obj = env.create_object()?;
    
    // Add filters array (matching Yellowstone interface)
    let mut filters_array = env.create_array_with_length(update.filters.len())?;
    for (i, filter) in update.filters.iter().enumerate() {
        let filter_str = env.create_string(filter)?;
        filters_array.set_element(i as u32, filter_str)?;
    }
    
    obj.set_named_property("filters", filters_array)?;
    
    // Add createdAt as Date object (matching Yellowstone interface exactly)
    if let Some(ref timestamp) = update.created_at {
        // Convert protobuf timestamp to JavaScript Date object
        let millis = timestamp.seconds * 1000 + (timestamp.nanos / 1_000_000) as i64;
        
        // Create Date using global Date constructor
        let global = env.get_global()?;
        let date_constructor: napi::JsFunction = global.get_named_property("Date")?;
        let millis_val = env.create_double(millis as f64)?;
        let date = date_constructor.new_instance(&[millis_val])?;
        obj.set_named_property("createdAt", date)?;
    }
    
    // Always include ALL top-level fields like Yellowstone (set to undefined if not present)
    let undefined = env.get_undefined()?;
    
    // Initialize all fields to undefined first
    obj.set_named_property("account", undefined)?;
    obj.set_named_property("slot", undefined)?;
    obj.set_named_property("transaction", undefined)?;
    obj.set_named_property("transactionStatus", undefined)?;
    obj.set_named_property("block", undefined)?;
    obj.set_named_property("blockMeta", undefined)?;
    obj.set_named_property("entry", undefined)?;
    obj.set_named_property("ping", undefined)?;
    obj.set_named_property("pong", undefined)?;
    
    // Then set the specific update type (matching Yellowstone field names exactly)
    if let Some(ref update_oneof) = update.update_oneof {
        match update_oneof {
            UpdateOneof::Account(account_update) => {
                let account_obj = convert_account_update_to_js(&env, account_update)?;
                obj.set_named_property("account", account_obj)?;
            }
            UpdateOneof::Slot(slot_update) => {
                let slot_obj = convert_slot_update_to_js(&env, slot_update)?;
                obj.set_named_property("slot", slot_obj)?;
            }
            UpdateOneof::Transaction(tx_update) => {
                let tx_obj = convert_transaction_update_to_js(&env, tx_update)?;
                obj.set_named_property("transaction", tx_obj)?;
            }
            UpdateOneof::TransactionStatus(tx_status_update) => {
                let tx_status_obj = convert_transaction_status_update_to_js(&env, tx_status_update)?;
                obj.set_named_property("transactionStatus", tx_status_obj)?;
            }
            UpdateOneof::Block(block_update) => {
                let block_obj = convert_block_update_to_js(&env, block_update)?;
                obj.set_named_property("block", block_obj)?;
            }
            UpdateOneof::BlockMeta(block_meta_update) => {
                let block_meta_obj = convert_block_meta_update_to_js(&env, block_meta_update)?;
                obj.set_named_property("blockMeta", block_meta_obj)?;
            }
            UpdateOneof::Entry(entry_update) => {
                let entry_obj = convert_entry_update_to_js(&env, entry_update)?;
                obj.set_named_property("entry", entry_obj)?;
            }
            UpdateOneof::Ping(ping_update) => {
                let ping_obj = convert_ping_update_to_js(&env, ping_update)?;
                obj.set_named_property("ping", ping_obj)?;
            }
            UpdateOneof::Pong(pong_update) => {
                let pong_obj = convert_pong_update_to_js(&env, pong_update)?;
                obj.set_named_property("pong", pong_obj)?;
            }
        }
    }
    
    unsafe { Ok(obj.raw()) }
}

// Conversion functions for different update types (matching Yellowstone interface exactly)
fn convert_account_update_to_js(env: &napi::Env, account_update: &yellowstone_grpc_proto::geyser::SubscribeUpdateAccount) -> napi::Result<napi::JsObject> {
    let mut obj = env.create_object()?;
    
    if let Some(ref account) = account_update.account {
        let mut account_obj = env.create_object()?;
        
        // Convert pubkey bytes to Uint8Array (matching Yellowstone interface)
        let pubkey_buffer = env.create_buffer_with_data(account.pubkey.clone())?.into_unknown();
        account_obj.set_named_property("pubkey", pubkey_buffer)?;
        
        // lamports as string (matching Yellowstone interface)
        account_obj.set_named_property("lamports", env.create_string(&account.lamports.to_string())?)?;
        
        // Convert owner bytes to Uint8Array
        let owner_buffer = env.create_buffer_with_data(account.owner.clone())?.into_unknown();
        account_obj.set_named_property("owner", owner_buffer)?;
        
        account_obj.set_named_property("executable", env.get_boolean(account.executable)?)?;
        
        // rentEpoch as string (matching Yellowstone interface)
        account_obj.set_named_property("rentEpoch", env.create_string(&account.rent_epoch.to_string())?)?;
        
        // Convert data bytes to Uint8Array
        let data_buffer = env.create_buffer_with_data(account.data.clone())?.into_unknown();
        account_obj.set_named_property("data", data_buffer)?;
        
        // writeVersion as string (matching Yellowstone interface)
        account_obj.set_named_property("writeVersion", env.create_string(&account.write_version.to_string())?)?;
        
        if let Some(ref txn_signature) = account.txn_signature {
            let sig_buffer = env.create_buffer_with_data(txn_signature.clone())?.into_unknown();
            account_obj.set_named_property("txnSignature", sig_buffer)?;
        }
        
        obj.set_named_property("account", account_obj)?;
    }
    
    // slot as string (matching Yellowstone interface)
    obj.set_named_property("slot", env.create_string(&account_update.slot.to_string())?)?;
    obj.set_named_property("isStartup", env.get_boolean(account_update.is_startup)?)?;
    
    Ok(obj)
}

fn convert_slot_update_to_js(env: &napi::Env, slot_update: &yellowstone_grpc_proto::geyser::SubscribeUpdateSlot) -> napi::Result<napi::JsObject> {
    let mut obj = env.create_object()?;
    
    // slot as string (matching Yellowstone interface)
    obj.set_named_property("slot", env.create_string(&slot_update.slot.to_string())?)?;
    
    // Always include parent field (set to undefined if not present, like Yellowstone)
    if let Some(ref parent) = slot_update.parent {
        obj.set_named_property("parent", env.create_string(&parent.to_string())?)?;
    } else {
        obj.set_named_property("parent", env.get_undefined()?)?;
    }
    
    obj.set_named_property("status", env.create_int32(slot_update.status as i32)?)?;
    
    // Always include deadError field (set to undefined if not present, like Yellowstone)
    if let Some(ref dead_error) = slot_update.dead_error {
        obj.set_named_property("deadError", env.create_string(dead_error)?)?;
    } else {
        obj.set_named_property("deadError", env.get_undefined()?)?;
    }
    
    Ok(obj)
}

fn convert_transaction_update_to_js(env: &napi::Env, tx_update: &yellowstone_grpc_proto::geyser::SubscribeUpdateTransaction) -> napi::Result<napi::JsObject> {
    let mut obj = env.create_object()?;
    
    if let Some(ref transaction) = tx_update.transaction {
        let mut tx_obj = env.create_object()?;
        
        // Convert signature to Uint8Array (matching Yellowstone interface)
        let sig_buffer = env.create_buffer_with_data(transaction.signature.clone())?.into_unknown();
        tx_obj.set_named_property("signature", sig_buffer)?;
        
        tx_obj.set_named_property("isVote", env.get_boolean(transaction.is_vote)?)?;
        tx_obj.set_named_property("index", env.create_string(&transaction.index.to_string())?)?;
        
        // Add transaction field (this references the inner transaction structure)
        if let Some(ref inner_transaction) = transaction.transaction {
            let mut inner_tx_obj = env.create_object()?;
            
            // Convert signatures array
            let mut signatures_array = env.create_array_with_length(inner_transaction.signatures.len())?;
            for (i, sig) in inner_transaction.signatures.iter().enumerate() {
                let sig_buffer = env.create_buffer_with_data(sig.clone())?.into_unknown();
                signatures_array.set_element(i as u32, sig_buffer)?;
            }
            inner_tx_obj.set_named_property("signatures", signatures_array)?;
            
            // Convert message if present (simplified - full implementation would be very complex)
            if let Some(ref message) = inner_transaction.message {
                let mut message_obj = env.create_object()?;
                // Add basic message fields - could be expanded further
                message_obj.set_named_property("versioned", env.get_boolean(message.versioned)?)?;
                inner_tx_obj.set_named_property("message", message_obj)?;
            }
            
            tx_obj.set_named_property("transaction", inner_tx_obj)?;
        }
        
        // Convert meta if present (this is the key missing field in inner transaction!)
        if let Some(ref meta) = transaction.meta {
            let mut meta_obj = env.create_object()?;
            
            // Convert basic meta fields
            meta_obj.set_named_property("fee", env.create_string(&meta.fee.to_string())?)?;
            
            // Convert pre/post balances
            let mut pre_balances_array = env.create_array_with_length(meta.pre_balances.len())?;
            for (i, balance) in meta.pre_balances.iter().enumerate() {
                pre_balances_array.set_element(i as u32, env.create_string(&balance.to_string())?)?;
            }
            meta_obj.set_named_property("preBalances", pre_balances_array)?;
            
            let mut post_balances_array = env.create_array_with_length(meta.post_balances.len())?;
            for (i, balance) in meta.post_balances.iter().enumerate() {
                post_balances_array.set_element(i as u32, env.create_string(&balance.to_string())?)?;
            }
            meta_obj.set_named_property("postBalances", post_balances_array)?;
            
            // Convert log messages
            if !meta.log_messages_none {
                let mut log_messages_array = env.create_array_with_length(meta.log_messages.len())?;
                for (i, log_msg) in meta.log_messages.iter().enumerate() {
                    log_messages_array.set_element(i as u32, env.create_string(log_msg)?)?;
                }
                meta_obj.set_named_property("logMessages", log_messages_array)?;
            }
            
            // Add error if present
            if let Some(ref error) = meta.err {
                let err_buffer = env.create_buffer_with_data(error.err.clone())?.into_unknown();
                meta_obj.set_named_property("err", err_buffer)?;
            }
            
            // Add compute units consumed if present
            if let Some(ref compute_units) = meta.compute_units_consumed {
                meta_obj.set_named_property("computeUnitsConsumed", env.create_string(&compute_units.to_string())?)?;
            }
            
            tx_obj.set_named_property("meta", meta_obj)?;
        }
        
        obj.set_named_property("transaction", tx_obj)?;
    }
    
    // slot as string (matching Yellowstone interface)
    obj.set_named_property("slot", env.create_string(&tx_update.slot.to_string())?)?;
    
    Ok(obj)
}

fn convert_transaction_status_update_to_js(env: &napi::Env, tx_status_update: &yellowstone_grpc_proto::geyser::SubscribeUpdateTransactionStatus) -> napi::Result<napi::JsObject> {
    let mut obj = env.create_object()?;
    
    // slot as string (matching Yellowstone interface)
    obj.set_named_property("slot", env.create_string(&tx_status_update.slot.to_string())?)?;
    
    // Convert signature
    let sig_buffer = env.create_buffer_with_data(tx_status_update.signature.clone())?.into_unknown();
    obj.set_named_property("signature", sig_buffer)?;
    
    obj.set_named_property("isVote", env.get_boolean(tx_status_update.is_vote)?)?;
    obj.set_named_property("index", env.create_string(&tx_status_update.index.to_string())?)?;
    
    // Always include err field (set to undefined if not present, like Yellowstone)
    if let Some(ref err) = tx_status_update.err {
        obj.set_named_property("err", env.create_string(&format!("{:?}", err))?)?;
    } else {
        obj.set_named_property("err", env.get_undefined()?)?;
    }
    
    Ok(obj)
}

fn convert_block_update_to_js(env: &napi::Env, block_update: &yellowstone_grpc_proto::geyser::SubscribeUpdateBlock) -> napi::Result<napi::JsObject> {
    let mut obj = env.create_object()?;
    
    // slot as string (matching Yellowstone interface)
    obj.set_named_property("slot", env.create_string(&block_update.slot.to_string())?)?;
    obj.set_named_property("blockhash", env.create_string(&block_update.blockhash)?)?;
    
    // Handle rewards (matching Yellowstone interface)
    if let Some(ref rewards) = block_update.rewards {
        let mut rewards_obj = env.create_object()?;
        
        // Convert rewards array
        let mut rewards_array = env.create_array_with_length(rewards.rewards.len())?;
        for (i, reward) in rewards.rewards.iter().enumerate() {
            let mut reward_obj = env.create_object()?;
            reward_obj.set_named_property("pubkey", env.create_string(&reward.pubkey)?)?;
            reward_obj.set_named_property("lamports", env.create_string(&reward.lamports.to_string())?)?;
            reward_obj.set_named_property("postBalance", env.create_string(&reward.post_balance.to_string())?)?;
            reward_obj.set_named_property("rewardType", env.create_int32(reward.reward_type as i32)?)?;
            if !reward.commission.is_empty() {
                reward_obj.set_named_property("commission", env.create_string(&reward.commission)?)?;
            }
            rewards_array.set_element(i as u32, reward_obj)?;
        }
        rewards_obj.set_named_property("rewards", rewards_array)?;
        
        // Handle numPartitions if present
        if let Some(ref num_partitions) = rewards.num_partitions {
            let mut partitions_obj = env.create_object()?;
            partitions_obj.set_named_property("numPartitions", env.create_string(&num_partitions.num_partitions.to_string())?)?;
            rewards_obj.set_named_property("numPartitions", partitions_obj)?;
        }
        
        obj.set_named_property("rewards", rewards_obj)?;
    }
    
    // Handle blockTime as UnixTimestamp object (matching Yellowstone interface)
    if let Some(ref block_time) = block_update.block_time {
        let mut block_time_obj = env.create_object()?;
        let timestamp_str = block_time.timestamp.to_string();
        block_time_obj.set_named_property("timestamp", env.create_string(&timestamp_str)?)?;
        obj.set_named_property("blockTime", block_time_obj)?;
    }
    
    // Handle blockHeight (matching Yellowstone interface)
    if let Some(ref block_height) = block_update.block_height {
        let mut block_height_obj = env.create_object()?;
        block_height_obj.set_named_property("blockHeight", env.create_string(&block_height.block_height.to_string())?)?;
        obj.set_named_property("blockHeight", block_height_obj)?;
    }
    
    obj.set_named_property("parentSlot", env.create_string(&block_update.parent_slot.to_string())?)?;
    obj.set_named_property("parentBlockhash", env.create_string(&block_update.parent_blockhash)?)?;
    obj.set_named_property("executedTransactionCount", env.create_string(&block_update.executed_transaction_count.to_string())?)?;
    
    // Convert transactions array (this is critical for includeTransactions: true)
    let mut transactions_array = env.create_array_with_length(block_update.transactions.len())?;
    for (i, tx_info) in block_update.transactions.iter().enumerate() {
        let mut tx_obj = env.create_object()?;
        
        // Convert signature to Uint8Array
        let sig_buffer = env.create_buffer_with_data(tx_info.signature.clone())?.into_unknown();
        tx_obj.set_named_property("signature", sig_buffer)?;
        
        tx_obj.set_named_property("isVote", env.get_boolean(tx_info.is_vote)?)?;
        tx_obj.set_named_property("index", env.create_string(&tx_info.index.to_string())?)?;
        
        // Convert transaction data if present
        if let Some(ref transaction) = tx_info.transaction {
            let mut inner_tx_obj = env.create_object()?;
            
            // Convert signatures array
            let mut signatures_array = env.create_array_with_length(transaction.signatures.len())?;
            for (j, sig) in transaction.signatures.iter().enumerate() {
                let sig_buffer = env.create_buffer_with_data(sig.clone())?.into_unknown();
                signatures_array.set_element(j as u32, sig_buffer)?;
            }
            inner_tx_obj.set_named_property("signatures", signatures_array)?;
            
            // Convert message if present (simplified - full implementation would be very complex)
            if let Some(ref message) = transaction.message {
                let mut message_obj = env.create_object()?;
                // Add basic message fields - could be expanded further
                message_obj.set_named_property("versioned", env.get_boolean(message.versioned)?)?;
                inner_tx_obj.set_named_property("message", message_obj)?;
            }
            
            tx_obj.set_named_property("transaction", inner_tx_obj)?;
        }
        
        // Convert meta if present
        if let Some(ref meta) = tx_info.meta {
            let mut meta_obj = env.create_object()?;
            
            // Convert basic meta fields
            meta_obj.set_named_property("fee", env.create_string(&meta.fee.to_string())?)?;
            
            // Convert pre/post balances
            let mut pre_balances_array = env.create_array_with_length(meta.pre_balances.len())?;
            for (j, balance) in meta.pre_balances.iter().enumerate() {
                pre_balances_array.set_element(j as u32, env.create_string(&balance.to_string())?)?;
            }
            meta_obj.set_named_property("preBalances", pre_balances_array)?;
            
            let mut post_balances_array = env.create_array_with_length(meta.post_balances.len())?;
            for (j, balance) in meta.post_balances.iter().enumerate() {
                post_balances_array.set_element(j as u32, env.create_string(&balance.to_string())?)?;
            }
            meta_obj.set_named_property("postBalances", post_balances_array)?;
            
            // Convert log messages
            if !meta.log_messages_none {
                let mut log_messages_array = env.create_array_with_length(meta.log_messages.len())?;
                for (j, log_msg) in meta.log_messages.iter().enumerate() {
                    log_messages_array.set_element(j as u32, env.create_string(log_msg)?)?;
                }
                meta_obj.set_named_property("logMessages", log_messages_array)?;
            }
            
            // Add error if present
            if let Some(ref error) = meta.err {
                let err_buffer = env.create_buffer_with_data(error.err.clone())?.into_unknown();
                meta_obj.set_named_property("err", err_buffer)?;
            }
            
            // Add compute units consumed if present
            if let Some(ref compute_units) = meta.compute_units_consumed {
                meta_obj.set_named_property("computeUnitsConsumed", env.create_string(&compute_units.to_string())?)?;
            }
            
            tx_obj.set_named_property("meta", meta_obj)?;
        }
        
        transactions_array.set_element(i as u32, tx_obj)?;
    }
    obj.set_named_property("transactions", transactions_array)?;
    
    obj.set_named_property("updatedAccountCount", env.create_string(&block_update.updated_account_count.to_string())?)?;
    
    // Convert accounts array
    let mut accounts_array = env.create_array_with_length(block_update.accounts.len())?;
    for (i, account_info) in block_update.accounts.iter().enumerate() {
        let mut account_obj = env.create_object()?;
        
        let pubkey_buffer = env.create_buffer_with_data(account_info.pubkey.clone())?.into_unknown();
        account_obj.set_named_property("pubkey", pubkey_buffer)?;
        
        account_obj.set_named_property("lamports", env.create_string(&account_info.lamports.to_string())?)?;
        
        let owner_buffer = env.create_buffer_with_data(account_info.owner.clone())?.into_unknown();
        account_obj.set_named_property("owner", owner_buffer)?;
        
        account_obj.set_named_property("executable", env.get_boolean(account_info.executable)?)?;
        account_obj.set_named_property("rentEpoch", env.create_string(&account_info.rent_epoch.to_string())?)?;
        
        let data_buffer = env.create_buffer_with_data(account_info.data.clone())?.into_unknown();
        account_obj.set_named_property("data", data_buffer)?;
        
        account_obj.set_named_property("writeVersion", env.create_string(&account_info.write_version.to_string())?)?;
        
        if let Some(ref txn_signature) = account_info.txn_signature {
            let sig_buffer = env.create_buffer_with_data(txn_signature.clone())?.into_unknown();
            account_obj.set_named_property("txnSignature", sig_buffer)?;
        }
        
        accounts_array.set_element(i as u32, account_obj)?;
    }
    obj.set_named_property("accounts", accounts_array)?;
    
    obj.set_named_property("entriesCount", env.create_string(&block_update.entries_count.to_string())?)?;
    
    // Convert entries array
    let mut entries_array = env.create_array_with_length(block_update.entries.len())?;
    for (i, entry) in block_update.entries.iter().enumerate() {
        let mut entry_obj = env.create_object()?;
        
        entry_obj.set_named_property("slot", env.create_string(&entry.slot.to_string())?)?;
        entry_obj.set_named_property("index", env.create_string(&entry.index.to_string())?)?;
        entry_obj.set_named_property("numHashes", env.create_string(&entry.num_hashes.to_string())?)?;
        
        let hash_buffer = env.create_buffer_with_data(entry.hash.clone())?.into_unknown();
        entry_obj.set_named_property("hash", hash_buffer)?;
        
        entry_obj.set_named_property("executedTransactionCount", env.create_string(&entry.executed_transaction_count.to_string())?)?;
        entry_obj.set_named_property("startingTransactionIndex", env.create_string(&entry.starting_transaction_index.to_string())?)?;
        
        entries_array.set_element(i as u32, entry_obj)?;
    }
    obj.set_named_property("entries", entries_array)?;
    
    Ok(obj)
}

fn convert_block_meta_update_to_js(env: &napi::Env, block_meta_update: &yellowstone_grpc_proto::geyser::SubscribeUpdateBlockMeta) -> napi::Result<napi::JsObject> {
    let mut obj = env.create_object()?;
    
    // slot as string (matching Yellowstone interface)
    obj.set_named_property("slot", env.create_string(&block_meta_update.slot.to_string())?)?;
    obj.set_named_property("blockhash", env.create_string(&block_meta_update.blockhash)?)?;
    
    // Handle rewards (matching Yellowstone interface)
    if let Some(ref rewards) = block_meta_update.rewards {
        let mut rewards_obj = env.create_object()?;
        
        // Convert rewards array
        let mut rewards_array = env.create_array_with_length(rewards.rewards.len())?;
        for (i, reward) in rewards.rewards.iter().enumerate() {
            let mut reward_obj = env.create_object()?;
            reward_obj.set_named_property("pubkey", env.create_string(&reward.pubkey)?)?;
            reward_obj.set_named_property("lamports", env.create_string(&reward.lamports.to_string())?)?;
            reward_obj.set_named_property("postBalance", env.create_string(&reward.post_balance.to_string())?)?;
            reward_obj.set_named_property("rewardType", env.create_int32(reward.reward_type as i32)?)?;
            if !reward.commission.is_empty() {
                reward_obj.set_named_property("commission", env.create_string(&reward.commission)?)?;
            }
            rewards_array.set_element(i as u32, reward_obj)?;
        }
        rewards_obj.set_named_property("rewards", rewards_array)?;
        
        // Handle numPartitions if present
        if let Some(ref num_partitions) = rewards.num_partitions {
            let mut partitions_obj = env.create_object()?;
            partitions_obj.set_named_property("numPartitions", env.create_string(&num_partitions.num_partitions.to_string())?)?;
            rewards_obj.set_named_property("numPartitions", partitions_obj)?;
        }
        
        obj.set_named_property("rewards", rewards_obj)?;
    }
    
    // Handle blockTime as UnixTimestamp object (matching Yellowstone interface)
    if let Some(ref block_time) = block_meta_update.block_time {
        let mut block_time_obj = env.create_object()?;
        // UnixTimestamp has a single i64 timestamp field - convert to string as expected
        let timestamp_str = block_time.timestamp.to_string();
        block_time_obj.set_named_property("timestamp", env.create_string(&timestamp_str)?)?;
        obj.set_named_property("blockTime", block_time_obj)?;
    }
    
    // Handle blockHeight (matching Yellowstone interface)
    if let Some(ref block_height) = block_meta_update.block_height {
        let mut block_height_obj = env.create_object()?;
        block_height_obj.set_named_property("blockHeight", env.create_string(&block_height.block_height.to_string())?)?;
        obj.set_named_property("blockHeight", block_height_obj)?;
    }
    
    obj.set_named_property("parentSlot", env.create_string(&block_meta_update.parent_slot.to_string())?)?;
    obj.set_named_property("parentBlockhash", env.create_string(&block_meta_update.parent_blockhash)?)?;
    obj.set_named_property("executedTransactionCount", env.create_string(&block_meta_update.executed_transaction_count.to_string())?)?;
    obj.set_named_property("entriesCount", env.create_string(&block_meta_update.entries_count.to_string())?)?;
    
    Ok(obj)
}

fn convert_entry_update_to_js(env: &napi::Env, entry_update: &yellowstone_grpc_proto::geyser::SubscribeUpdateEntry) -> napi::Result<napi::JsObject> {
    let mut obj = env.create_object()?;
    
    // slot as string (matching Yellowstone interface)
    obj.set_named_property("slot", env.create_string(&entry_update.slot.to_string())?)?;
    obj.set_named_property("index", env.create_string(&entry_update.index.to_string())?)?;
    obj.set_named_property("numHashes", env.create_string(&entry_update.num_hashes.to_string())?)?;
    
    // Convert hash
    let hash_buffer = env.create_buffer_with_data(entry_update.hash.clone())?.into_unknown();
    obj.set_named_property("hash", hash_buffer)?;
    
    // Convert executed transaction count
    obj.set_named_property("executedTransactionCount", env.create_string(&entry_update.executed_transaction_count.to_string())?)?;
    
    // Convert starting transaction index (always present in the protobuf)
    obj.set_named_property("startingTransactionIndex", env.create_string(&entry_update.starting_transaction_index.to_string())?)?;
    
    Ok(obj)
}

fn convert_ping_update_to_js(env: &napi::Env, _ping_update: &yellowstone_grpc_proto::geyser::SubscribeUpdatePing) -> napi::Result<napi::JsObject> {
    let obj = env.create_object()?;
    // Ping updates are empty objects
    Ok(obj)
}

fn convert_pong_update_to_js(env: &napi::Env, pong_update: &yellowstone_grpc_proto::geyser::SubscribeUpdatePong) -> napi::Result<napi::JsObject> {
    let mut obj = env.create_object()?;
    obj.set_named_property("id", env.create_int32(pong_update.id)?)?;
    Ok(obj)
}

// Commitment levels enum
#[napi]
pub enum CommitmentLevel {
    Processed = 0,
    Confirmed = 1,
    Finalized = 2,
}

// SubscribeUpdate type definitions - exported directly from NAPI
#[napi(object)]
pub struct SubscribeUpdateAccount {
    pub account: SubscribeUpdateAccountData,
    pub slot: String,
    pub is_startup: bool,
}

#[napi(object)]
pub struct SubscribeUpdateAccountData {
    pub pubkey: Vec<u8>,
    pub lamports: String,
    pub owner: Vec<u8>,
    pub executable: bool,
    pub rent_epoch: String,
    pub data: Vec<u8>,
    pub write_version: String,
    pub txn_signature: Option<Vec<u8>>,
}

#[napi(object)]
pub struct SubscribeUpdateSlot {
    pub slot: String,
    pub parent: Option<String>,
    pub status: i32,
    pub dead_error: Option<String>,
}

#[napi(object)]
pub struct SubscribeUpdateTransaction {
    pub transaction: SubscribeUpdateTransactionData,
    pub slot: String,
    pub meta: Option<serde_json::Value>,
}

#[napi(object)]
pub struct SubscribeUpdateTransactionData {
    pub signature: Vec<u8>,
    pub is_vote: bool,
    pub transaction: Option<serde_json::Value>,
}

#[napi(object)]
pub struct SubscribeUpdateTransactionStatus {
    pub slot: String,
    pub signature: Vec<u8>,
    pub is_vote: bool,
    pub index: String,
    pub err: Option<String>,
}

#[napi(object)]
pub struct SubscribeUpdateBlock {
    pub slot: String,
    pub blockhash: String,
    pub block_time: Option<SubscribeUpdateBlockTime>,
    pub parent_slot: String,
    pub parent_blockhash: String,
}

#[napi(object)]
pub struct SubscribeUpdateBlockMeta {
    pub slot: String,
    pub blockhash: String,
    pub block_time: Option<SubscribeUpdateBlockTime>,
    pub parent_slot: String,
    pub parent_blockhash: String,
}

#[napi(object)]
pub struct SubscribeUpdateBlockTime {
    pub timestamp: String,
}

#[napi(object)]
pub struct SubscribeUpdateEntry {
    pub slot: String,
    pub index: String,
    pub num_hashes: String,
    pub hash: Vec<u8>,
    pub executed_transaction_count: String,
    pub starting_transaction_index: String,
}

#[napi(object)]
pub struct SubscribeUpdatePing {}

#[napi(object)]
pub struct SubscribeUpdatePong {
    pub id: i32,
}

#[napi(object)]
pub struct SubscribeUpdate {
    pub filters: Vec<String>,
    pub created_at: Option<String>, // Use string for timestamp instead of JsDate
    pub account: Option<SubscribeUpdateAccount>,
    pub slot: Option<SubscribeUpdateSlot>,
    pub transaction: Option<SubscribeUpdateTransaction>,
    pub transaction_status: Option<SubscribeUpdateTransactionStatus>,
    pub block: Option<SubscribeUpdateBlock>,
    pub block_meta: Option<SubscribeUpdateBlockMeta>,
    pub entry: Option<SubscribeUpdateEntry>,
    pub ping: Option<SubscribeUpdatePing>,
    pub pong: Option<SubscribeUpdatePong>,
}

// Main client struct
#[napi]
pub struct LaserstreamClient {
    inner: Arc<client::ClientInner>,
}

#[napi]
impl LaserstreamClient {
    #[napi(constructor)]
    pub fn new(
        endpoint: String,
        token: Option<String>,
        max_reconnect_attempts: Option<u32>,
    ) -> Result<Self> {
        let inner = Arc::new(client::ClientInner::new(
            endpoint,
            token,
            max_reconnect_attempts,
        )?);
        Ok(Self { inner })
    }

    #[napi(
        ts_args_type = "request: any, callback: (error: Error | null, update: SubscribeUpdate) => void",
        ts_return_type = "Promise<StreamHandle>"
    )]
    pub fn subscribe(&self, env: Env, request: Object, callback: JsFunction) -> Result<JsObject> {
        // Setup global lifecycle management on first use
        setup_global_lifecycle_management(&env)?;
        
        let subscribe_request = self.inner.js_to_subscribe_request(&env, request)?;

        // Threadsafe function that forwards a SubscribeUpdate to JS
        let ts_callback: ThreadsafeFunction<SubscribeUpdateWrapper, ErrorStrategy::CalleeHandled> =
            callback.create_threadsafe_function(0, |ctx| {
                let wrapper: SubscribeUpdateWrapper = ctx.value;
                let js_val = unsafe { SubscribeUpdateWrapper::to_napi_value(ctx.env.raw(), wrapper)? };
                Ok(vec![unsafe { JsUnknown::from_raw(ctx.env.raw(), js_val)? }])
            })?;

        let client_inner = self.inner.clone();

        env.spawn_future(async move {
            client_inner
                .subscribe_internal(subscribe_request, ts_callback)
                .await
        })
    }
}

// Stream handlee
#[napi]
pub struct StreamHandle {
    pub id: String,
    inner: Arc<stream::StreamInner>,
}

#[napi]
impl StreamHandle {
    #[napi]
    pub fn cancel(&self) -> Result<()> {
        // Unregister from global registry first
        unregister_stream(&self.id);
        println!("🛑 Laserstream: Stream {} cancelled (active: {})", 
                 &self.id[..8], get_active_stream_count());
        
        // Then cancel the actual stream
        self.inner.cancel()
    }
}

// Removed automatic cancellation on drop - streams should be cancelled explicitly
// impl Drop for StreamHandle {
//     fn drop(&mut self) {
//         let _ = self.inner.cancel();
//     }
// }

