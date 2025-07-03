import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';
const credentials = require('../test-config');

async function runBlockSubscription() {
  console.log('🧱 LaserStream Block Subscription Example');
  console.log('='.repeat(50));

  const config: LaserstreamConfig = {
    apiKey: credentials.laserstreamProduction.apiKey,
    endpoint: credentials.laserstreamProduction.endpoint,
  };

  // Subscribe to block updates
  const request = {
    blocks: {
      "all-blocks": {
        accountInclude: [],
        includeTransactions: false,
        includeAccounts: false,
        includeEntries: false
      }
    },
    commitment: CommitmentLevel.Processed,
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  const stream = await subscribe(
    config,
    request,
    async (update: SubscribeUpdate) => {
      console.log('🧱 Block Update:', update);
    },
    async (error: Error) => {
      console.error('❌ Stream error:', error);
    }
  );

  console.log(`✅ Block subscription started with ID: ${stream.id}`);

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('\n🛑 Cancelling stream...');
    stream.cancel();
    process.exit(0);
  });
}

runBlockSubscription().catch(console.error); 