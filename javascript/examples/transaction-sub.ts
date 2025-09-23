import { 
  subscribe, 
  CommitmentLevel, 
  SubscribeUpdate,
  SubscribeUpdateTransaction,
  SubscribeUpdateTransactionInfo,
  Transaction,
  Message,
  MessageAddressTableLookup,
  TransactionStatusMeta,
  LaserstreamConfig 
} from '../client';
import * as bs58 from 'bs58';
const credentials = require('../test-config');

async function runTransactionSubscription() {

  const config: LaserstreamConfig = {
    apiKey: "your-api-key",
    endpoint: "your-endpoint",
  };

  // Subscribe to transaction updates
  const request = {
    transactions: {
      "all-transactions": {
        vote: false,    // Exclude vote transactions
        failed: false,  // Exclude failed transactions
        accountInclude: [],
        accountExclude: [],
        accountRequired: []
      }
    },
    commitment: CommitmentLevel.PROCESSED,
    // Empty objects for unused subscription types
    accounts: {},
    slots: {},
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
    (error) => {
      console.error("Stream error:", error);
    }
  );

  process.on("SIGINT", () => {
    stream.cancel();
    process.exit(0);
  });
}

runTransactionSubscription().catch(console.error);