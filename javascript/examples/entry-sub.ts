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
  console.log('📝 Laserstream Entry Subscription Example');

  const config: LaserstreamConfig = {
    apiKey: credentials.laserstreamProduction.apiKey,
    endpoint: credentials.laserstreamProduction.endpoint,
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
      if (update.entry) {
        const entryUpdate: SubscribeUpdateEntry = update.entry;
        console.log('\n📝 Entry Update Received!');
        console.log('  - Slot:', entryUpdate.slot);
        console.log('  - Index:', entryUpdate.index);
        console.log('  - Num Hashes:', entryUpdate.numHashes);
        console.log('  - Hash:', entryUpdate.hash ? bs58.encode(entryUpdate.hash) : 'N/A');
        console.log('  - Executed Transaction Count:', entryUpdate.executedTransactionCount);
        console.log('  - Starting Transaction Index:', entryUpdate.startingTransactionIndex);
      }
    },
    async (error: Error) => {
      console.error('❌ Stream error:', error);
    }
  );

  console.log(`✅ Entry subscription started with ID: ${stream.id}`);

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('\n🛑 Cancelling stream...');
    stream.cancel();
    process.exit(0);
  });
}

runEntrySubscription().catch(console.error); 