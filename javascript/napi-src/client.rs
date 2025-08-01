use napi::{bindgen_prelude::*, Env};
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;
use serde::Deserialize;
use serde_json;
use base64::{Engine as _, engine::general_purpose};

use yellowstone_grpc_proto::geyser::{
    SubscribeRequest, SubscribeRequestFilterAccounts, SubscribeRequestFilterBlocks,
    SubscribeRequestFilterSlots, SubscribeRequestFilterTransactions,
    SubscribeRequestFilterBlocksMeta, SubscribeRequestFilterEntry,
    SubscribeRequestAccountsDataSlice, SubscribeRequestPing,
    SubscribeRequestFilterAccountsFilter, SubscribeRequestFilterAccountsFilterMemcmp,
    SubscribeRequestFilterAccountsFilterLamports,
    subscribe_request_filter_accounts_filter_memcmp,
    subscribe_request_filter_accounts_filter_lamports,
    subscribe_request_filter_accounts_filter,
};

use crate::stream::StreamInner;

pub struct ClientInner {
    endpoint: String,
    token: Option<String>,
    max_reconnect_attempts: u32,
    channel_options: Option<ChannelOptions>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ChannelOptions {
    // gRPC standard channel options
    #[serde(rename = "grpc.max_send_message_length")]
    pub grpc_max_send_message_length: Option<i32>,
    #[serde(rename = "grpc.max_receive_message_length")]
    pub grpc_max_receive_message_length: Option<i32>,
    #[serde(rename = "grpc.keepalive_time_ms")]
    pub grpc_keepalive_time_ms: Option<i32>,
    #[serde(rename = "grpc.keepalive_timeout_ms")]
    pub grpc_keepalive_timeout_ms: Option<i32>,
    #[serde(rename = "grpc.keepalive_permit_without_calls")]
    pub grpc_keepalive_permit_without_calls: Option<i32>,
    #[serde(rename = "grpc.default_compression_algorithm")]
    pub grpc_default_compression_algorithm: Option<i32>,
    
    // Catch-all for other options
    #[serde(flatten)]
    pub other: HashMap<String, serde_json::Value>,
}

// Complete serde-based structures matching yellowstone-grpc proto exactly
#[derive(Deserialize, Debug)]
pub struct JsSubscribeRequest {
    pub accounts: Option<HashMap<String, JsAccountFilter>>,
    pub slots: Option<HashMap<String, JsSlotFilter>>,
    pub transactions: Option<HashMap<String, JsTransactionFilter>>,
    #[serde(alias = "transactionsStatus")]
    pub transactions_status: Option<HashMap<String, JsTransactionFilter>>,
    pub blocks: Option<HashMap<String, JsBlockFilter>>,
    #[serde(alias = "blocksMeta")]
    pub blocks_meta: Option<HashMap<String, JsBlockMetaFilter>>,
    pub entry: Option<HashMap<String, JsEntryFilter>>,
    pub commitment: Option<i32>,
    #[serde(alias = "accountsDataSlice")]
    pub accounts_data_slice: Option<Vec<JsAccountsDataSlice>>,
    pub ping: Option<JsPing>,
    #[serde(alias = "fromSlot")]
    pub from_slot: Option<u64>,
}

#[derive(Deserialize, Debug)]
pub struct JsAccountFilter {
    pub account: Option<Vec<String>>,
    pub owner: Option<Vec<String>>,
    pub filters: Option<Vec<JsAccountsFilter>>,
    #[serde(alias = "nonemptyTxnSignature")]
    pub nonempty_txn_signature: Option<bool>,
    // Add aliases for consistent interface matching transactions
    #[serde(alias = "accountInclude")]
    pub account_include: Option<Vec<String>>,
    #[serde(alias = "accountExclude")]
    pub account_exclude: Option<Vec<String>>,
    #[serde(alias = "accountRequired")]
    pub account_required: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
pub struct JsAccountsFilter {
    pub memcmp: Option<JsMemcmpFilter>,
    pub datasize: Option<u64>,
    #[serde(alias = "tokenAccountState")]
    pub token_account_state: Option<bool>,
    pub lamports: Option<JsLamportsFilter>,
}

#[derive(Deserialize, Debug)]
pub struct JsMemcmpFilter {
    pub offset: u64,
    pub bytes: Option<String>, // base64 encoded
    pub base58: Option<String>,
    pub base64: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct JsLamportsFilter {
    pub eq: Option<u64>,
    pub ne: Option<u64>,
    pub lt: Option<u64>,
    pub gt: Option<u64>,
}

#[derive(Deserialize, Debug)]
pub struct JsSlotFilter {
    #[serde(alias = "filterByCommitment")]
    pub filter_by_commitment: Option<bool>,
    #[serde(alias = "interslotUpdates")]
    pub interslot_updates: Option<bool>,
}

#[derive(Deserialize, Debug)]
pub struct JsTransactionFilter {
    pub vote: Option<bool>,
    pub failed: Option<bool>,
    pub signature: Option<String>,
    #[serde(alias = "accountInclude")]
    pub account_include: Option<Vec<String>>,
    #[serde(alias = "accountExclude")]
    pub account_exclude: Option<Vec<String>>,
    #[serde(alias = "accountRequired")]
    pub account_required: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
pub struct JsBlockFilter {
    #[serde(alias = "accountInclude")]
    pub account_include: Option<Vec<String>>,
    #[serde(alias = "includeTransactions")]
    pub include_transactions: Option<bool>,
    #[serde(alias = "includeAccounts")]
    pub include_accounts: Option<bool>,
    #[serde(alias = "includeEntries")]
    pub include_entries: Option<bool>,
}

#[derive(Deserialize, Debug)]
pub struct JsBlockMetaFilter {
    // Empty struct as per proto
}

#[derive(Deserialize, Debug)]
pub struct JsEntryFilter {
    // Empty struct as per proto
}

#[derive(Deserialize, Debug)]
pub struct JsAccountsDataSlice {
    pub offset: u64,
    pub length: u64,
}

#[derive(Deserialize, Debug)]
pub struct JsPing {
    pub id: i32,
}

impl ClientInner {
    pub fn new(
        endpoint: String,
        token: Option<String>,
        max_reconnect_attempts: Option<u32>,
        channel_options: Option<ChannelOptions>,
    ) -> Result<Self> {
        Ok(Self {
            endpoint,
            token,
            max_reconnect_attempts: max_reconnect_attempts.unwrap_or(120),
            channel_options,
        })
    }

