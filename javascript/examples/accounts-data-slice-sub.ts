import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';
const credentials = require('../test-config');

async function main() {

  const config: LaserstreamConfig = {
    apiKey: "your-api-key",
    endpoint: "your-endpoint",
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
    commitment: CommitmentLevel.PROCESSED,
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
      console.log(JSON.stringify(update, null, 2));
    },
    (error: Error) => {
      console.error("Stream error:", error);
    }
  );

  process.on("SIGINT", () => {
    stream.cancel();
    process.exit(0);
  });
}

main().catch(console.error); 
