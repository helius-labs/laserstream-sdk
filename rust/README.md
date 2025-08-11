# Laserstream Rust Client

High-performance Rust client for streaming real-time Solana data via Laserstream with automatic reconnection and slot tracking.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
helius-laserstream = "0.0.9"
futures-util = "0.3"
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
```

Or use `cargo add`:

```bash
cargo add helius-laserstream futures-util
cargo add tokio --features rt-multi-thread,macros
```

## Quick Start

```rust
use futures_util::StreamExt;
use helius_laserstream::{subscribe, LaserstreamConfig, grpc::SubscribeRequest};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = LaserstreamConfig::new(
        "https://laserstream-mainnet-tyo.helius-rpc.com".to_string(),
        "your-api-key".to_string()
    );

    let request = SubscribeRequest {
        slots: [("client".to_string(), Default::default())].into(),
        ..Default::default()
    };

    let (stream, _handle) = subscribe(config, request);
    futures::pin_mut!(stream);

    while let Some(result) = stream.next().await {
        match result {
            Ok(update) => println!("Received: {:?}", update),
            Err(e) => eprintln!("Error: {}", e),
        }
    }

    Ok(())
}
```

## Configuration Examples

### Basic Configuration
```rust
use helius_laserstream::LaserstreamConfig;

let config = LaserstreamConfig::new(
    "https://laserstream-mainnet-tyo.helius-rpc.com".to_string(),
    "your-api-key".to_string()
);
```

### Advanced Configuration
```rust
use helius_laserstream::{LaserstreamConfig, ChannelOptions};

let channel_options = ChannelOptions::default()
    .with_connect_timeout_secs(20)
    .with_max_receive_message_length(2_000_000_000) // 2GB
    .with_max_send_message_length(64_000_000)       // 64MB
    .with_keepalive_time_secs(15)
    .with_keepalive_timeout_secs(10)
    .with_initial_stream_window_size(8_388_608)     // 8MB
    .with_initial_connection_window_size(16_777_216) // 16MB
    .with_zstd_compression();

let config = LaserstreamConfig::new(endpoint, api_key)
    .with_max_reconnect_attempts(10)
    .with_channel_options(channel_options);
```

### Replay Control
```rust
// Disable replay - start from current slot on reconnect
let config = LaserstreamConfig::new(endpoint, api_key)
    .with_replay(false); // Potential data gaps

// Enable replay (default) - resume from last processed slot  
let config = LaserstreamConfig::new(endpoint, api_key)
    .with_replay(true); // No data loss
```

## Subscription Examples

### Account Subscriptions
```rust
use helius_laserstream::grpc::{SubscribeRequest, SubscribeRequestFilterAccounts};
use std::collections::HashMap;

