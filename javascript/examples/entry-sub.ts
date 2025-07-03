import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';
const entryCfg = require('../test-config');

async function runEntrySubscription() {
  console.log('📝 LaserStream Entry Subscription Example');
  console.log('='.repeat(50));

  const config: LaserstreamConfig = {
    apiKey: entryCfg.laserstreamProduction.apiKey,
    endpoint: entryCfg.laserstreamProduction.endpoint,
  };

  // Subscribe to entry updates
  const request = {
    entry: {
      "all-entries": {}
    },
    commitment: CommitmentLevel.Processed,
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
      console.log('📝 Entry Update:', update);
    },
    async (error: any) => {
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