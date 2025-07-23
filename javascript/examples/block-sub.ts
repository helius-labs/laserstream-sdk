import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig, CompressionAlgorithms } from '../client';
const credentials = require('../test-config');

async function runBlockSubscription() {
  console.log('🧱 Laserstream Block Subscription Example');

  const config: LaserstreamConfig = {
    apiKey: credentials.laserstreamProduction.apiKey,
    endpoint: credentials.laserstreamProduction.endpoint,
    channelOptions: {
      'grpc.default_compression_algorithm': CompressionAlgorithms.zstd,
    },
  };

  // Subscribe to block updates
  const request = {
    blocks: {
      "all-blocks": {
        accountInclude: [],
        includeTransactions: true,
        includeAccounts: true,
        includeEntries: true
      }
    },
    commitment: CommitmentLevel.PROCESSED,
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  // Bandwidth measurement variables
  let totalBytes = 0;
  let messageCount = 0;
  const startTime = Date.now();
  let lastReportTime = startTime;
  const reportIntervalMs = 5000; // Report every 5 seconds

  // Helper to calculate message size
  function calculateMessageSize(obj: any): number {
    // Estimate size by stringifying the object
    return JSON.stringify(obj).length;
  }

  const stream = await subscribe(
    config,
    request,
    async (update: SubscribeUpdate) => {
      console.log('🧱 Block Update:', update);
      
      // Measure the message size
      const messageSize = calculateMessageSize(update);
      totalBytes += messageSize;
      messageCount++;
      
      // Report bandwidth every 5 seconds
      const now = Date.now();
      if (now - lastReportTime >= reportIntervalMs) {
        const elapsedSeconds = (now - startTime) / 1000;
        const mbReceived = totalBytes / (1024 * 1024);
        const mbPerSecond = mbReceived / elapsedSeconds;
        
        console.log(`\n📊 Bandwidth Report (with zstd compression):`);
        console.log(`   Total data received: ${mbReceived.toFixed(2)} MB`);
        console.log(`   Messages received: ${messageCount}`);
        console.log(`   Average message size: ${(totalBytes / messageCount / 1024).toFixed(2)} KB`);
        console.log(`   Bandwidth: ${mbPerSecond.toFixed(2)} MB/s`);
        console.log(`   Time elapsed: ${elapsedSeconds.toFixed(1)}s\n`);
        
        lastReportTime = now;
      }
    },
    async (error: Error) => {
      console.error('❌ Stream error:', error);
    }
  );

  console.log(`✅ Block subscription started with ID: ${stream.id}`);
  console.log(`📊 Measuring bandwidth with zstd compression enabled...`);

  // Cleanup on exit
  process.on('SIGINT', () => {
    // Final report
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    const mbReceived = totalBytes / (1024 * 1024);
    const mbPerSecond = mbReceived / elapsedSeconds;
    
    console.log(`\n📊 Final Bandwidth Report (with zstd compression):`);
    console.log(`   Total data received: ${mbReceived.toFixed(2)} MB`);
    console.log(`   Messages received: ${messageCount}`);
    console.log(`   Average message size: ${(totalBytes / messageCount / 1024).toFixed(2)} KB`);
    console.log(`   Average bandwidth: ${mbPerSecond.toFixed(2)} MB/s`);
    console.log(`   Total time: ${elapsedSeconds.toFixed(1)}s`);
    
    console.log('\n🛑 Cancelling stream...');
    stream.cancel();
    process.exit(0);
  });
}

runBlockSubscription().catch(console.error); 