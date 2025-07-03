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

## License

MIT 