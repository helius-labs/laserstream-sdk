import { 
  subscribe, 
  CommitmentLevel, 
  SubscribeUpdate,
  SubscribeUpdateBlockMeta,
  LaserstreamConfig 
} from '../client';
const credentials = require('../test-config');

async function main() {

  const config: LaserstreamConfig = {
    apiKey: "your-api-key",
    endpoint: "your-endpoint",
  };

  const request = {
    blocksMeta: {
      "all-block-meta": {}
    },
    commitment: CommitmentLevel.PROCESSED,
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
