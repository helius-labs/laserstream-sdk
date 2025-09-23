import { 
  subscribe, 
  CommitmentLevel, 
  SubscribeUpdate, 
  SubscribeUpdateAccount,
  SubscribeUpdateAccountInfo,
  LaserstreamConfig 
} from '../client';
import * as bs58 from 'bs58';
const credentials = require('../test-config');

async function main() {

  const config: LaserstreamConfig = {
    apiKey: "your-api-key",
    endpoint: "your-endpoint",
  };

  const request = {
    accounts: {
      "all-accounts": {
        account: [],
        owner: [],
        filters: []
      }
    },
    commitment: CommitmentLevel.PROCESSED,
    slots: {},
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
