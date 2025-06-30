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
  // Get current slot and calculate replay slot (2000 slots back for more data)
  const currentSlot = await getCurrentSlot(config.laserstreamProduction.apiKey);
  const replaySlot = currentSlot - 2950;
  
  console.log(`Starting RUST-BASED bandwidth test from slot ${replaySlot} (current: ${currentSlot})`);
  console.log('🚀 Measuring Rust-decoded objects (protobuf decoding in NAPI/Rust)');
  
  // Create Laserstream client (Rust-based decoding)
  const client = new LaserstreamClient(
    config.laserstreamProduction.endpoint, 
    config.laserstreamProduction.apiKey
  );
  
  // Create comprehensive subscription request (same as before for fair comparison)
  const subscribeRequest = {
    accounts: {
      "all-accounts": {
        account: [],
        owner: [],
        filters: []
      }
    },
    slots: {
      "all-slots": {
        filterByCommitment: false
      }
    },
    transactions: {
      "all-transactions": {
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
      "all-block-meta": {}
    },
    entry: {
      "all-entries": {}
    },
    commitment: CommitmentLevel.Processed,
    accountsDataSlice: [],
    fromSlot: replaySlot
  };
  
  // Bandwidth tracking
  let totalBytes = 0;
  let messageCount = 0;
  let lastCheckpoint = Date.now();
  const testDuration = 10; // seconds
  const checkpointInterval = 2; // seconds
  const numCheckpoints = testDuration / checkpointInterval;
  let checkpointNum = 1;
  
  console.log(`Testing for ${testDuration}s with checkpoints every ${checkpointInterval}s`);
  console.log('Target: 1 GB/s (1,073,741,824 bytes/sec)');
  
  try {
    await client.subscribe(subscribeRequest, (error: Error | null, update: SubscribeUpdate) => {
      if (error) {
        console.error('Stream error:', error);
        return;
      }
      
      // Count Rust-decoded object size (real throughput with Rust decoding)
      const updateString = JSON.stringify(update);
      totalBytes += Buffer.byteLength(updateString, 'utf8');
      messageCount++;
      
      // Checkpoint reporting
      const now = Date.now();
      if (now - lastCheckpoint > checkpointInterval * 1000) {
        const elapsed = (now - lastCheckpoint) / 1000;
        const bytesPerSec = totalBytes / elapsed;
        const messagesPerSec = messageCount / elapsed;
        const mbPerSec = bytesPerSec / (1024 * 1024);
        const gbPerSec = bytesPerSec / (1024 * 1024 * 1024);
        
        console.log(`🚀 RUST Checkpoint ${checkpointNum}/${numCheckpoints}: ${messagesPerSec.toFixed(0)} msgs/s, ${mbPerSec.toFixed(2)} MB/s (${gbPerSec.toFixed(3)} GB/s)`);
        
        // Reset counters
        totalBytes = 0;
        messageCount = 0;
        lastCheckpoint = now;
        checkpointNum++;
        
        if (checkpointNum > numCheckpoints) {
          console.log('✅ Rust-based bandwidth test completed');
          process.exit(0);
        }
      }
    });
    
    console.log('✅ Rust-based subscription started');
    
    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\nShutting down...');
      process.exit(0);
    });
    
  } catch (error) {
    console.error('Subscription failed:', error);
    process.exit(1);
  }
}

main().catch(console.error); 