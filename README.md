# LaserStream

High-performance gRPC client for streaming real-time Solana blockchain data. Built for developers who need reliable, low-latency Solana data with automatic reconnection and historical replay capabilities.

## 🚀 Key Features

- **Auto Reconnection**: Robust reconnection with configurable retry limits  
- **Slot Tracking**: Automatic replay from last processed slot on reconnect (no data loss)
- **Historical Replay**: Backfill missed data up to 3000 slots (~20 minutes)
- **Channel Options**: Fine-tune gRPC performance, compression, timeouts, buffer sizes
- **Stream Write**: Dynamic subscription updates without reconnecting
- **Replay Control**: Enable/disable slot replay behavior for different use cases
- **Compression**: Gzip and Zstd support (70-80% bandwidth reduction with Zstd)
- **Multiple Runtimes**: Node.js, Bun (JavaScript), native Rust, native Go

## 📦 Official SDKs

### TypeScript/JavaScript SDK
- **Location**: [`/javascript`](/javascript)  
- **Install**: `npm install helius-laserstream`
- **Architecture**: Rust core with NAPI bindings for zero-copy performance
- **Performance**: 40x faster than Yellowstone JavaScript client (1.3GB/s vs 30MB/s)
- **Runtime Support**: Node.js 16+ and Bun

### Rust SDK  
- **Location**: [`/rust`](/rust)
- **Install**: `cargo add helius-laserstream`
- **Architecture**: Native Rust implementation with zero overhead

### Go SDK
- **Location**: [`/go`](/go)  
- **Install**: `go get github.com/helius-labs/laserstream-sdk/go`
- **Architecture**: Native Go implementation with goroutine safety

## 🔧 Core Concepts

### Subscription Types
All SDKs support streaming these Solana data types:
- **Accounts**: Account state changes and updates
- **Transactions**: Transaction data with filtering options  
- **Blocks**: Complete block data with transactions and accounts
- **Slots**: Slot progression and metadata
- **Block Metadata**: Block headers without full transaction data
- **Transaction Status**: Transaction confirmation status
- **Entries**: Raw ledger entries
- **Account Data Slices**: Partial account data for efficiency

### Channel Options
Fine-tune gRPC performance with:
- **Connection Settings**: Timeouts, message size limits
- **Keepalive Settings**: Connection stability configuration  
- **Flow Control**: Window sizes, buffer settings
- **Compression**: Gzip or Zstd compression algorithms
- **Performance Options**: TCP settings, HTTP/2 optimization

### Replay Behavior
Control data consistency vs. performance:

**Replay Enabled (Default)**:
- Tracks processed slots internally
- On reconnect, resumes from last processed slot
- Guarantees no data loss during disconnections
- Slightly higher memory usage for slot tracking

**Replay Disabled**:
- No internal slot tracking
- On reconnect, starts from current slot  
- Faster reconnection, potential data gaps
- Lower memory footprint

### Stream Write
Dynamically update subscriptions without reconnecting:
- Add new filters to existing streams
- Remove or modify subscription parameters
- Immediate filter changes without connection overhead
- Supported across all three SDKs

## 🛠️ Quick Start Examples

### TypeScript/JavaScript
```typescript
import { subscribe, CommitmentLevel } from 'helius-laserstream';

const stream = await subscribe(
  { apiKey: 'your-key', endpoint: 'your-endpoint' },
  { slots: { client: {} }, commitment: CommitmentLevel.CONFIRMED },
  (update) => console.log('Update:', update),
  (error) => console.error('Error:', error)
);
```

### Rust
```rust
use helius_laserstream::{subscribe, LaserstreamConfig, grpc::SubscribeRequest};

let config = LaserstreamConfig::new(endpoint, api_key);
let request = SubscribeRequest { slots: [("client".to_string(), Default::default())].into(), ..Default::default() };
let (stream, _handle) = subscribe(config, request);
```

### Go
```go
import laserstream "github.com/helius-labs/laserstream-sdk/go"

client := laserstream.NewClient(laserstream.LaserstreamConfig{
    Endpoint: endpoint, APIKey: apiKey,
})
req := &laserstream.SubscribeRequest{
    Slots: map[string]*laserstream.SubscribeRequestFilterSlots{"client": {}},
}
client.Subscribe(req, dataHandler, errorHandler)
```

## 📚 Documentation & Guides

### Official Documentation
- **[LaserStream Overview](https://www.helius.dev/docs/laserstream)** - Complete LaserStream documentation
- **[LaserStream Clients](https://www.helius.dev/docs/laserstream/clients)** - Client SDKs

### LaserStream Guides
- **[Decoding Transaction Data](https://www.helius.dev/docs/laserstream/guides/decoding-transaction-data)** - Learn how to decode and parse transaction data for better understanding
- **[Account Subscription](https://www.helius.dev/docs/laserstream/guides/account-subscription)** - Subscribe to account updates and efficiently track on-chain state changes
- **[Measuring Latency](https://www.helius.dev/docs/laserstream/guides/measuring-latency)** - Measure and optimize LaserStream latency for your application

### Getting Started
Each SDK directory contains:
- **Installation instructions** and dependencies
- **Comprehensive examples** for all subscription types  
- **Channel options configuration** examples
- **Stream write usage** patterns
- **Language-specific best practices**

## 📄 License

MIT License - see individual SDK directories for details.