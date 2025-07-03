import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';
// Type imports removed to avoid dependency issues
const slotConfig = require('../test-config');

async function main() {
  console.log('🎰 LaserStream Slot Subscription Example');
  console.log('='.repeat(50));

  const config: LaserstreamConfig = {
    apiKey: slotConfig.laserstreamProduction.apiKey,
    endpoint: slotConfig.laserstreamProduction.endpoint,
  };

  const request = {
    slots: {
      "all-slots": {}
    },
    commitment: CommitmentLevel.Processed,
    accounts: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  const stream = await subscribe(
    config,
    request,
    async (update: SubscribeUpdate) => {
      console.log('🎰 Slot Update:', update);
    },
    async (err) => console.error('❌ Stream error:', err)
  );

  console.log(`✅ Slot subscription started (id: ${stream.id})`);
}

main().catch(console.error); 