let request = SubscribeRequest {
    accounts: HashMap::from([
        (
            "usdc-accounts".to_string(),
            SubscribeRequestFilterAccounts {
                account: vec!["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string()],
                ..Default::default()
            }
        ),
        (
            "token-program-accounts".to_string(),
            SubscribeRequestFilterAccounts {
                owner: vec!["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".to_string()],
                ..Default::default()
            }
        )
    ]),
    ..Default::default()
};
```

### Transaction Subscriptions
```rust
use helius_laserstream::grpc::{SubscribeRequest, SubscribeRequestFilterTransactions};

let request = SubscribeRequest {
    transactions: HashMap::from([
        (
            "token-txs".to_string(), 
            SubscribeRequestFilterTransactions {
                account_include: vec!["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".to_string()],
                vote: Some(false),
                failed: Some(false),
                ..Default::default()
            }
        ),
        (
            "pump-txs".to_string(),
            SubscribeRequestFilterTransactions {
                account_include: vec!["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA".to_string()],
                vote: Some(false),
                failed: Some(false),
                ..Default::default()
            }
        )
    ]),
    ..Default::default()
};
```

### Block Subscriptions
```rust
use helius_laserstream::grpc::{
    SubscribeRequest, SubscribeRequestFilterBlocks, SubscribeRequestFilterBlocksMeta
};

let request = SubscribeRequest {
    blocks: HashMap::from([
        (
            "all-blocks".to_string(),
            SubscribeRequestFilterBlocks {
                include_transactions: Some(true),
                include_accounts: Some(true),
                ..Default::default()
            }
        )
    ]),
    blocks_meta: HashMap::from([
        (
            "block-metadata".to_string(),
            SubscribeRequestFilterBlocksMeta::default()
        )
    ]),
    ..Default::default()
};
```

### Slot Subscriptions
```rust
use helius_laserstream::grpc::{SubscribeRequest, SubscribeRequestFilterSlots};

let request = SubscribeRequest {
    slots: HashMap::from([
        (
            "confirmed-slots".to_string(),
            SubscribeRequestFilterSlots {
                filter_by_commitment: Some(true),
                ..Default::default()
            }
        ),
        (
            "all-slots".to_string(),
            SubscribeRequestFilterSlots::default()
        )
    ]),
    ..Default::default()
};
```

### Multiple Subscriptions
```rust
use helius_laserstream::grpc::*;
use std::collections::HashMap;

let mut request = SubscribeRequest::default();

// Add accounts filter
request.accounts.insert(
    "usdc-accounts".to_string(),
    SubscribeRequestFilterAccounts {
        account: vec!["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".to_string()],
        ..Default::default()
    }
);

// Add transactions filter  
request.transactions.insert(
    "token-txs".to_string(),
    SubscribeRequestFilterTransactions {
        account_include: vec!["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".to_string()],
        vote: Some(false),
        ..Default::default()
    }
);

// Add slots filter
request.slots.insert(
    "slots".to_string(),
    SubscribeRequestFilterSlots::default()
);
```

## Stream Write - Dynamic Updates

```rust
use helius_laserstream::grpc::*;
use futures_util::StreamExt;
use tokio::time::{sleep, Duration};

let (stream, handle) = subscribe(config, initial_request);
tokio::pin!(stream);

// In another task or after some condition
let write_handle = handle.clone();
tokio::spawn(async move {
    sleep(Duration::from_secs(5)).await;
    
    let new_request = SubscribeRequest {
        accounts: HashMap::from([
            (
                "new-program".to_string(),
                SubscribeRequestFilterAccounts {
                    owner: vec!["new-program-id".to_string()],
                    ..Default::default()
                }
            )
        ]),
        ..Default::default()
    };
    
    if let Err(e) = write_handle.write(new_request).await {
        eprintln!("Write error: {}", e);
    }
});

// Continue processing stream
while let Some(result) = stream.next().await {
    // Handle updates...
}
```

## Compression Examples

### Zstd Compression (Recommended)
```rust
let channel_options = ChannelOptions::default()
    .with_zstd_compression();

let config = LaserstreamConfig::new(endpoint, api_key)
    .with_channel_options(channel_options);
```

### Gzip Compression
```rust
let channel_options = ChannelOptions::default()
    .with_gzip_compression();

let config = LaserstreamConfig::new(endpoint, api_key)
    .with_channel_options(channel_options);
```

### Custom Compression
```rust
use helius_laserstream::CompressionEncoding;

let channel_options = ChannelOptions::default()
    .with_compression(CompressionEncoding::Zstd, CompressionEncoding::Gzip);
```

## Error Handling

```rust
use helius_laserstream::LaserstreamError;

while let Some(result) = stream.next().await {
    match result {
        Ok(update) => {
            // Handle different update types
            if let Some(account_update) = &update.account {
                println!("Account: {}", account_update.account.pubkey);
            }
            if let Some(tx_update) = &update.transaction {
                println!("Transaction: {:?}", tx_update.transaction.signature);
            }
            if let Some(slot_update) = &update.slot {
                println!("Slot: {}", slot_update.slot);
            }
        }
        Err(LaserstreamError::Connection(e)) => {
            eprintln!("Connection error: {}", e);
        }
        Err(LaserstreamError::Grpc(e)) => {
            eprintln!("gRPC error: {}", e);
        }
        Err(e) => {
            eprintln!("Other error: {}", e);
        }
    }
}
```

## Commitment Levels

```rust
use helius_laserstream::grpc::CommitmentLevel;

let request = SubscribeRequest {
    // Latest data (may be rolled back)
    commitment: Some(CommitmentLevel::Processed as i32),
    
    // Confirmed by cluster majority
    // commitment: Some(CommitmentLevel::Confirmed as i32),
    
    // Finalized, cannot be rolled back
    // commitment: Some(CommitmentLevel::Finalized as i32),
    
    // ... filters
    ..Default::default()
};
```

## Complete Example with Environment Variables

```rust
use futures_util::StreamExt;
use helius_laserstream::{subscribe, LaserstreamConfig, ChannelOptions, grpc::*};
use std::{env, collections::HashMap};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load environment variables
    dotenv::from_path("../.env").ok();
    
    let api_key = env::var("LASERSTREAM_API_KEY")
        .expect("LASERSTREAM_API_KEY not set");
    let endpoint = env::var("LASERSTREAM_ENDPOINT")
        .expect("LASERSTREAM_ENDPOINT not set");

    // Configure client with compression
    let channel_options = ChannelOptions::default()
        .with_zstd_compression()
        .with_max_receive_message_length(1_000_000_000);

    let config = LaserstreamConfig::new(endpoint, api_key)
        .with_channel_options(channel_options);

    // Create subscription request
    let request = SubscribeRequest {
        slots: HashMap::from([
            ("client".to_string(), SubscribeRequestFilterSlots::default())
        ]),
        transactions: HashMap::from([
            (
                "token-txs".to_string(),
                SubscribeRequestFilterTransactions {
                    account_include: vec!["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".to_string()],
                    vote: Some(false),
                    failed: Some(false),
                    ..Default::default()
                }
            )
        ]),
        commitment: Some(CommitmentLevel::Confirmed as i32),
        ..Default::default()
    };

    println!("Connecting to LaserStream...");
    let (stream, _handle) = subscribe(config, request);
    tokio::pin!(stream);

    // Process updates
    while let Some(result) = stream.next().await {
        match result {
            Ok(update) => {
                if let Some(slot) = &update.slot {
                    println!("Slot {}: parent={}", slot.slot, slot.parent);
                }
                if let Some(tx) = &update.transaction {
                    println!("Transaction: {:?}", tx.transaction.signature);
                }
            }
            Err(e) => {
                eprintln!("Stream error: {}", e);
                // The client will automatically attempt to reconnect
            }
        }
    }

    Ok(())
}
```

## Channel Options Builder Pattern

```rust
use helius_laserstream::ChannelOptions;

