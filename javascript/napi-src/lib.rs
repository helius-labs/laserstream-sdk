mod client;
mod proto;
mod stream;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Env, JsFunction, JsObject};
use napi_derive::napi;
use std::sync::Arc;
use yellowstone_grpc_proto;
use yellowstone_grpc_proto::geyser::SubscribeUpdate;
use napi::{JsUnknown, NapiValue, NapiRaw};
use bs58;

// Re-export the generated protobuf types
pub use proto::*;
pub use yellowstone_grpc_proto::geyser::*;

// Custom wrapper for SubscribeUpdate that implements ToNapiValue
pub struct SubscribeUpdateWrapper(pub SubscribeUpdate);

impl ToNapiValue for SubscribeUpdateWrapper {
    unsafe fn to_napi_value(env: napi::sys::napi_env, val: Self) -> napi::Result<napi::sys::napi_value> {
        // Create a full SubscribeUpdate-compatible class with all methods
        create_subscribe_update_class(env, val.0)
    }
}

// Create a complete SubscribeUpdate class that matches Yellowstone gRPC interface
fn create_subscribe_update_class(env: napi::sys::napi_env, update: SubscribeUpdate) -> napi::Result<napi::sys::napi_value> {
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
    
    // Add the specific update type (matching Yellowstone field names exactly)
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
    
    if let Some(ref parent) = slot_update.parent {
        obj.set_named_property("parent", env.create_string(&parent.to_string())?)?;
    }
    
    obj.set_named_property("status", env.create_int32(slot_update.status as i32)?)?;
    
    if let Some(ref dead_error) = slot_update.dead_error {
        obj.set_named_property("deadError", env.create_string(dead_error)?)?;
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
        
        // Add transaction field (this references the inner transaction structure)
        if let Some(ref inner_transaction) = transaction.transaction {
            // The transaction field contains the actual transaction data
            // For now, we'll create a simplified representation
            let mut inner_tx_obj = env.create_object()?;
            // This would need to be expanded based on the actual Solana transaction structure
            tx_obj.set_named_property("transaction", inner_tx_obj)?;
        }
        
        obj.set_named_property("transaction", tx_obj)?;
    }
    
    // Add meta if present (from the transaction info, not tx_update directly)
    if let Some(ref transaction) = tx_update.transaction {
        if let Some(ref meta) = transaction.meta {
            let mut meta_obj = env.create_object()?;
            // Meta conversion would go here - simplified for now
            obj.set_named_property("meta", meta_obj)?;
        }
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
    
    // Convert error if present
    if let Some(ref err) = tx_status_update.err {
        obj.set_named_property("err", env.create_string(&format!("{:?}", err))?)?;
    }
    
    Ok(obj)
}

fn convert_block_update_to_js(env: &napi::Env, block_update: &yellowstone_grpc_proto::geyser::SubscribeUpdateBlock) -> napi::Result<napi::JsObject> {
    let mut obj = env.create_object()?;
    
    // slot as string (matching Yellowstone interface)
    obj.set_named_property("slot", env.create_string(&block_update.slot.to_string())?)?;
    obj.set_named_property("blockhash", env.create_string(&block_update.blockhash)?)?;
    
    // Handle blockTime as UnixTimestamp object (matching Yellowstone interface)
    if let Some(ref block_time) = block_update.block_time {
        let mut block_time_obj = env.create_object()?;
        // UnixTimestamp has a single i64 timestamp field - convert to string as expected
        let timestamp_str = block_time.timestamp.to_string();
        block_time_obj.set_named_property("timestamp", env.create_string(&timestamp_str)?)?;
        obj.set_named_property("blockTime", block_time_obj)?;
    }
    
    // Add other block fields as needed
    obj.set_named_property("parentSlot", env.create_string(&block_update.parent_slot.to_string())?)?;
    obj.set_named_property("parentBlockhash", env.create_string(&block_update.parent_blockhash)?)?;
    
    Ok(obj)
}

fn convert_block_meta_update_to_js(env: &napi::Env, block_meta_update: &yellowstone_grpc_proto::geyser::SubscribeUpdateBlockMeta) -> napi::Result<napi::JsObject> {
    let mut obj = env.create_object()?;
    
    // slot as string (matching Yellowstone interface)
    obj.set_named_property("slot", env.create_string(&block_meta_update.slot.to_string())?)?;
    obj.set_named_property("blockhash", env.create_string(&block_meta_update.blockhash)?)?;
    
    // Handle blockTime as UnixTimestamp object (matching Yellowstone interface)
    if let Some(ref block_time) = block_meta_update.block_time {
        let mut block_time_obj = env.create_object()?;
        // UnixTimestamp has a single i64 timestamp field - convert to string as expected
        let timestamp_str = block_time.timestamp.to_string();
        block_time_obj.set_named_property("timestamp", env.create_string(&timestamp_str)?)?;
        obj.set_named_property("blockTime", block_time_obj)?;
    }
    
    obj.set_named_property("parentSlot", env.create_string(&block_meta_update.parent_slot.to_string())?)?;
    obj.set_named_property("parentBlockhash", env.create_string(&block_meta_update.parent_blockhash)?)?;
    
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
        self.inner.cancel()
    }
}

impl Drop for StreamHandle {
    fn drop(&mut self) {
        let _ = self.inner.cancel();
    }
}

