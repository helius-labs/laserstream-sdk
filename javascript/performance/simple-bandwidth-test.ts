import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';

const config = require('../test-config');

async function getCurrentSlot(apiKey: string): Promise<number> {
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getSlot'
    })
  });
  const data = await response.json();
  return data.result;
}

async function main() {
  // Copy main.rs approach exactly
  const apiKey = config.laserstreamProduction.apiKey;
  const endpointUrl = config.laserstreamProduction.endpoint;
  
  // Get current slot and calculate replay slot (same as main.rs: slot - 300)
  const slot = await getCurrentSlot(apiKey);
  const replaySlot = slot - 2950;
  
  console.log(`Current slot: ${slot}, Replay slot: ${replaySlot}`);
  
  // Create comprehensive subscribe request (copying main.rs filters exactly)
  const subscribeRequest = {
    accounts: {
      "": {
        account: [],
        owner: [],
        filters: []
      }
    },
    slots: {
      "": {
        filterByCommitment: false,
        interslotUpdates: true
      }
    },
    transactions: {
      "": {
        accountInclude: [],
        accountExclude: [],
        accountRequired: [],
        vote: false,
        failed: false
      }
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {
      "": {}
    },
    entry: {
      "": {}
    },
    commitment: CommitmentLevel.Processed,
    accountsDataSlice: [],
    ping: undefined,
    fromSlot: replaySlot
  };
  
  const clientConfig: LaserstreamConfig = {
    apiKey: config.laserstreamProduction.apiKey,
    endpoint: config.laserstreamProduction.endpoint
  };

  try {
    await subscribe(clientConfig, subscribeRequest, (_update: SubscribeUpdate) => {
      // Consume messages but do not process
    });
    
    console.log("✅ Subscription started - consuming messages continuously...");
    
    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\nStopping stream consumption');
      process.exit(0);
    });
    
  } catch (error) {
    console.error('Subscription failed:', error);
    process.exit(1);
  }
}

main().catch(console.error); 