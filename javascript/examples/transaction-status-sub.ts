import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';
const credentials = require('../test-config');

async function runTransactionStatusSubscription() {
  console.log('📊 Laserstream Transaction Status Subscription Example');

  const config: LaserstreamConfig  = {
    apiKey: credentials.laserstreamProduction.apiKey,
    endpoint: credentials.laserstreamProduction.endpoint,
  };

  // Subscribe to transaction status updates
  const request = {
    transactionsStatus: {
      "all-tx-status": {
        vote: false,    // Exclude vote transactions
        failed: false,  // Exclude failed transactions
        accountInclude: [],
        accountExclude: [],
        accountRequired: []
      }
    },
    commitment: CommitmentLevel.PROCESSED,
    accounts: {},
    slots: {},
    transactions: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  const stream = await subscribe(
    config,
    request,
    async (update: SubscribeUpdate) => {
      console.log('📊 Transaction Status Update:', update);
    },
    async (error: Error) => {
      console.error('❌ Stream error:', error);
    }
  );

  console.log(`✅ Transaction Status subscription started with ID: ${stream.id}`);

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('\n🛑 Cancelling stream...');
    stream.cancel();
    process.exit(0);
  });
}

runTransactionStatusSubscription().catch(console.error); 