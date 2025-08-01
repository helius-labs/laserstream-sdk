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
  console.log('🏦 Laserstream Account Subscription Example');

  const config: LaserstreamConfig = {
    apiKey: credentials.laserstreamProduction.apiKey,
    endpoint: credentials.laserstreamProduction.endpoint,
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
      if (update.account) {
        const accountUpdate: SubscribeUpdateAccount = update.account;
        console.log('\n🏦 Account Update Received!');
        console.log('  - Slot:', accountUpdate.slot);
        console.log('  - Is Startup:', accountUpdate.isStartup);
        
        if (accountUpdate.account) {
          const accountInfo: SubscribeUpdateAccountInfo = accountUpdate.account;
          console.log('  - Account Info:');
          console.log('    - Pubkey:', accountInfo.pubkey ? bs58.encode(accountInfo.pubkey) : 'N/A');
          console.log('    - Lamports:', accountInfo.lamports);
          console.log('    - Owner:', accountInfo.owner ? bs58.encode(accountInfo.owner) : 'N/A');
          console.log('    - Executable:', accountInfo.executable);
          console.log('    - Rent Epoch:', accountInfo.rentEpoch);
          console.log('    - Data Length:', accountInfo.data ? accountInfo.data.length : 0);
          console.log('    - Write Version:', accountInfo.writeVersion);
          console.log('    - Txn Signature:', accountInfo.txnSignature ? bs58.encode(accountInfo.txnSignature) : 'N/A');
        }
      }
    },
    async (err) => console.error('❌ Stream error:', err)
  );

  console.log(`✅ Account subscription started (id: ${stream.id})`);
}

main().catch(console.error); 
