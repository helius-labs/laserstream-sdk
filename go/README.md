# Laserstream Go Client

A high-performance Go client for streaming real-time Solana data via gRPC.

## Installation

```bash
go get github.com/helius-labs/laserstream-sdk/go
```

## Quick Start

```go
package main

import (
    "context"
    "fmt"
    "log"
    
    laserstream "github.com/helius-labs/laserstream-sdk/go"
)

func main() {
    // Initialize client
    client := laserstream.NewClient(laserstream.LaserstreamConfig{
        Endpoint: "https://laserstream-mainnet-tyo.helius-rpc.com",
        APIKey:   "your-api-key",
    })
    
    // Create subscription request
    req := &laserstream.SubscribeRequest{
        Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
            "client": {},
        },
    }
    
    // Subscribe to updates
    err := client.Subscribe(req, 
        func(update *laserstream.SubscribeUpdate) {
            // Handle incoming data
            fmt.Printf("Received update: %+v\n", update)
        },
        func(err error) {
            // Handle errors
            log.Printf("Error: %v", err)
        },
    )
    
    if err != nil {
        log.Fatal(err)
    }
    
    // Keep the program running
    select {}
}
```

## Features

- **High Performance**: Optimized gRPC client with configurable message sizes and keepalive
- **Automatic Reconnection**: Built-in reconnection logic with exponential backoff
- **Slot Tracking**: Advanced slot tracking for reliable stream resumption
- **Flexible Endpoints**: Support for both URL and host:port endpoint formats
- **Comprehensive Types**: Full type definitions for all Solana data structures

## Configuration

```go
config := laserstream.LaserstreamConfig{
    Endpoint:             "https://laserstream-mainnet-tyo.helius-rpc.com",
    APIKey:               "your-api-key",
    MaxReconnectAttempts: &maxAttempts, // Optional: custom reconnect limit
}
```

## Subscription Types

### Accounts
```go
req := &laserstream.SubscribeRequest{
    Accounts: map[string]*laserstream.SubscribeRequestFilterAccounts{
        "account-filter": {
            Account: []string{"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
        },
    },
}
```

### Transactions
```go
req := &laserstream.SubscribeRequest{
    Transactions: map[string]*laserstream.SubscribeRequestFilterTransactions{
        "tx-filter": {
            AccountInclude: []string{"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
        },
    },
}
```

### Blocks
```go
req := &laserstream.SubscribeRequest{
    Blocks: map[string]*laserstream.SubscribeRequestFilterBlocks{
        "block-filter": {},
    },
}
```

### Slots
```go
req := &laserstream.SubscribeRequest{
    Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
        "slot-filter": {
            FilterByCommitment: &filterByCommitment,
        },
    },
}
```

## Error Handling

The client provides robust error handling with automatic reconnection:

```go
err := client.Subscribe(req,
    func(update *laserstream.SubscribeUpdate) {
        // Handle updates
    },
    func(err error) {
        // Handle connection errors, reconnection attempts, etc.
        log.Printf("Stream error: %v", err)
    },
)
```

## Commitment Levels

- `CommitmentLevel_PROCESSED`: Latest processed data (may be rolled back)
- `CommitmentLevel_CONFIRMED`: Confirmed by majority of cluster
- `CommitmentLevel_FINALIZED`: Finalized and cannot be rolled back

## Examples

See the [examples directory](./examples) for complete usage examples:

- [Account Subscriptions](./examples/account-sub.go)
- [Transaction Subscriptions](./examples/transaction-sub.go)
- [Block Subscriptions](./examples/block-sub.go)
- [Slot Subscriptions](./examples/slot-sub.go)

## Requirements

- Go 1.23.5 or later
- Valid Laserstream API key

## License

Licensed under the Apache License, Version 2.0. 