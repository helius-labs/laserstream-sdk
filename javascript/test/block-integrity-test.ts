import { subscribe, CommitmentLevel, LaserstreamConfig, SubscribeRequest } from '../src';
import fetch from 'node-fetch';

async function main() {
  // Configuration for the Laserstream service
  const config: LaserstreamConfig = {
    apiKey: '', // Replace with your actual API key if needed
    endpoint: '' // Replace with the appropriate endpoint
  };

  // Subscription request for blocks
  // We will leave accounts, transactions etc. empty as we are only interested in blocks.
  const subscriptionRequest: SubscribeRequest = {
    accounts: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.CONFIRMED,
    slots: {
        slotSubscribe: {
            filterByCommitment: true,
            interslotUpdates: false
        }
    },
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {}
  };

  // Track last seen slot number to check ordering
  let lastSlotNumber: number | null = null;

  const rpcEndpoint = 'https://mainnet.helius-rpc.com';

  async function blockExists(slot: number): Promise<boolean> {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBlock',
      params: [
        slot,
        {
          encoding: 'json',
          transactionDetails: 'full',
          rewards: false,
          maxSupportedTransactionVersion: 0
        }
      ]
    };

    try {
      const resp = await fetch(`${rpcEndpoint}?api-key=${config.apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip'
        },
        body: JSON.stringify(body)
      });
      const json: any = await resp.json();
      if (json.error && json.error.code === -32007) {
        // Slot was skipped – no block expected
        return false;
      }
      return true;
    } catch (e) {
      console.error(`RPC check failed for slot ${slot}:`, e);
      return true; // assume exists to err on side of reporting
    }
  }

  console.log("Starting block integrity test. Subscribing to slots...");

  await subscribe(config, subscriptionRequest, async (data) => {
    if (data.slot) {
       const currentSlotInfo = data.slot;
       const currentSlotNumber = Number(currentSlotInfo.slot);

       if (!isNaN(currentSlotNumber)) {
         if (lastSlotNumber !== null && currentSlotNumber !== lastSlotNumber + 1) {
           // Iterate through each gap slot and verify if a block exists
           for (let missing = lastSlotNumber + 1; missing < currentSlotNumber; missing++) {
             const exists = await blockExists(missing);
             if (exists) {
               console.error(`ERROR: Missed slot ${missing} – block exists but was not received.`);
             } else {
               process.stdout.write(`Skipped slot ${missing} (no block produced)\n`);
             }
           }
         }

         process.stdout.write(`Received slot: ${currentSlotNumber}\n`);
         lastSlotNumber = currentSlotNumber;
       } else {
         console.warn("Received slot update, but slot number is undefined.", currentSlotInfo);
       }
    } else {
      // Handle other update types (ping, pong, etc.) if needed.
      // For now, we ignore them.
    }
  }, async (error) => {
    console.error("Subscription error:", error);
    // Potentially attempt to reconnect or handle the error appropriately.
  });

  console.log("Subscription started. Waiting for slots...");
  // Keep the script running to receive slots.
  // In a real test, you might have a timeout or a certain number of slots to receive.
  // For this simple script, it will run indefinitely until manually stopped.
  await new Promise(() => {}); // Keep alive
}

main().catch(error => {
  console.error("Unhandled error in main:", error);
  process.exit(1); // Exit with an error code
}); 