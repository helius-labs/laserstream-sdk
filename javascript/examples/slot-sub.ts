import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';
// Type imports removed to avoid dependency issues
const credentials = require('../test-config');

async function main() {
  console.log('🎰 Laserstream Slot Subscription Example');

  const config: LaserstreamConfig = {
    apiKey: credentials.laserstreamProduction.apiKey,
    endpoint: credentials.laserstreamProduction.endpoint,
  };

  const request = {
    slots: {
      "all-slots": {}
    },
    commitment: CommitmentLevel.PROCESSED,
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