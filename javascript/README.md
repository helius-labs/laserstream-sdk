# Laserstream TypeScript Client

High-performance TypeScript client for streaming real-time Solana data via Laserstream with automatic reconnection and slot tracking.

## Installation

```bash
npm install helius-laserstream
```

## Quick Start

```typescript
import { subscribe, CommitmentLevel, LaserstreamConfig } from 'helius-laserstream';

async function main() {
  const config: LaserstreamConfig = {
    apiKey: 'your-api-key',
    endpoint: 'https://laserstream-mainnet-tyo.helius-rpc.com',
  };

  const request = {
    slots: {
      client: {}
    },
    commitment: CommitmentLevel.CONFIRMED,
  };

  const stream = await subscribe(
    config,
    request,
    async (update) => {
      console.log('Received:', update);
    },
    async (error) => {
      console.error('Error:', error);
    }
  );
}

main().catch(console.error);
```

## Configuration Examples

### Basic Configuration
```typescript
const config: LaserstreamConfig = {
  apiKey: 'your-api-key',
  endpoint: 'https://laserstream-mainnet-tyo.helius-rpc.com',

};
```

### Advanced Configuration with Channel Options
```typescript
import { LaserstreamConfig, ChannelOptions, CompressionAlgorithms } from 'helius-laserstream';

const channelOptions: ChannelOptions = {
  // Connection settings
  connectTimeoutSecs: 20,
  maxDecodingMessageSize: 2_000_000_000,  // 2GB
  maxEncodingMessageSize: 64_000_000,     // 64MB
  
  // Keepalive settings
  http2KeepAliveIntervalSecs: 15,
  keepAliveTimeoutSecs: 10,
  keepAliveWhileIdle: true,
  
  // Flow control
  initialStreamWindowSize: 8_388_608,      // 8MB
  initialConnectionWindowSize: 16_777_216, // 16MB
  
  // Performance
  http2AdaptiveWindow: true,
  tcpNodelay: true,
  bufferSize: 131_072, // 128KB
};

const config: LaserstreamConfig = {
  apiKey: 'your-api-key',
  endpoint: 'your-endpoint',
  maxReconnectAttempts: 10,
  channelOptions: channelOptions,
};
```

### Replay Control
```typescript
// Disable replay - start from current slot on reconnect
const config: LaserstreamConfig = {
  apiKey: 'your-api-key',
  endpoint: 'your-endpoint',
  replay: false, // Potential data gaps
};

// Enable replay (default) - resume from last processed slot
config.replay = true; // No data loss
```

## Subscription Examples

### Account Subscriptions
```typescript
const request = {
  accounts: {
    "usdc-accounts": {
      account: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
      owner: [],
      filters: []
    },
    "token-program-accounts": {
      account: [],
      owner: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      filters: []
    }
  },
  commitment: CommitmentLevel.CONFIRMED,
};
```

### Transaction Subscriptions
```typescript
const request = {
  transactions: {
    "token-txs": {
      accountInclude: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      accountExclude: [],
      accountRequired: [],
      vote: false,
      failed: false
    },
    "pump-txs": {
      accountInclude: ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"],
      accountExclude: [],
      accountRequired: [],
      vote: false,
      failed: false
    }
  },
  commitment: CommitmentLevel.CONFIRMED,
};
```

### Block Subscriptions
```typescript
const request = {
  blocks: {
    "all-blocks": {
      includeTransactions: true,
      includeAccounts: true
    }
  },
  blocksMeta: {
    "block-metadata": {}
  },
  commitment: CommitmentLevel.CONFIRMED,
};
```

### Slot Subscriptions
```typescript
const request = {
  slots: {
    "confirmed-slots": {
      filterByCommitment: true
    },
    "all-slots": {
      filterByCommitment: false
    }
  },
  commitment: CommitmentLevel.CONFIRMED,
};
```

### Multiple Subscriptions
```typescript
const request = {
  accounts: {
    "usdc-accounts": {
      account: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
      owner: [],
      filters: []
    }
  },
  transactions: {
    "token-txs": {
      accountInclude: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      accountExclude: [],
      accountRequired: [],
      vote: false,
      failed: false
    }
  },
  slots: {
    "slots": {}
  },
  commitment: CommitmentLevel.CONFIRMED,
};
```

## Stream Write - Dynamic Updates

```typescript
// Initial subscription
const stream = await subscribe(config, initialRequest, onData, onError);

// Later, update subscription dynamically
stream.write({
  accounts: {
    "new-program": {
      owner: ["new-program-id"],
      account: [],
      filters: []
    }
  }
});
```

## Compression Examples

