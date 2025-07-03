import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';
const txStatusCfg = require('../test-config');

async function runTransactionStatusSubscription() {
  console.log('📊 LaserStream Transaction Status Subscription Example');
  console.log('='.repeat(50));

  const config: LaserstreamConfig  = {
    apiKey: txStatusCfg.laserstreamProduction.apiKey,
    endpoint: txStatusCfg.laserstreamProduction.endpoint,
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
    commitment: CommitmentLevel.Processed,
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
    async (error: Error | null ) => {
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