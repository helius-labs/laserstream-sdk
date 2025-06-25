# LaserStream JavaScript Client

High-performance Solana gRPC streaming client with Rust NAPI bindings for maximum throughput and minimal latency.

## Installation

```bash
npm install helius-laserstream
```

## Usage

```typescript
import { LaserstreamClient, CommitmentLevel } from 'helius-laserstream';
import { SubscribeUpdate } from '@triton-one/yellowstone-grpc';

async function main() {
  // Create client with your endpoint and API key
  const client = new LaserstreamClient(
    "https://your-endpoint.com",
    "your-api-key"
  );

  // Subscribe to account updates
  const subscribeRequest = {
    accounts: { 
      "my-accounts": {
        account: ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"], // Account to monitor
        owner: [],   // Or monitor by owner
        filters: []  // Or add filters
      }
    },
    commitment: CommitmentLevel.Processed
  };

  try {
    const stream = await client.subscribe(subscribeRequest, (error: Error | null, buffer: Buffer) => {
      if (error) {
        console.error('Stream error:', error);
        return;
      }

      // Raw protobuf buffer - decode when needed for maximum performance
      console.log('Received update:', buffer);
      
      // Optional: decode the message
      // const update = SubscribeUpdate.decode(buffer);
      // if (update.account) {
      //   console.log('Account update:', update.account);
      // }
    });
    
    console.log('Stream started with ID:', stream.id);
  } catch (error) {
    console.error('Subscription failed:', error);
  }
}

main().catch(console.error);
```

## Examples

Run the included examples:

```bash
npm run example:account-sub
npm run example:slot-sub  
npm run example:transaction-sub
```

## License

MIT