import { LaserstreamClient } from '../index';
import Client from '@triton-one/yellowstone-grpc';
import { performance } from 'perf_hooks';

const testConfig = require('../test-config.js');

// Function to get current slot number
async function getCurrentSlot(): Promise<number> {
  try {
    // Check if fetch is available (Node.js 18+ or with polyfill)
    if (typeof fetch === 'undefined') {
      console.warn('⚠️  Fetch not available, using fallback slot');
      return 280000000; // Use a reasonable recent slot as fallback
    }

    const response = await fetch(testConfig.blockRpc.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testConfig.blockRpc.apiKey}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSlot',
        params: [{ commitment: 'processed' }]
      })
    });
    
    const data = await response.json();
    return data.result || 280000000; // Fallback to reasonable slot if no result
  } catch (error) {
    console.warn('⚠️  Could not fetch current slot, using fallback');
    return 280000000; // Fallback to reasonable recent slot
  }
}

interface ClientMetrics {
  messageCount: number;
  totalBytes: number;
  errorCount: number;
  startTime: number;
  endTime?: number;
}

interface ComparisonResult {
  napi: ClientMetrics;
  yellowstone: ClientMetrics;
  duration: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function calculateThroughput(bytes: number, durationSeconds: number): number {
  return bytes / (1024 * 1024 * durationSeconds); // MB/s
}

async function runComparativeGrpcTest(testDurationSeconds: number = 30) {
  console.log('🚀 NAPI vs YELLOWSTONE GRPC PERFORMANCE COMPARISON');
  console.log('═'.repeat(60));
  console.log(`🔧 Test Duration: ${testDurationSeconds}s`);
  console.log(`🔧 Endpoint: ${testConfig.laserstreamProduction.endpoint}`);
  console.log(`🔧 Token: ${testConfig.laserstreamProduction.apiKey ? 'Present' : 'Missing'}`);
  console.log('🔧 Measurement: MB/s (following gRPC best practices)');
  console.log();

  if (!testConfig.laserstreamProduction.apiKey) {
    console.error('❌ ERROR: Missing API token. Set HELIUS_API_KEY or TOKEN environment variable.');
    process.exit(1);
  }

  // Get current slot for replay
  console.log('🔄 Getting current slot for replay...');
  const currentSlot = await getCurrentSlot();
  const replaySlot = Math.max(0, currentSlot - 1000);
  
  console.log(`📊 Current Slot: ${currentSlot.toLocaleString()}`);
  console.log(`📊 Replay From Slot: ${replaySlot.toLocaleString()}`);
  console.log(`🔥 Replaying ${currentSlot - replaySlot} slots for maximum bandwidth pressure!`);
  console.log();

  const metrics: ComparisonResult = {
    napi: {
      messageCount: 0,
      totalBytes: 0,
      errorCount: 0,
      startTime: 0,
    },
    yellowstone: {
      messageCount: 0,
      totalBytes: 0,
      errorCount: 0,
      startTime: 0,
    },
    duration: 0,
  };

  // Shared subscription request for fair comparison with replay
  const subscriptionRequest = {
    accounts: {
      'bandwidth-test': {
        account: [],
        owner: [],
        filters: []
      }
    },
    transactions: {
      'bandwidth-test': {
        vote: false,
        failed: false,
        accountInclude: [],
        accountExclude: [],
        accountRequired: []
      }
    },
    slots: {
      'bandwidth-test': {
        filterByCommitment: false,
        interslotUpdates: true
      }
    },
    commitment: 0, // Processed for maximum throughput
    blocks: {},
    blocksMeta: {},
    entry: {},
    transactionsStatus: {},
    accountsDataSlice: [],
    fromSlot: replaySlot, // Replay from 1000 slots back for maximum bandwidth
  };

  let napiClient: LaserstreamClient;
  let yellowstoneClient: Client;
  let napiStream: any;
  let yellowstoneStream: any;

  try {
    console.log('🟦 Starting NAPI Client...');
    
    // Initialize NAPI client
    napiClient = new LaserstreamClient(testConfig.laserstreamProduction.endpoint, testConfig.laserstreamProduction.apiKey);
    metrics.napi.startTime = performance.now();
    
    napiStream = await napiClient.subscribe(subscriptionRequest, (error: Error | null, update: any) => {
      if (error) {
        console.error(`❌ NAPI error: ${error.message}`);
        metrics.napi.errorCount++;
        return;
      }

      if (update) {
        const messageSize = JSON.stringify(update).length;
        metrics.napi.messageCount++;
        metrics.napi.totalBytes += messageSize;
      }
    });
    
    console.log('✅ NAPI client connected');

    console.log('🟨 Starting Yellowstone Client...');
    
    // Initialize Yellowstone client
    yellowstoneClient = new Client(testConfig.laserstreamProduction.endpoint, testConfig.laserstreamProduction.apiKey, {
      "grpc.max_receive_message_length": 64 * 1024 * 1024,
    });
    
    metrics.yellowstone.startTime = performance.now();
    yellowstoneStream = await yellowstoneClient.subscribe();
    
    await new Promise<void>((resolve, reject) => {
      yellowstoneStream.write(subscriptionRequest, (err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });

    yellowstoneStream.on('data', (update: any) => {
      if (update) {
        const messageSize = JSON.stringify(update).length;
        metrics.yellowstone.messageCount++;
        metrics.yellowstone.totalBytes += messageSize;
      }
    });

    yellowstoneStream.on('error', (error: Error) => {
      console.error(`❌ Yellowstone error: ${error.message}`);
      metrics.yellowstone.errorCount++;
    });

    console.log('✅ Yellowstone client connected');
    console.log();
    console.log('📡 Both clients running, collecting data...');
    console.log('🎯 Measuring raw bandwidth capabilities with historical replay');
    console.log(`🔥 Replaying from slot ${replaySlot.toLocaleString()} for maximum bandwidth pressure`);
    console.log();

    // Progress reporting
    const progressInterval = setInterval(() => {
      const napiElapsed = (performance.now() - metrics.napi.startTime) / 1000;
      const yellowstoneElapsed = (performance.now() - metrics.yellowstone.startTime) / 1000;
      
      const napiThroughput = napiElapsed > 0 ? calculateThroughput(metrics.napi.totalBytes, napiElapsed) : 0;
      const yellowstoneThroughput = yellowstoneElapsed > 0 ? calculateThroughput(metrics.yellowstone.totalBytes, yellowstoneElapsed) : 0;
      
      const napiMps = napiElapsed > 0 ? metrics.napi.messageCount / napiElapsed : 0;
      const yellowstoneMps = yellowstoneElapsed > 0 ? metrics.yellowstone.messageCount / yellowstoneElapsed : 0;

              console.log(`🟦 NAPI: ${metrics.napi.messageCount.toLocaleString()} msgs | ${formatBytes(metrics.napi.totalBytes)} | ${napiThroughput.toFixed(1)} MB/s | ${napiMps.toFixed(0)} msg/s`);
        console.log(`🟨 Yellowstone: ${metrics.yellowstone.messageCount.toLocaleString()} msgs | ${formatBytes(metrics.yellowstone.totalBytes)} | ${yellowstoneThroughput.toFixed(1)} MB/s | ${yellowstoneMps.toFixed(0)} msg/s`);
      
      if (napiThroughput > 0 && yellowstoneThroughput > 0) {
        const ratio = napiThroughput / yellowstoneThroughput;
        if (ratio > 1.1) {
          console.log(`🏆 NAPI leading by ${((ratio - 1) * 100).toFixed(1)}%`);
        } else if (ratio < 0.9) {
          console.log(`🏆 Yellowstone leading by ${((1/ratio - 1) * 100).toFixed(1)}%`);
        } else {
          console.log(`🤝 Neck and neck (${Math.abs((ratio - 1) * 100).toFixed(1)}% difference)`);
        }
      }
      console.log();
    }, 5000);

    // Stop test after duration
    setTimeout(() => {
      clearInterval(progressInterval);
      generateComparisonReport();
    }, testDurationSeconds * 1000);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down gracefully...');
      clearInterval(progressInterval);
      generateComparisonReport();
    });

    function generateComparisonReport() {
      const endTime = performance.now();
      
      metrics.napi.endTime = endTime;
      metrics.yellowstone.endTime = endTime;
      
      const napiDuration = (metrics.napi.endTime - metrics.napi.startTime) / 1000;
      const yellowstoneDuration = (metrics.yellowstone.endTime - metrics.yellowstone.startTime) / 1000;
      
      const napiThroughput = calculateThroughput(metrics.napi.totalBytes, napiDuration);
      const yellowstoneThroughput = calculateThroughput(metrics.yellowstone.totalBytes, yellowstoneDuration);
      
      const napiMps = metrics.napi.messageCount / napiDuration;
      const yellowstoneMps = metrics.yellowstone.messageCount / yellowstoneDuration;

      console.log('\n\n🏁 BANDWIDTH COMPARISON REPORT');
      console.log('═'.repeat(60));
      
                    console.log('⚙️  TEST CONFIGURATION:');
       console.log(`🔧 Test Duration: ${Math.max(napiDuration, yellowstoneDuration).toFixed(2)}s`);
       console.log(`🔧 Endpoint: ${testConfig.laserstreamProduction.endpoint}`);
       console.log(`🔧 Commitment: 0 (Processed - Maximum Throughput)`);
       console.log(`🔧 Subscription: High-throughput (accounts + transactions + slots)`);
       console.log(`🔧 Replay Mode: FROM SLOT ${replaySlot.toLocaleString()} (${currentSlot - replaySlot} slots replayed)`);
       console.log();

             // Side-by-side metrics
       console.log('📊 BANDWIDTH METRICS COMPARISON:');
       console.log(''.padEnd(40) + '🟦 NAPI'.padEnd(25) + '🟨 Yellowstone');
       console.log('─'.repeat(85));
       console.log(`Messages:`.padEnd(40) + `${metrics.napi.messageCount.toLocaleString()}`.padEnd(25) + `${metrics.yellowstone.messageCount.toLocaleString()}`);
       console.log(`Data Transferred:`.padEnd(40) + `${formatBytes(metrics.napi.totalBytes)}`.padEnd(25) + `${formatBytes(metrics.yellowstone.totalBytes)}`);
       console.log(`Test Duration:`.padEnd(40) + `${napiDuration.toFixed(2)}s`.padEnd(25) + `${yellowstoneDuration.toFixed(2)}s`);
       console.log(`Messages/Second:`.padEnd(40) + `${napiMps.toFixed(1)}`.padEnd(25) + `${yellowstoneMps.toFixed(1)}`);
       console.log(`Data Rate:`.padEnd(40) + `${formatBytes(metrics.napi.totalBytes/napiDuration)}/s`.padEnd(25) + `${formatBytes(metrics.yellowstone.totalBytes/yellowstoneDuration)}/s`);
       console.log(`Bandwidth:`.padEnd(40) + `${napiThroughput.toFixed(2)} Mbps (${(napiThroughput/1000).toFixed(3)} Gbps)`.padEnd(25) + `${yellowstoneThroughput.toFixed(2)} Mbps (${(yellowstoneThroughput/1000).toFixed(3)} Gbps)`);
       console.log(`Errors:`.padEnd(40) + `${metrics.napi.errorCount}`.padEnd(25) + `${metrics.yellowstone.errorCount}`);
       console.log();

      // Performance Analysis
      console.log('🏆 PERFORMANCE ANALYSIS:');
      
      const bandwidthRatio = napiThroughput / Math.max(yellowstoneThroughput, 0.001); // Avoid division by zero
      const messageRatio = napiMps / Math.max(yellowstoneMps, 0.001);
      
      if (bandwidthRatio > 1.1) {
        console.log(`🥇 NAPI WINS! ${((bandwidthRatio - 1) * 100).toFixed(1)}% faster bandwidth`);
        console.log(`📊 NAPI: ${napiThroughput.toFixed(2)} Mbps vs Yellowstone: ${yellowstoneThroughput.toFixed(2)} Mbps`);
      } else if (bandwidthRatio < 0.9) {
        console.log(`🥇 YELLOWSTONE WINS! ${((1/bandwidthRatio - 1) * 100).toFixed(1)}% faster bandwidth`);
        console.log(`📊 Yellowstone: ${yellowstoneThroughput.toFixed(2)} Mbps vs NAPI: ${napiThroughput.toFixed(2)} Mbps`);
      } else {
        console.log(`🤝 TIE! Both clients perform similarly (${Math.abs((bandwidthRatio - 1) * 100).toFixed(1)}% difference)`);
      }
      
      if (messageRatio > 1.1) {
        console.log(`📨 Message throughput: NAPI ${((messageRatio - 1) * 100).toFixed(1)}% higher`);
      } else if (messageRatio < 0.9) {
        console.log(`📨 Message throughput: Yellowstone ${((1/messageRatio - 1) * 100).toFixed(1)}% higher`);
      }
      
      // Average message sizes
      const napiAvgSize = metrics.napi.messageCount > 0 ? metrics.napi.totalBytes / metrics.napi.messageCount : 0;
      const yellowstoneAvgSize = metrics.yellowstone.messageCount > 0 ? metrics.yellowstone.totalBytes / metrics.yellowstone.messageCount : 0;
      
      console.log(`📏 Average message size: NAPI ${formatBytes(napiAvgSize)}, Yellowstone ${formatBytes(yellowstoneAvgSize)}`);
      console.log();

      // Error Analysis
      if (metrics.napi.errorCount > 0 || metrics.yellowstone.errorCount > 0) {
        console.log('⚠️  ERROR ANALYSIS:');
        if (metrics.napi.errorCount > 0) {
          console.log(`🟦 NAPI errors: ${metrics.napi.errorCount} (${(metrics.napi.errorCount / (metrics.napi.messageCount + metrics.napi.errorCount) * 100).toFixed(2)}%)`);
        }
        if (metrics.yellowstone.errorCount > 0) {
          console.log(`🟨 Yellowstone errors: ${metrics.yellowstone.errorCount} (${(metrics.yellowstone.errorCount / (metrics.yellowstone.messageCount + metrics.yellowstone.errorCount) * 100).toFixed(2)}%)`);
        }
        console.log();
      }

      // Recommendations
      console.log('💡 RECOMMENDATIONS:');
      if (bandwidthRatio > 1.2) {
        console.log('✅ NAPI shows significant performance advantage - recommended for production');
      } else if (bandwidthRatio < 0.8) {
        console.log('✅ Yellowstone shows significant performance advantage - consider using Yellowstone');
      } else {
        console.log('🤝 Both clients perform similarly - choose based on other factors (ease of use, features, etc.)');
      }
      
      if (Math.max(metrics.napi.errorCount, metrics.yellowstone.errorCount) > 0) {
        console.log('⚠️  High error rates detected - investigate connection stability');
      }

      // Cleanup
      if (napiStream && typeof napiStream.cancel === 'function') {
        napiStream.cancel();
      }
      if (yellowstoneStream && typeof yellowstoneStream.end === 'function') {
        yellowstoneStream.end();
      }
      
      process.exit(0);
    }

    // Keep running
    await new Promise(() => {});

  } catch (error) {
    console.error('❌ Comparison test failed:', error);
    process.exit(1);
  }
}

// Parse command line arguments
const testDuration = process.argv[2] ? parseInt(process.argv[2]) : 30;

if (isNaN(testDuration) || testDuration < 10) {
  console.error('❌ Invalid test duration. Use: ts-node napi-vs-yellowstone-bandwidth.ts <seconds>');
  console.error('   Minimum duration: 10 seconds');
  process.exit(1);
}

console.log('🎯 Starting NAPI vs Yellowstone Bandwidth Comparison...');
console.log(`⏱️  Test Duration: ${testDuration} seconds`);
console.log('🔧 Press Ctrl+C to stop early\n');

runComparativeGrpcTest(testDuration).catch((error) => {
  console.error('💥 gRPC comparison test failed:', error);
  process.exit(1);
}); 