    // Complete automatic deserialization matching yellowstone-grpc proto exactly
    pub fn js_to_subscribe_request(&self, env: &Env, js_obj: Object) -> Result<SubscribeRequest> {
        let js_request: JsSubscribeRequest = env.from_js_value(js_obj)?;
        
        let mut request = SubscribeRequest::default();
        
        // Handle accounts with complete filter support
        if let Some(accounts) = js_request.accounts {
            let mut accounts_map = HashMap::new();
            for (key, filter) in accounts {
                let mut yellowstone_filter = SubscribeRequestFilterAccounts::default();
                

                
                // Handle account field (legacy interface)
                if let Some(account_list) = filter.account {
                    yellowstone_filter.account = account_list;
                }
                
                // Handle accountInclude field (consistent interface)
                if let Some(account_include_list) = filter.account_include {
                    yellowstone_filter.account = account_include_list;
                }
                
                if let Some(owner_list) = filter.owner {
                    yellowstone_filter.owner = owner_list;
                }
                
                // Handle accountExclude - NOT directly supported by Yellowstone accounts filter
                // This would need to be implemented via complex filters, which is beyond scope
                if let Some(_account_exclude_list) = filter.account_exclude {
                    // accountExclude not directly supported for account subscriptions
                }
                
                // Handle accountRequired - NOT directly supported by Yellowstone accounts filter
                if let Some(_account_required_list) = filter.account_required {
                    // accountRequired not directly supported for account subscriptions
                }
                
                if let Some(nonempty_txn_signature) = filter.nonempty_txn_signature {
                    yellowstone_filter.nonempty_txn_signature = Some(nonempty_txn_signature);
                }
                
                // Handle complete filters
                if let Some(filters) = filter.filters {
                    let mut yellowstone_filters = Vec::new();
                    for js_filter in filters {
                        let mut yellowstone_accounts_filter = SubscribeRequestFilterAccountsFilter::default();
                        
                        if let Some(memcmp) = js_filter.memcmp {
                            let mut memcmp_filter = SubscribeRequestFilterAccountsFilterMemcmp {
                                offset: memcmp.offset,
                                data: None,
                            };
                            
                            if let Some(bytes_str) = memcmp.bytes {
                                let bytes_data = general_purpose::STANDARD.decode(&bytes_str)
                                    .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid base64 bytes: {}", e)))?;
                                memcmp_filter.data = Some(subscribe_request_filter_accounts_filter_memcmp::Data::Bytes(bytes_data));
                            } else if let Some(base58_str) = memcmp.base58 {
                                memcmp_filter.data = Some(subscribe_request_filter_accounts_filter_memcmp::Data::Base58(base58_str));
                            } else if let Some(base64_str) = memcmp.base64 {
                                memcmp_filter.data = Some(subscribe_request_filter_accounts_filter_memcmp::Data::Base64(base64_str));
                            }
                            
                            yellowstone_accounts_filter.filter = Some(subscribe_request_filter_accounts_filter::Filter::Memcmp(memcmp_filter));
                        }
                        
                        if let Some(datasize) = js_filter.datasize {
                            yellowstone_accounts_filter.filter = Some(subscribe_request_filter_accounts_filter::Filter::Datasize(datasize));
                        }
                        
                        if let Some(token_account_state) = js_filter.token_account_state {
                            yellowstone_accounts_filter.filter = Some(subscribe_request_filter_accounts_filter::Filter::TokenAccountState(token_account_state));
                        }
                        
                        if let Some(lamports) = js_filter.lamports {
                            let mut lamports_filter = SubscribeRequestFilterAccountsFilterLamports::default();
                            
                            if let Some(eq) = lamports.eq {
                                lamports_filter.cmp = Some(subscribe_request_filter_accounts_filter_lamports::Cmp::Eq(eq));
                            } else if let Some(ne) = lamports.ne {
                                lamports_filter.cmp = Some(subscribe_request_filter_accounts_filter_lamports::Cmp::Ne(ne));
                            } else if let Some(lt) = lamports.lt {
                                lamports_filter.cmp = Some(subscribe_request_filter_accounts_filter_lamports::Cmp::Lt(lt));
                            } else if let Some(gt) = lamports.gt {
                                lamports_filter.cmp = Some(subscribe_request_filter_accounts_filter_lamports::Cmp::Gt(gt));
                            }
                            
                            yellowstone_accounts_filter.filter = Some(subscribe_request_filter_accounts_filter::Filter::Lamports(lamports_filter));
                        }
                        
                        yellowstone_filters.push(yellowstone_accounts_filter);
                    }
                    yellowstone_filter.filters = yellowstone_filters;
                }
                
                accounts_map.insert(key, yellowstone_filter);
            }
            request.accounts = accounts_map;
        }
        
        // Handle slots with complete filter support
        if let Some(slots) = js_request.slots {
            let mut slots_map = HashMap::new();
            for (key, filter) in slots {
                let mut yellowstone_filter = SubscribeRequestFilterSlots::default();
                
                if let Some(filter_by_commitment) = filter.filter_by_commitment {
                    yellowstone_filter.filter_by_commitment = Some(filter_by_commitment);
                }
                
                if let Some(interslot_updates) = filter.interslot_updates {
                    yellowstone_filter.interslot_updates = Some(interslot_updates);
                }
                
                slots_map.insert(key, yellowstone_filter);
            }
            request.slots = slots_map;
        }
        
        // Handle transactions with complete filter support
        if let Some(transactions) = js_request.transactions {
            let mut transactions_map = HashMap::new();
            for (key, filter) in transactions {
                let mut yellowstone_filter = SubscribeRequestFilterTransactions::default();
                
                yellowstone_filter.vote = filter.vote;
                yellowstone_filter.failed = filter.failed;
                yellowstone_filter.signature = filter.signature;
                
                if let Some(account_include) = filter.account_include {
                    yellowstone_filter.account_include = account_include;
                }
                
                if let Some(account_exclude) = filter.account_exclude {
                    yellowstone_filter.account_exclude = account_exclude;
                }
                
                if let Some(account_required) = filter.account_required {
                    yellowstone_filter.account_required = account_required;
                }
                
                transactions_map.insert(key, yellowstone_filter);
            }
            request.transactions = transactions_map;
        }
        
        // Handle transactions_status with complete filter support
        if let Some(transactions_status) = js_request.transactions_status {
            let mut transactions_status_map = HashMap::new();
            for (key, filter) in transactions_status {
                let mut yellowstone_filter = SubscribeRequestFilterTransactions::default();
                
                yellowstone_filter.vote = filter.vote;
                yellowstone_filter.failed = filter.failed;
                yellowstone_filter.signature = filter.signature;
                
                if let Some(account_include) = filter.account_include {
                    yellowstone_filter.account_include = account_include;
                }
                
                if let Some(account_exclude) = filter.account_exclude {
                    yellowstone_filter.account_exclude = account_exclude;
                }
                
                if let Some(account_required) = filter.account_required {
                    yellowstone_filter.account_required = account_required;
                }
                
                transactions_status_map.insert(key, yellowstone_filter);
            }
            request.transactions_status = transactions_status_map;
        }
        
        // Handle blocks with complete filter support
        if let Some(blocks) = js_request.blocks {
            let mut blocks_map = HashMap::new();
            for (key, filter) in blocks {
                let mut yellowstone_filter = SubscribeRequestFilterBlocks::default();
                
                if let Some(account_include) = filter.account_include {
                    yellowstone_filter.account_include = account_include;
                }
                
                yellowstone_filter.include_transactions = filter.include_transactions;
                yellowstone_filter.include_accounts = filter.include_accounts;
                yellowstone_filter.include_entries = filter.include_entries;
                
                blocks_map.insert(key, yellowstone_filter);
            }
            request.blocks = blocks_map;
        }
        
        // Handle blocks_meta
        if let Some(blocks_meta) = js_request.blocks_meta {
            let mut blocks_meta_map = HashMap::new();
            for (key, _filter) in blocks_meta {
                blocks_meta_map.insert(key, SubscribeRequestFilterBlocksMeta::default());
            }
            request.blocks_meta = blocks_meta_map;
        }
        
        // Handle entry
        if let Some(entry) = js_request.entry {
            let mut entry_map = HashMap::new();
            for (key, _filter) in entry {
                entry_map.insert(key, SubscribeRequestFilterEntry::default());
            }
            request.entry = entry_map;
        }
        
        // Handle commitment
        request.commitment = js_request.commitment;
        
        // Handle accounts_data_slice
        if let Some(accounts_data_slice) = js_request.accounts_data_slice {
            let mut yellowstone_slices = Vec::new();
            for slice in accounts_data_slice {
                yellowstone_slices.push(SubscribeRequestAccountsDataSlice {
                    offset: slice.offset,
                    length: slice.length,
                });
            }
            request.accounts_data_slice = yellowstone_slices;
        }
        
        // Handle ping
        if let Some(ping) = js_request.ping {
            request.ping = Some(SubscribeRequestPing {
                id: ping.id,
            });
        }
        
        // Handle from_slot
        request.from_slot = js_request.from_slot;
        

        
        Ok(request)
    }

    pub async fn subscribe_internal_bytes(
        &self,
        subscribe_request: SubscribeRequest,
        ts_callback: napi::threadsafe_function::ThreadsafeFunction<
            crate::SubscribeUpdateBytes,
            napi::threadsafe_function::ErrorStrategy::CalleeHandled,
        >,
    ) -> Result<crate::StreamHandle> {
        let stream_id = Uuid::new_v4().to_string();

        let stream_inner = Arc::new(StreamInner::new_bytes(
            stream_id.clone(),
            self.endpoint.clone(),
            self.token.clone(),
            subscribe_request,
            ts_callback,
            self.max_reconnect_attempts,
            self.channel_options.clone(),
        )?);

        // Register stream in global registry for lifecycle management
        crate::register_stream(stream_id.clone(), stream_inner.clone());

        Ok(crate::StreamHandle {
            id: stream_id,
            inner: stream_inner,
        })
    }
}
