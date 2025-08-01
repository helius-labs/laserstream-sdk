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
  console.log('📊 Laserstream Transaction Status Subscription Example');

  const config: LaserstreamConfig  = {
    apiKey: credentials.laserstreamProduction.apiKey,
    endpoint: credentials.laserstreamProduction.endpoint,
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
      if (update.transactionStatus) {
        const txStatus: SubscribeUpdateTransactionStatus = update.transactionStatus;
        console.log('\n📊 Transaction Status Update Received!');
        console.log('  - Slot:', txStatus.slot);
        console.log('  - Signature:', txStatus.signature ? bs58.encode(txStatus.signature) : 'N/A');
        console.log('  - Is Vote:', txStatus.isVote);
        console.log('  - Index:', txStatus.index);
        
        if (txStatus.err) {
          const error: TransactionError = txStatus.err;
          console.log('  - Error:', error.err ? Buffer.from(error.err).toString() : 'N/A');
        } else {
          console.log('  - Status: Success');
        }
      }
    },
    async (error: Error) => {
      console.error('❌ Stream error:', error);
    }
  );

  console.log(`✅ Transaction Status subscription started with ID: ${stream.id}`);

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('\n🛑 Cancelling stream...');
    stream.cancel();
    process.exit(0);
  });
}

runTransactionStatusSubscription().catch(console.error); 