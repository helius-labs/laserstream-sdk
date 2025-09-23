import { 
  subscribe, 
  CommitmentLevel, 
  SubscribeUpdate,
  SubscribeUpdateTransactionStatus,
  TransactionError,
  LaserstreamConfig 
} from '../client';
import * as bs58 from 'bs58';
const credentials = require('../test-config');

async function runTransactionStatusSubscription() {

  const config: LaserstreamConfig  = {
    apiKey: "your-api-key",
    endpoint: "your-endpoint",
  };

  // Subscribe to transaction status updates
  const request = {
    transactionsStatus: {
      "all-tx-status": {
        vote: false,    // Exclude vote transactions
        failed: false,  // Exclude failed transactions
        accountInclude: [],
        accountExclude: [],
        accountRequired: []
      }
    },
    commitment: CommitmentLevel.PROCESSED,
    accounts: {},
    slots: {},
    transactions: {},
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

runTransactionStatusSubscription().catch(console.error);