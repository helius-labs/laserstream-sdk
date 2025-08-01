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
  console.log('💸 Laserstream Transaction Subscription Example');

  const config: LaserstreamConfig = {
    apiKey: credentials.laserstreamProduction.apiKey,
    endpoint: credentials.laserstreamProduction.endpoint,
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
      // Process transaction updates
      if (update.transaction) {
        const txUpdate: SubscribeUpdateTransaction = update.transaction;
        const txInfo: SubscribeUpdateTransactionInfo | undefined = txUpdate.transaction;
        
        if (txInfo?.transaction?.message?.versioned && 
            txInfo.transaction.message.addressTableLookups && 
            txInfo.transaction.message.addressTableLookups.length > 0) {
          
          const tx: Transaction = txInfo.transaction;
          const message: Message = tx.message!;
          console.log('\n🔍 Found Versioned Transaction with Address Table Lookups!');
          console.log('📋 Transaction signature:', tx.signatures[0] ? bs58.encode(tx.signatures[0]) : 'N/A');
          console.log('📊 Number of lookups:', message.addressTableLookups.length);
          
          message.addressTableLookups.forEach((lookup, index) => {
            // Check for type inconsistency
            const isAccountKeyString = typeof lookup.accountKey === 'string';
            const isAccountKeyBuffer = Buffer.isBuffer(lookup.accountKey);
            const isWritableIndexesArray = Array.isArray(lookup.writableIndexes);
            const isWritableIndexesBuffer = Buffer.isBuffer(lookup.writableIndexes);
            const isReadonlyIndexesArray = Array.isArray(lookup.readonlyIndexes);
            const isReadonlyIndexesBuffer = Buffer.isBuffer(lookup.readonlyIndexes);
            
            // Detect the inconsistency pattern
            const isStringArrayFormat = isAccountKeyString && isWritableIndexesArray && isReadonlyIndexesArray;
            const isBufferFormat = isAccountKeyBuffer && isWritableIndexesBuffer && isReadonlyIndexesBuffer;
            
            if (isStringArrayFormat) {
              console.log(`🚨 INCONSISTENCY DETECTED - Transaction ${tx.signatures[0] ? bs58.encode(tx.signatures[0]) : 'N/A'}`);
              console.log(`   Format: {accountKey: string, writableIndexes: number[], readonlyIndexes: number[]}`);
            } else if (!isBufferFormat) {
              console.log(`❓ MIXED TYPES - Transaction ${tx.signatures[0] ? bs58.encode(tx.signatures[0]) : 'N/A'}`);
              console.log(`   accountKey: ${typeof lookup.accountKey}, writableIndexes: ${Array.isArray(lookup.writableIndexes) ? 'array' : typeof lookup.writableIndexes}, readonlyIndexes: ${Array.isArray(lookup.readonlyIndexes) ? 'array' : typeof lookup.readonlyIndexes}`);
            }
          });
          
          console.log('\n' + '='.repeat(80) + '\n');
        }
      }
    },
    async (error: Error) => {
      console.error('❌ Stream error:', error);
    }
  );

  console.log(`✅ Transaction subscription started with ID: ${stream.id}`);

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('\n🛑 Cancelling stream...');
    stream.cancel();
    process.exit(0);
  });
}

runTransactionSubscription().catch(console.error); 