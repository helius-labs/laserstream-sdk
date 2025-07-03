import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';
const blockMetaConfig = require('../test-config');

async function main() {
  console.log('🏗️ LaserStream Block Meta Subscription Example');
  console.log('='.repeat(50));

  const laserstreamConfig: LaserstreamConfig = {
    apiKey: blockMetaConfig.laserstreamProduction.apiKey,
    endpoint: blockMetaConfig.laserstreamProduction.endpoint,
  };

  const request = {
    blocksMeta: {
      "all-block-meta": {}
    },
    commitment: CommitmentLevel.Processed,
    // Empty objects for unused subscription types
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    entry: {},
    accountsDataSlice: [],
  };

  // Client handles disconnections automatically:
  // - Reconnects on network issues
  // - Resumes from last processed slot
  // - Maintains subscription state
  const stream = await subscribe(
    laserstreamConfig,
    request,
    async (update: SubscribeUpdate) => {
      console.log('🏗️ Block Meta Update:', update);
    },
    async (error: any) => {
      console.error('❌ Stream error:', error);
    }
  );

  console.log(`✅ Block Meta subscription started with ID: ${stream.id}`);

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('\n🛑 Cancelling stream...');
    stream.cancel();
    process.exit(0);
  });
}

main().catch(console.error); 