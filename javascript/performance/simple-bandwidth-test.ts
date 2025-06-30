import { LaserstreamClient, CommitmentLevel } from '../index';
import type { SubscribeUpdate } from '../index';

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
  const replaySlot = slot - 2999;
  
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
        vote: undefined,
        failed: undefined
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
  
  const client = new LaserstreamClient(endpointUrl, apiKey);
  
  console.log("Connecting and subscribing...");
  console.log("🚀 Starting pure message consumption (no measurements)...");
  
  try {
    await client.subscribe(subscribeRequest, (error: Error | null, update: SubscribeUpdate) => {
      if (error) {
        console.error('Stream error:', error);
        return;
      }
      
      // Just consume messages - no processing, no measurements
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