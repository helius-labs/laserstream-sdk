import { 
  subscribe, 
  CommitmentLevel, 
  SubscribeUpdate,
  SubscribeUpdateEntry,
  LaserstreamConfig 
} from '../client';
import * as bs58 from 'bs58';
const credentials = require('../test-config');

async function runEntrySubscription() {

  const config: LaserstreamConfig = {
    apiKey: "your-api-key",
    endpoint: "your-endpoint",
  };

  // Subscribe to entry updates
  const request = {
    entry: {
      "all-entries": {}
    },
    commitment: CommitmentLevel.PROCESSED,
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    accountsDataSlice: [],
  };

  const stream = await subscribe(
    config,
    request,
    async (update: SubscribeUpdate) => {
      console.log(JSON.stringify(update, null, 2));
    },
    (error) => {
      console.error('Stream error:', error);
    }
  );

  process.on('SIGINT', () => {
    stream.cancel();
    process.exit(0);
  });
}

runEntrySubscription().catch(console.error); 
