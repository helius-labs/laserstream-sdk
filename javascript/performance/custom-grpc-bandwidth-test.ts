import { CommitmentLevel } from '../index';
import Client from './grpc';

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
  
  // Get current slot and calculate replay slot (same as other tests: slot - 300)
  const slot = await getCurrentSlot(apiKey);
  const replaySlot = slot - 2999;
  
  console.log(`Current slot: ${slot}, Replay slot: ${replaySlot}`);
  console.log(`Endpoint: ${endpointUrl}`);
  
  // Create custom gRPC client
  const client = new Client(endpointUrl, apiKey);
  
  console.log("Connecting with custom lightweight gRPC client...");
  
  // Create subscribe request matching other tests exactly
  const subscribeRequest: any = {
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
  
  console.log("🚀 Starting custom gRPC client message consumption (no measurements)...");
  
  try {
    const stream = await client.subscribe();
    
    // Send subscription request
    stream.write(subscribeRequest);
    
    // Handle incoming messages
    stream.on('data', (update: any) => {
      // Just consume messages - no processing, no measurements
      // The custom client already attaches __payloadLength for potential throughput measurement
    });
    
    stream.on('error', (error: Error) => {
      console.error('Custom gRPC stream error:', error);
    });
    
    stream.on('end', () => {
      console.log('Custom gRPC stream ended');
    });
    
    console.log("✅ Custom gRPC subscription started - consuming messages continuously...");
    
    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\nStopping custom gRPC stream consumption');
      stream.end();
      client.close();
      process.exit(0);
    });
    
    // Keep the script alive indefinitely
    await new Promise(() => {});
    
  } catch (error) {
    console.error('Custom gRPC subscription failed:', error);
    process.exit(1);
  }
}

main().catch(console.error); 