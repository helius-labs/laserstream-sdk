import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';
const txConfig = require('../test-config');

async function runTransactionSubscription() {
  console.log('💸 LaserStream Transaction Subscription Example');

  const config: LaserstreamConfig = {
    apiKey: txConfig.laserstreamProduction.apiKey,
    endpoint: txConfig.laserstreamProduction.endpoint,
  };

  // Subscribe to transaction updates
  const request = {
    transactions: {
      "all-transactions": {
        vote: false,    // Exclude vote transactions
        failed: false,  // Exclude failed transactions
        accountInclude: [],
        accountExclude: [],
        accountRequired: []
      }
    },
    commitment: CommitmentLevel.Processed,
    // Empty objects for unused subscription types
    accounts: {},
    slots: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  let messageCount = 0;
  const startTime = Date.now();

  const stream = await subscribe(
    config,
    request,
    async (update: SubscribeUpdate) => {
      console.log('💸 Transaction Update:', update);
    },
    async (error: any) => {
      console.error('❌ Stream error:', error);
    }
  );

  console.log(`✅ Transaction subscription started with ID: ${stream.id}`);

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('\n🛑 Cancelling stream...');
    stream.cancel();
    process.exit(0);
  });
}

runTransactionSubscription().catch(console.error); 