# Laserstream Go Client

High-performance Go client for streaming real-time Solana data via Laserstream with automatic reconnection and slot tracking.

## Installation

```bash
go get github.com/helius-labs/laserstream-sdk/go
```

## Quick Start

```go
package main

import (
    "log"
    "os/signal"
    "syscall"
    
    laserstream "github.com/helius-labs/laserstream-sdk/go"
)

func main() {
    client := laserstream.NewClient(laserstream.LaserstreamConfig{
        Endpoint: "https://laserstream-mainnet-tyo.helius-rpc.com",
        APIKey:   "your-api-key",
    })

    req := &laserstream.SubscribeRequest{
        Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
            "client": {},
        },
    }

    err := client.Subscribe(req, 
        func(update *laserstream.SubscribeUpdate) {
            log.Printf("Received: %+v", update)
        },
        func(err error) {
            log.Printf("Error: %v", err)
        },
    )
    
    if err != nil {
        log.Fatal(err)
    }

    // Wait for interrupt
    c := make(chan os.Signal, 1)
    signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
    <-c
    
    client.Close()
}
```

## Configuration Examples

### Basic Configuration
```go
config := laserstream.LaserstreamConfig{
    Endpoint: "https://laserstream-mainnet-tyo.helius-rpc.com",
    APIKey:   "your-api-key",
}
```

### Advanced Configuration with Channel Options
```go
maxAttempts := 10
config := laserstream.LaserstreamConfig{
    Endpoint:             endpoint,
    APIKey:               apiKey,
    MaxReconnectAttempts: &maxAttempts,
    Replay:               true, // Enable/disable replay
    ChannelOptions: &laserstream.ChannelOptions{
        // Connection settings
        ConnectTimeoutSecs:    20,
        MaxRecvMsgSize:        2 * 1024 * 1024 * 1024, // 2GB
        MaxSendMsgSize:        64 * 1024 * 1024,       // 64MB
        
        // Keepalive settings
        KeepaliveTimeSecs:     15,
        KeepaliveTimeoutSecs:  10,
        PermitWithoutStream:   true,
        
        // Flow control
        InitialWindowSize:     8 * 1024 * 1024,  // 8MB
        InitialConnWindowSize: 16 * 1024 * 1024, // 16MB

        // Buffer sizes
        WriteBufferSize: 128 * 1024,
        ReadBufferSize:  128 * 1024,
    },
}
```

### Replay Control
```go
// Disable replay - start from current slot on reconnect
config := laserstream.LaserstreamConfig{
    Endpoint: endpoint,
    APIKey:   apiKey,
    Replay:   false, // Potential data gaps
}

// Enable replay (default) - resume from last processed slot
config.Replay = true // No data loss
```

## Subscription Examples

### Account Subscriptions
```go
commitmentLevel := laserstream.CommitmentLevel_CONFIRMED
req := &laserstream.SubscribeRequest{
    Accounts: map[string]*laserstream.SubscribeRequestFilterAccounts{
        "usdc-accounts": {
            Account: []string{"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"},
        },
        "token-program": {
            Owner: []string{"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
        },
    },
    Commitment: &commitmentLevel,
}
```

### Transaction Subscriptions
```go
vote := false
failed := false
req := &laserstream.SubscribeRequest{
    Transactions: map[string]*laserstream.SubscribeRequestFilterTransactions{
        "token-txs": {
            AccountInclude: []string{"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
            Vote:           &vote,
            Failed:         &failed,
        },
        "pump-txs": {
            AccountInclude: []string{"pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"},
        },
    },
    Commitment: &commitmentLevel,
}
```

### Block Subscriptions
```go
includeTransactions := true
includeAccounts := true
req := &laserstream.SubscribeRequest{
    Blocks: map[string]*laserstream.SubscribeRequestFilterBlocks{
        "all-blocks": {
            IncludeTransactions: &includeTransactions,
            IncludeAccounts:     &includeAccounts,
        },
    },
    Commitment: &commitmentLevel,
}
```

### Slot Subscriptions
```go
filterByCommitment := true
req := &laserstream.SubscribeRequest{
    Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
        "confirmed-slots": {
            FilterByCommitment: &filterByCommitment,
        },
        "all-slots": {},
    },
    Commitment: &commitmentLevel,
}
```

