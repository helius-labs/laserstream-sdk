import { LaserstreamClient, SubscribeUpdate } from '.';
import createClient, { SubscribeRequest, SubscribeUpdate as YellowstoneUpdate } from '@triton-one/yellowstone-grpc';

const config = require('./test-config.js');

// Get subscription type from command line argument
const subType = process.argv[2];

if (!subType) {
  console.log('Usage: ts-node test-single-sub.ts <subscription-type>');
  console.log('Available types: account, slot, transaction, transaction-status, block, block-meta, entry');
  process.exit(1);
}

// Test configurations for different subscription types
const testConfigs: { [key: string]: any } = {
  'account': {
    name: 'Account',
    request: {
      accounts: { 'test-account': { 
        account: [], 
        owner: ['11111111111111111111111111111112'], 
        filters: [] 
      } },
      slots: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: 1,
      ping: undefined
    },
    timeout: 25000
  },
  'slot': {
    name: 'Slot',
    request: {
      accounts: {},
      slots: { 'test-slot': {} },
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: 1,
      ping: undefined
    },
    timeout: 15000
  },
  'transaction': {
    name: 'Transaction',
    request: {
      accounts: {},
      slots: {},
      transactions: { 'test-tx': { accountInclude: [], accountExclude: [], accountRequired: [] } },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: 1,
      ping: undefined
    },
    timeout: 15000
  },
  'transaction-status': {
    name: 'Transaction Status',
    request: {
      accounts: {},
      slots: {},
      transactions: {},
      transactionsStatus: { 'test-tx-status': { 
        accountInclude: [], 
        accountExclude: [], 
        accountRequired: [],
        vote: false
      } },
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: 1,
      ping: undefined
    },
    timeout: 20000
  },
  'block': {
    name: 'Block',
    request: {
      accounts: {},
      slots: {},
      transactions: {},
      transactionsStatus: {},
      blocks: { 'test-block': { accountInclude: [], accountExclude: [], accountRequired: [], includeTransactions: true, includeAccounts: true, includeEntries: true } },
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: 1,
      ping: undefined
    },
    timeout: 20000
  },
  'block-meta': {
    name: 'Block Meta',
    request: {
      accounts: {},
      slots: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: { 'test-block-meta': {} },
      entry: {},
      accountsDataSlice: [],
      commitment: 1,
      ping: undefined
    },
    timeout: 25000
  },
  'entry': {
    name: 'Entry',
    request: {
      accounts: {},
      slots: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: { 'test-entry': {} },
      accountsDataSlice: [],
      commitment: 1,
      ping: undefined
    },
    timeout: 15000
  }
};

async function testSingleSubscription() {
  const testConfig = testConfigs[subType];
  
  if (!testConfig) {
    console.error(`❌ Unknown subscription type: ${subType}`);
    console.log('Available types:', Object.keys(testConfigs).join(', '));
    process.exit(1);
  }
  
  console.log(`🔍 Testing ${testConfig.name} subscription...\n`);
  
  try {
    const results = await Promise.allSettled([
      testYellowstone(testConfig.name, testConfig.request, testConfig.timeout),
      testLaserstream(testConfig.name, testConfig.request, testConfig.timeout)
    ]);
    
    const yellowstoneResult = results[0];
    const laserstreamResult = results[1];
    
    if (yellowstoneResult.status === 'fulfilled' && laserstreamResult.status === 'fulfilled') {
      console.log(`✅ ${testConfig.name} - Both succeeded, comparing structures...`);
      compareStructures(testConfig.name, yellowstoneResult.value, laserstreamResult.value);
    } else {
      console.log(`❌ ${testConfig.name} - One or both failed:`);
      if (yellowstoneResult.status === 'rejected') {
        console.log(`  - Yellowstone error: ${yellowstoneResult.reason}`);
      }
      if (laserstreamResult.status === 'rejected') {
        console.log(`  - Laserstream error: ${laserstreamResult.reason}`);
      }
    }
    
  } catch (error) {
    console.error(`❌ ${testConfig.name} comparison failed:`, error);
  }
  
  console.log('\n🏁 Test completed');
  process.exit(0);
}

