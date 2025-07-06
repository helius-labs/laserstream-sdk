import Client from '@triton-one/yellowstone-grpc';
import { CommitmentLevel } from '../index';

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
  const apiKey = config.laserstreamProduction.apiKey;
  const endpointUrl = config.laserstreamProduction.endpoint;
  
  // Get current slot and calculate replay slot (same as simple-bandwidth-test.ts: slot - 300)
  const slot = await getCurrentSlot(apiKey);
  const replaySlot = slot - 2950;
  
  console.log(`Current slot: ${slot}, Replay slot: ${replaySlot}`);
  console.log(`Endpoint: ${endpointUrl}`);
  
  // Create direct Yellowstone gRPC client
  const client = new Client(endpointUrl, apiKey, {
    "grpc.max_receive_message_length": 1024 * 1024 * 1024, // 1GB
    "grpc.max_send_message_length": 1024 * 1024 * 1024,    // 1GB
    "grpc.max_message_size": 1024 * 1024 * 1024,           // 1GB
    "grpc.max_receive_message_size": 1024 * 1024 * 1024,   // 1GB (keep original too)
    "grpc.max_send_message_size": 1024 * 1024 * 1024,      // 1GB (keep original too)
  });
  
  console.log("Connecting with direct Yellowstone gRPC client...");
  
  // Create subscribe request matching simple-bandwidth-test.ts exactly
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
        vote: true,
        failed: true
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
    commitment: CommitmentLevel.PROCESSED,
    accountsDataSlice: [],
    ping: undefined,
    fromSlot: replaySlot
  };
  
  console.log("🚀 Starting direct Yellowstone gRPC message consumption (no measurements)...");
  
  try {
    const stream = await client.subscribe();
    
    // Send subscription request
    await new Promise<void>((resolve, reject) => {
      stream.write(subscribeRequest, (err: Error | null | undefined) => {
        if (err == null) resolve();
        else reject(err);
      });
    });
    
    // Handle incoming messages
    stream.on('data', (update: any) => {
      // Just consume messages - no processing, no measurements
    });
    
    stream.on('error', (error: Error) => {
      console.error('Direct Yellowstone stream error:', error);
    });
    
    stream.on('end', () => {
      console.log('Direct Yellowstone stream ended');
    });
    
    console.log("✅ Direct Yellowstone subscription started - consuming messages continuously...");
    
    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\nStopping direct Yellowstone stream consumption');
      stream.end();
      process.exit(0);
    });
    
    // Keep the script alive indefinitely
    await new Promise(() => {});
    
  } catch (error) {
    console.error('Direct Yellowstone subscription failed:', error);
    process.exit(1);
  }
}

main().catch(console.error); 