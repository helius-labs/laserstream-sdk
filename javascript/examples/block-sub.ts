import { subscribe, CommitmentLevel, LaserstreamConfig, CompressionAlgorithms } from '../client';
const cfg = require('../test-config');

async function main() {
  const config: LaserstreamConfig = {
    apiKey: cfg.laserstreamProduction.apiKey,
    endpoint: cfg.laserstreamProduction.endpoint,
    channelOptions: {
      'grpc.default_compression_algorithm': CompressionAlgorithms.gzip,  // Try gzip instead
      'grpc.default_compression_level': 'high',  // High compression level
    },
  };

  const request = {
    blocks: {
      "client": {
        accountInclude: [],
        includeTransactions: false,
        includeAccounts: false,
        includeEntries: false
      }
    },
    commitment: CommitmentLevel.CONFIRMED,
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  await subscribe(
    config,
    request,
    async (update) => {
      if (update.block) {
        console.log(`Block: ${update.block.slot}`);
      }
    },
    async (error) => {
      console.error('Error:', error);
    }
  );

  // Keep alive
  await new Promise(() => {});
}

main().catch(console.error); 