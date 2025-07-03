import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';
const credentials = require('../test-config');

async function main() {
  console.log('🔍 LaserStream Accounts Data Slice Subscription Example');

  const config: LaserstreamConfig = {
    apiKey: credentials.laserstreamProduction.apiKey,
    endpoint: credentials.laserstreamProduction.endpoint,
  };

  const request = {
    accounts: {
      "spl-token-accounts": {
        account: [],
        owner: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], // SPL Token program
        filters: []
      }
    },
    accountsDataSlice: [
      {
        offset: 0,   // Start of account data
        length: 64   // First 64 bytes (mint + authority info)
      }
    ],
    commitment: CommitmentLevel.Processed,
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
  };

  const stream = await subscribe(
    config,
    request,
    async (update: SubscribeUpdate) => {
      console.log(update);
    },
    async (err) => console.error('❌ Stream error:', err)
  );

  console.log(`✅ Accounts data slice subscription started (id: ${stream.id})`);
}

main().catch(console.error); 