### Multiple Subscriptions
```go
req := &laserstream.SubscribeRequest{
    Accounts: map[string]*laserstream.SubscribeRequestFilterAccounts{
        "usdc": {
            Account: []string{"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"},
        },
    },
    Transactions: map[string]*laserstream.SubscribeRequestFilterTransactions{
        "token-txs": {
            AccountInclude: []string{"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
            Vote:           &[]bool{false}[0],
        },
    },
    Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
        "slots": {},
    },
    Commitment: &commitmentLevel,
}
```

## Stream Write - Dynamic Updates

```go
// Initial subscription
client.Subscribe(initialRequest, dataHandler, errorHandler)

// Later, update subscription dynamically
newRequest := &laserstream.SubscribeRequest{
    Accounts: map[string]*laserstream.SubscribeRequestFilterAccounts{
        "new-program": {
            Owner: []string{"new-program-id"},
        },
    },
}

err := client.Write(newRequest)
if err != nil {
    log.Printf("Write error: %v", err)
}
```

## Error Handling

```go
err := client.Subscribe(req,
    func(update *laserstream.SubscribeUpdate) {
        // Handle different update types
        if update.Account != nil {
            log.Printf("Account update: %s", update.Account.Account.Pubkey)
        }
        if update.Transaction != nil {
            log.Printf("Transaction: %s", update.Transaction.Transaction.Signature)
        }
        if update.Slot != nil {
            log.Printf("Slot: %d", update.Slot.Slot)
        }
    },
    func(err error) {
        // Handle errors, reconnection attempts
        log.Printf("Stream error: %v", err)
    },
)
```

## Commitment Levels

```go
// Latest data (may be rolled back)
commitmentLevel := laserstream.CommitmentLevel_PROCESSED

// Confirmed by cluster majority  
commitmentLevel := laserstream.CommitmentLevel_CONFIRMED

// Finalized, cannot be rolled back
commitmentLevel := laserstream.CommitmentLevel_FINALIZED

req := &laserstream.SubscribeRequest{
    Commitment: &commitmentLevel,
    // ... filters
}
```

## Complete Example with Signal Handling

```go
package main

import (
    "log"
    "os"
    "os/signal"
    "syscall"

    laserstream "github.com/helius-labs/laserstream-sdk/go"
    "github.com/joho/godotenv"
)

func main() {
    // Load environment variables
    godotenv.Load()
    
    endpoint := os.Getenv("LASERSTREAM_ENDPOINT")
    apiKey := os.Getenv("LASERSTREAM_API_KEY")
    
    if endpoint == "" || apiKey == "" {
        log.Fatal("LASERSTREAM_ENDPOINT and LASERSTREAM_API_KEY required")
    }

    // Configure client
    config := laserstream.LaserstreamConfig{
        Endpoint: endpoint,
        APIKey:   apiKey,
    }
    
    client := laserstream.NewClient(config)
    defer client.Close()

    // Create subscription
    commitmentLevel := laserstream.CommitmentLevel_CONFIRMED
    req := &laserstream.SubscribeRequest{
        Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
            "client": {},
        },
        Commitment: &commitmentLevel,
    }

    // Subscribe with handlers
    err := client.Subscribe(req,
        func(update *laserstream.SubscribeUpdate) {
            if update.Slot != nil {
                log.Printf("Slot %d: parent=%d", 
                    update.Slot.Slot, 
                    update.Slot.Parent)
            }
        },
        func(err error) {
            log.Printf("Error: %v", err)
        },
    )
    
    if err != nil {
        log.Fatal(err)
    }

    // Wait for interrupt signal
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    <-sigChan
    
    log.Println("Shutting down...")
}
```

## Go-Specific Features

- **Context Support**: All operations respect Go context cancellation
- **Goroutine Safe**: Client can be safely used across multiple goroutines
- **Memory Efficient**: Optimized for Go's garbage collector
- **Native Types**: Uses Go's native types and error handling patterns

## Requirements

- Go 1.23.5 or later
- Valid Laserstream API key

## Examples Directory

See [`./examples/`](./examples/) for complete working examples:

- [`account-sub.go`](./examples/account-sub.go) - Account subscriptions
- [`transaction-sub.go`](./examples/transaction-sub.go) - Transaction filtering  
- [`block-sub.go`](./examples/block-sub.go) - Block data streaming
- [`slot-sub.go`](./examples/slot-sub.go) - Slot progression
- [`channel-options-example.go`](./examples/channel-options-example.go) - Performance tuning
- [`stream-write-example.go`](./examples/stream-write-example.go) - Dynamic updates