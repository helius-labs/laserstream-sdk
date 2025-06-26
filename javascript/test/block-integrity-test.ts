import { LaserstreamClient, CommitmentLevel } from '../index';
import fetch from 'node-fetch';

// Load test configuration
const testConfig = require('../test-config.js');

interface LaserstreamConfig {
  apiKey: string;
  endpoint: string;
  maxReconnectAttempts?: number;
}

async function main() {
  // Configuration for the Laserstream service
  const config: LaserstreamConfig = {
    apiKey: testConfig.laserstream.apiKey,
    endpoint: testConfig.laserstream.endpoint
  };

  const subscriptionRequest: any = {
    accounts: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.Processed, 
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

  // Track reconnection behavior
  let lastSlotNumber: number | null = null;
  let highestSlotSeen: number | null = null;  // Track the highest slot we've seen
  let reconnectionCount = 0;
  let lastConnectionTime = Date.now();
  let totalMessages = 0;
  let errCount = 0;

  const rpcEndpoint = testConfig.blockRpc.endpoint;

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
      const resp = await fetch(`${rpcEndpoint}?api-key=${testConfig.blockRpc.apiKey}`, {
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

  // Global variables to keep streams alive
  let laserstreamClient: any = null;
  let laserstreamStream: any = null;

  // Create client with endpoint and token
  const client = new LaserstreamClient(config.endpoint, config.apiKey);

  // Subscribe with request and callback for raw protobuf buffer
  const streamHandle = await client.subscribe(subscriptionRequest, async (error: Error | null, update: any) => {
    if (error) {
      console.error('🚨 LASERSTREAM ERROR:', error.message);
      errCount += 1;
      reconnectionCount += 1;
      lastConnectionTime = Date.now();
      return;
    }
    
    try {
      totalMessages++;
      const currentTime = Date.now();
      
      // Detect potential reconnection (gap in messages > 10 seconds)
      if (currentTime - lastConnectionTime > 10000) {
        reconnectionCount++;
      }
      lastConnectionTime = currentTime;

      const u = update;

      if (u.slot) {
         const currentSlotInfo = u.slot;
         const currentSlotNumber = Number(currentSlotInfo.slot);

         if (!isNaN(currentSlotNumber)) {
           // Check if this is a new highest slot (only check gaps for new highs)
           if (highestSlotSeen === null || currentSlotNumber > highestSlotSeen) {
             // We have a new highest slot - check for gaps from previous highest
             if (highestSlotSeen !== null && currentSlotNumber > highestSlotSeen + 1) {
               const gapSize = currentSlotNumber - highestSlotSeen - 1;
               
               // Large gap might indicate reconnection
               if (gapSize > 20) {
                 console.log(`🚨 LARGE SLOT GAP: ${gapSize} slots (${highestSlotSeen} → ${currentSlotNumber})`);
               }
               
               // Iterate through each gap slot and verify if a block exists
               for (let missing = highestSlotSeen + 1; missing < currentSlotNumber; missing++) {
                 const exists = await blockExists(missing);
                 if (exists) {
                   console.error(`❌ ERROR: Missed slot ${missing} – block exists but was not received.`);
                 } else {
                   // Only log every 10th skipped slot to reduce noise
                   if (missing % 10 === 0) {
                     process.stdout.write(`⏭️  Skipped slot ${missing} (no block produced)\n`);
                   }
                 }
               }
             }
             
             // Update highest slot seen
             highestSlotSeen = currentSlotNumber;
           } else if (currentSlotNumber < (highestSlotSeen || 0)) {
             // This is an out-of-order slot (older than highest seen)
           }
           
           lastSlotNumber = currentSlotNumber;
         } else {
           console.warn("⚠️  Received slot update, but slot number is undefined.", currentSlotInfo);
         }
      } else {
        // Handle other update types (ping, pong, etc.) if needed.
        // For now, we ignore them but count the messages
      }
    } catch (err) {
      console.error('Laserstream callback error:', err);
      errCount += 1;
      reconnectionCount += 1;
      lastConnectionTime = Date.now();
    }
  });

  // Store references globally to prevent garbage collection
  laserstreamClient = client;
  laserstreamStream = streamHandle;

  // Cleanup on exit
  process.on('SIGINT', () => {
    if (laserstreamStream && typeof laserstreamStream.cancel === 'function') {
      laserstreamStream.cancel();
    }
    process.exit(0);
  });

  // Block integrity test started
  
  // Print periodic status
  setInterval(() => {
    const now = new Date().toISOString();
    console.log(`[${now}] 📊 Status: Last slot: ${lastSlotNumber} | Highest slot: ${highestSlotSeen} | Reconnections: ${reconnectionCount} | Total messages: ${totalMessages}`);
  }, 30000); // Every 30 seconds

  // Keep alive
  await new Promise(() => {}); 
}

main().catch(error => {
  console.error("💥 Unhandled error in main:", error);
  process.exit(1); 
}); 