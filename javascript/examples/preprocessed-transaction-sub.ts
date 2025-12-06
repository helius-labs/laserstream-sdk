import { subscribePreprocessed, SubscribePreprocessedUpdate } from '../client';
const config = require('../test-config.js');

const endpoint = config.laserstreamProduction.endpoint;
const apiKey = config.laserstreamProduction.apiKey;

async function main() {
  console.log('Subscribing to preprocessed transactions...');

  const subscriptionRequest = {
    transactions: {
      'preprocessed-filter': {
        vote: false,
      },
    },
  };

  try {
    const stream = await subscribePreprocessed(
      { endpoint, apiKey },
      subscriptionRequest,
      (update: SubscribePreprocessedUpdate) => {
        console.log(JSON.stringify(update, null, 2));
      },
      (error: Error) => {
        console.error('Stream error:', error);
        process.exit(1);
      }
    );

    console.log('Successfully subscribed. Listening for preprocessed transactions...');
    console.log('Press Ctrl+C to exit\n');

    process.on('SIGINT', () => {
      console.log('\nShutting down...');
      stream.cancel();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to subscribe:', error);
    process.exit(1);
  }
}

main();
