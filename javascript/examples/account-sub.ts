// import { SubscribeUpdate } from '@triton-one/yellowstone-grpc';
import { LaserstreamClient, CommitmentLevel } from '../index';
import type { SubscribeUpdate } from '../index';
const config = require('../test-config');

async function main() {
  console.log('LaserStream Account Subscription Example\n');
  
  const client = new LaserstreamClient(
    config.laserstreamProduction.endpoint,
    config.laserstreamProduction.apiKey
  );

  const subscribeRequest = {
    accounts: { 
      "pump": {
        account: ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"],
        owner: [],
        filters: []
      }
    },
    commitment: CommitmentLevel.Processed
  };

  console.log('Starting subscription...');
  
  try {
    // Just subscribe - lifecycle management is handled automatically!
    await client.subscribe(subscribeRequest, (error: Error | null, update: SubscribeUpdate) => {
      if (error) {
        console.error('Stream error:', error);
        return;
      }
      console.log(update);
    });
    
    console.log('✅ Account subscription started! Press Ctrl+C to exit.');
  } catch (error) {
    console.error('Subscription failed:', error);
    process.exit(1);
  }
} 

main().catch(console.error);