async function testYellowstone(name: string, request: any, timeout: number): Promise<any> {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${name} Yellowstone timeout after ${timeout}ms`));
    }, timeout);
    
    try {
      const client = new createClient(config.yellowstone.endpoint, config.yellowstone.apiKey, {
        // Increase max message size to handle large block messages (1GB limit)
        'grpc.max_receive_message_length': 1024 * 1024 * 1024,
        'grpc.max_send_message_length': 1024 * 1024 * 1024
      });
      
      const stream = await client.subscribe();
      
      stream.on('data', (data: YellowstoneUpdate) => {
        clearTimeout(timer);
        stream.destroy();
        resolve(data);
      });
      
      stream.on('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      
      stream.write({
        ...request,
        accountsDataSlice: request.accountsDataSlice || [],
        commitment: request.commitment || 1
      } as SubscribeRequest);
      
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function testLaserstream(name: string, request: any, timeout: number): Promise<SubscribeUpdate> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${name} Laserstream timeout after ${timeout}ms`));
    }, timeout);
    
    try {
      const client = new LaserstreamClient(
        config.laserstreamProduction.endpoint,
        config.laserstreamProduction.apiKey
      );
      
      let received = false;
      
      client.subscribe(request, (error: Error | null, update: SubscribeUpdate) => {
        if (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
        
        if (!received) {
          received = true;
          clearTimeout(timer);
          resolve(update);
        }
      }).catch(reject);
      
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

function compareStructures(name: string, yellowstone: any, laserstream: SubscribeUpdate) {
  console.log(`\n📊 ${name} Structure Comparison:`);
  
  // Top-level fields comparison
  const yellowstoneKeys = Object.keys(yellowstone).sort();
  const laserstreamKeys = Object.keys(laserstream).sort();
  
  console.log(`\n🟡 Yellowstone top-level keys (${yellowstoneKeys.length}):`);
  console.log(yellowstoneKeys.join(', '));
  
  console.log(`\n🔵 Laserstream top-level keys (${laserstreamKeys.length}):`);
  console.log(laserstreamKeys.join(', '));
  
  // Find differences
  const missingInLaserstream = yellowstoneKeys.filter(key => !laserstreamKeys.includes(key));
  const extraInLaserstream = laserstreamKeys.filter(key => !yellowstoneKeys.includes(key));
  
  if (missingInLaserstream.length > 0) {
    console.log(`\n❌ Missing in Laserstream: ${missingInLaserstream.join(', ')}`);
  }
  
  if (extraInLaserstream.length > 0) {
    console.log(`\n➕ Extra in Laserstream: ${extraInLaserstream.join(', ')}`);
  }
  
  if (missingInLaserstream.length === 0 && extraInLaserstream.length === 0) {
    console.log(`\n✅ Perfect top-level key match!`);
  }
  
  // Compare the main data object
  const dataFieldMap: { [key: string]: string } = {
    'Account': 'account',
    'Slot': 'slot',
    'Transaction': 'transaction',
    'Transaction Status': 'transactionStatus',
    'Block': 'block',
    'Block Meta': 'blockMeta',
    'Entry': 'entry'
  };
  
  const dataField = dataFieldMap[name];
  if (dataField) {
    const yellowstoneData = (yellowstone as any)[dataField];
    const laserstreamData = (laserstream as any)[dataField];
    
    if (yellowstoneData && laserstreamData) {
      console.log(`\n🔍 ${name} Data Object Comparison:`);
      
      const yellowstoneDataKeys = Object.keys(yellowstoneData).sort();
      const laserstreamDataKeys = Object.keys(laserstreamData).sort();
      
      console.log(`  🟡 Yellowstone ${name.toLowerCase()} keys (${yellowstoneDataKeys.length}): ${yellowstoneDataKeys.join(', ')}`);
      console.log(`  🔵 Laserstream ${name.toLowerCase()} keys (${laserstreamDataKeys.length}): ${laserstreamDataKeys.join(', ')}`);
      
      const missingDataFields = yellowstoneDataKeys.filter(key => !laserstreamDataKeys.includes(key));
      const extraDataFields = laserstreamDataKeys.filter(key => !yellowstoneDataKeys.includes(key));
      
      if (missingDataFields.length > 0) {
        console.log(`  ❌ Missing ${name.toLowerCase()} fields: ${missingDataFields.join(', ')}`);
      }
      
      if (extraDataFields.length > 0) {
        console.log(`  ➕ Extra ${name.toLowerCase()} fields: ${extraDataFields.join(', ')}`);
      }
      
      if (missingDataFields.length === 0 && extraDataFields.length === 0) {
        console.log(`  ✅ Perfect ${name.toLowerCase()} data structure match!`);
      }
      
      // For transaction, also check the inner transaction object structure
      if (dataField === 'transaction' && yellowstoneData.transaction && laserstreamData.transaction) {
        console.log(`\n  🔍 Inner transaction object comparison:`);
        
        const yellowstoneInnerKeys = Object.keys(yellowstoneData.transaction).sort();
        const laserstreamInnerKeys = Object.keys(laserstreamData.transaction).sort();
        
        console.log(`    🟡 Yellowstone transaction.transaction keys (${yellowstoneInnerKeys.length}): ${yellowstoneInnerKeys.join(', ')}`);
        console.log(`    🔵 Laserstream transaction.transaction keys (${laserstreamInnerKeys.length}): ${laserstreamInnerKeys.join(', ')}`);
        
        const missingInnerFields = yellowstoneInnerKeys.filter(key => !laserstreamInnerKeys.includes(key));
        const extraInnerFields = laserstreamInnerKeys.filter(key => !yellowstoneInnerKeys.includes(key));
        
        if (missingInnerFields.length > 0) {
          console.log(`    ❌ Missing inner transaction fields: ${missingInnerFields.join(', ')}`);
        }
        
        if (extraInnerFields.length > 0) {
          console.log(`    ➕ Extra inner transaction fields: ${extraInnerFields.join(', ')}`);
        }
        
        if (missingInnerFields.length === 0 && extraInnerFields.length === 0) {
          console.log(`    ✅ Perfect inner transaction structure match!`);
        }
      }
    } else if (yellowstoneData && !laserstreamData) {
      console.log(`\n❌ ${name} data present in Yellowstone but missing in Laserstream`);
    } else if (!yellowstoneData && laserstreamData) {
      console.log(`\n❌ ${name} data missing in Yellowstone but present in Laserstream`);
    }
  }
  
  // Show sample values for debugging (truncated)
  console.log(`\n📄 Sample Values (first 300 chars):`);
  console.log(`  🟡 Yellowstone:`, JSON.stringify(yellowstone, null, 2).substring(0, 300) + '...');
  console.log(`  🔵 Laserstream:`, JSON.stringify(laserstream, null, 2).substring(0, 300) + '...');
}

testSingleSubscription().catch(console.error); 