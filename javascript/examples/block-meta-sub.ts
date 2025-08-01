import { 
  subscribe, 
  CommitmentLevel, 
  SubscribeUpdate,
  SubscribeUpdateBlockMeta,
  LaserstreamConfig 
} from '../client';
const credentials = require('../test-config');

async function main() {
  console.log('🏗️ Laserstream Block Meta Subscription Example');

  const config: LaserstreamConfig = {
    apiKey: credentials.laserstreamProduction.apiKey,
    endpoint: credentials.laserstreamProduction.endpoint,
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
      if (update.blockMeta) {
        const blockMeta: SubscribeUpdateBlockMeta = update.blockMeta;
        console.log('\n🏗️ Block Meta Update Received!');
        console.log('  - Slot:', blockMeta.slot);
        console.log('  - Blockhash:', blockMeta.blockhash);
        console.log('  - Parent Slot:', blockMeta.parentSlot);
        console.log('  - Parent Blockhash:', blockMeta.parentBlockhash);
        console.log('  - Block Height:', blockMeta.blockHeight?.blockHeight || 'N/A');
        console.log('  - Block Time:', blockMeta.blockTime?.timestamp || 'N/A');
        console.log('  - Executed Transaction Count:', blockMeta.executedTransactionCount);
        console.log('  - Rewards:', blockMeta.rewards?.rewards?.length || 0);
      }
    },
    async (error: any) => {
      console.error('❌ Stream error:', error);
    }
  );

  console.log(`✅ Block Meta subscription started with ID: ${stream.id}`);

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('\n🛑 Cancelling stream...');
    stream.cancel();
    process.exit(0);
  });
}

main().catch(console.error); 