### Zstd Compression (Recommended)
```typescript
import { CompressionAlgorithms } from 'helius-laserstream';

const config: LaserstreamConfig = {
  apiKey: 'your-api-key',
  endpoint: 'your-endpoint',
  channelOptions: {
    'grpc.default_compression_algorithm': CompressionAlgorithms.zstd,
    'grpc.max_receive_message_length': 1_000_000_000,
  }
};
```

### Gzip Compression
```typescript
const config: LaserstreamConfig = {
  apiKey: 'your-api-key',
  endpoint: 'your-endpoint',
  channelOptions: {
    'grpc.default_compression_algorithm': CompressionAlgorithms.gzip,
    'grpc.max_receive_message_length': 1_000_000_000,
  }
};
```

## Error Handling

```typescript
const stream = await subscribe(
  config,
  request,
  async (update) => {
    // Handle different update types
    if (update.account) {
      console.log('Account update:', update.account.account?.pubkey);
    }
    if (update.transaction) {
      console.log('Transaction:', update.transaction.transaction?.signature);
    }
    if (update.slot) {
      console.log('Slot:', update.slot.slot);
    }
  },
  async (error) => {
    console.error('Stream error:', error);
    // Handle reconnection, network issues, etc.
  }
);
```

## Commitment Levels

```typescript
import { CommitmentLevel } from 'helius-laserstream';

const request = {
  // Latest data (may be rolled back)
  commitment: CommitmentLevel.PROCESSED,
  
  // Confirmed by cluster majority
  // commitment: CommitmentLevel.CONFIRMED,
  
  // Finalized, cannot be rolled back
  // commitment: CommitmentLevel.FINALIZED,
  
  // ... filters
};
```

## Stream Management

```typescript
import { getActiveStreamCount, shutdownAllStreams } from 'helius-laserstream';

// Get active stream count
const activeStreams = getActiveStreamCount();
console.log(`Active streams: ${activeStreams}`);

// Cancel specific stream
stream.cancel();

// Shutdown all streams gracefully
await shutdownAllStreams();
```

## Complete Example

```typescript
import { subscribe, CommitmentLevel, LaserstreamConfig, CompressionAlgorithms } from 'helius-laserstream';

async function main() {
  const config: LaserstreamConfig = {
    apiKey: process.env.LASERSTREAM_API_KEY!,
    endpoint: process.env.LASERSTREAM_ENDPOINT!,
    maxReconnectAttempts: 10,
    channelOptions: {
      'grpc.default_compression_algorithm': CompressionAlgorithms.zstd,
      'grpc.max_receive_message_length': 1_000_000_000,
    }
  };

  const request = {
    slots: {
      "client": {}
    },
    transactions: {
      "token-txs": {
        accountInclude: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
        accountExclude: [],
        accountRequired: [],
        vote: false,
        failed: false
      }
    },
    commitment: CommitmentLevel.CONFIRMED,
  };

  try {
    const stream = await subscribe(
      config,
      request,
      async (update) => {
        if (update.slot) {
          console.log(`Slot ${update.slot.slot}: parent=${update.slot.parent}`);
        }
        if (update.transaction) {
          console.log(`Transaction: ${update.transaction.transaction?.signature}`);
        }
      },
      async (error) => {
        console.error('Stream error:', error);
      }
    );

    console.log(`Stream connected: ${stream.id}`);
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('Shutting down...');
      stream.cancel();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('Failed to start stream:', error);
    process.exit(1);
  }
}

main().catch(console.error);
```

## Runtime Support

### Node.js
```bash
node your-app.js
# or with TypeScript
npx ts-node your-app.ts
```

### Bun
```bash
bun your-app.js
# or with TypeScript  
bun your-app.ts
```

Both runtimes support Node-API (NAPI) bindings natively.

## Requirements

- Node.js 16.0.0 or later
- Valid Laserstream API key

## Examples Directory

See [`./examples/`](./examples/) for complete working examples:

- [`account-sub.ts`](./examples/account-sub.ts) - Account subscriptions
- [`transaction-sub.ts`](./examples/transaction-sub.ts) - Transaction filtering
- [`block-sub.ts`](./examples/block-sub.ts) - Block data streaming  
- [`slot-sub.ts`](./examples/slot-sub.ts) - Slot progression
- [`channel-options-example.ts`](./examples/channel-options-example.ts) - Performance tuning
- [`stream-write-example.ts`](./examples/stream-write-example.ts) - Dynamic updates
- [`compression-example.ts`](./examples/compression-example.ts) - Gzip compression
- [`compression-zstd-example.ts`](./examples/compression-zstd-example.ts) - Zstd compression