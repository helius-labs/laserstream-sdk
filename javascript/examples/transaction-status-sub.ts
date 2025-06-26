import { LaserstreamClient, CommitmentLevel, SubscribeUpdate } from '../index';
const config = require('../test-config');

async function main() {
  console.log('LaserStream Transaction Status Subscription Example\n');
  
  const client = new LaserstreamClient(
    config.laserstreamProduction.endpoint,
    config.laserstreamProduction.apiKey
  );

  const subscribeRequest = {
    transactionsStatus: { 
      "pump-transaction-status": {
        accountInclude: ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"],
        accountExclude: [],
        accountRequired: [],
        vote: false,
        failed: false
      }
    },
    commitment: CommitmentLevel.Processed
  };

  console.log('Starting subscription...');
  
  try {
    // Just subscribe - lifecycle management is handled automatically!
    const stream = await client.subscribe(subscribeRequest, (error: Error | null, update: SubscribeUpdate) => {
      if (error) {
        console.error('Stream error:', error);
        return;
      }

      console.log(update);
    });
    
    console.log(`✅ Transaction Status subscription started (${stream.id})! Press Ctrl+C to exit.`);
  } catch (error) {
    console.error('Subscription failed:', error);
    process.exit(1);
  }
} 

main().catch(console.error); 