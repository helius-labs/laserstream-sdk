import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig, CompressionAlgorithms } from '../client';
const credentials = require('../test-config');

async function runBlockSubscription() {
  console.log('🧱 Laserstream Block Subscription Example');

  const config: LaserstreamConfig = {
    apiKey: credentials.laserstreamProduction.apiKey,
    endpoint: credentials.laserstreamProduction.endpoint,
    channelOptions: {
      'grpc.default_compression_algorithm': CompressionAlgorithms.zstd,
    },
  };

  // Subscribe to block updates
  const request = {
    blocks: {
      "all-blocks": {
        accountInclude: [],
        includeTransactions: true,
        includeAccounts: true,
        includeEntries: true
      }
    },
    commitment: CommitmentLevel.PROCESSED,
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