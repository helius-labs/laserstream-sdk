import { LaserstreamClient, CommitmentLevel, SubscribeUpdate } from '../index';
const config = require('../test-config');

async function main() {
  console.log('LaserStream Slot Subscription Example\n');
  
  const client = new LaserstreamClient(
    config.laserstreamProduction.endpoint,
    config.laserstreamProduction.apiKey
  );

  const subscribeRequest = {
    slots: { 
      "all-slots": {
        filterByCommitment: true
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
    
    console.log('✅ Slot subscription started! Press Ctrl+C to exit.');
  } catch (error) {
    console.error('Subscription failed:', error);
    process.exit(1);
  }
} 

main().catch(console.error); 