let options = ChannelOptions::default()
    // Connection settings
    .with_connect_timeout_secs(20)
    .with_timeout_secs(60)
    
    // Message sizes
    .with_max_receive_message_length(2_000_000_000)
    .with_max_send_message_length(64_000_000)
    
    // Keepalive
    .with_keepalive_time_secs(15)
    .with_keepalive_timeout_secs(10)
    .with_keepalive_while_idle(true)
    
    // Flow control
    .with_initial_stream_window_size(8_388_608)
    .with_initial_connection_window_size(16_777_216)
    
    // Performance
    .with_http2_adaptive_window(true)
    .with_tcp_nodelay(true)
    .with_tcp_keepalive_secs(30)
    
    // Compression
    .with_zstd_compression();
```

## Requirements

- Rust 1.70 or later
- Valid Laserstream API key

## Examples Directory

See [`./examples/`](./examples/) for complete working examples:

- [`basic_usage.rs`](./examples/basic_usage.rs) - Getting started
- [`account_sub.rs`](./examples/account_sub.rs) - Account subscriptions
- [`transaction_sub.rs`](./examples/transaction_sub.rs) - Transaction filtering
- [`block_sub.rs`](./examples/block_sub.rs) - Block data streaming
- [`slot_sub.rs`](./examples/slot_sub.rs) - Slot progression
- [`channel-options-example.rs`](./examples/channel-options-example.rs) - Performance tuning
- [`stream_write_example.rs`](./examples/stream_write_example.rs) - Dynamic updates
- [`compression-example.rs`](./examples/compression-example.rs) - Compression usage