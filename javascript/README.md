# @helius-laserstream

JavaScript/TypeScript client for Laserstream. Features automatic reconnection with slot tracking - if connection is lost, the client automatically reconnects and continues streaming from the last processed slot, ensuring no data is missed.

## Installation

```bash
npm install helius-laserstream
```

## Usage Example

```typescript
import { subscribe, CommitmentLevel, LaserstreamConfig, SubscribeRequest } from 'helius-laserstream';

async function main() {
  const config: LaserstreamConfig = {
    apiKey: 'your-api-key',
    endpoint: 'your-endpoint',
  };

  const request: SubscribeRequest = {
    transactions: {
      client: {
        accountInclude: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
        accountExclude: [],
        accountRequired: [],
        vote: false,
        failed: false
      }
    },
    commitment: CommitmentLevel.CONFIRMED,
    // Empty objects for unused subscription types
    accounts: {},
    slots: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  // Client handles disconnections automatically:
  // - Reconnects on network issues
  // - Resumes from last processed slot
  // - Maintains subscription state
  await subscribe(
    config,
    request,
    async (data) => {
      console.log('Received update:', data);
    },
    async (error) => {
      console.error('Error:', error);
    }
  );
}

main().catch(console.error);
```

## Runtime Support

### Node.js
```bash
node your-app.js
```

### Bun
```bash
bun your-app.js
```

The library uses Node-API (NAPI) bindings which are supported natively by both runtimes.

## API Reference

### Core Functions

- `subscribe(config, request, onData, onError)` - Main streaming function
- `shutdownAllStreams()` - Gracefully shutdown all active streams
- `getActiveStreamCount()` - Get number of active streams

### Types

- `LaserstreamConfig` - Configuration interface
- `SubscribeRequest` - Stream subscription request
- `CommitmentLevel` - Solana commitment levels (PROCESSED, CONFIRMED, FINALIZED)

## Performance

This library is built with Rust NAPI bindings, providing significant performance improvements:

**40x faster throughput** compared to the standard Yellowstone gRPC client - Laserstream can pull past **1.3GB/s** compared to only **30MB/s** with the Yellowstone client.

To subscribe to all account updates you need a minimum **70MB/s** and to subscribe to all transaction data you need a minimum of **10MB/s**. These numbers will likely grow in the future so we recommend using the new LS Rust based client over the standard Yellowstone gRPC client to avoid streaming delays.

### Key Performance Features
- Zero-copy message passing
- Minimal JavaScript overhead  
- Native async/await support
- Optimized memory usage
- High-performance Rust implementation

## License

MIT 