import { LaserstreamClient } from '../index';
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

// Performance metrics interface
interface BandwidthMetrics {
  duration: number;
  messageCount: number;
  totalBytes: number;
  messagesPerSecond: number;
  bytesPerSecond: number;
  megabitsPerSecond: number;
  averageMessageSize: number;
  peakThroughput: number;
  errors: number;
}

interface WindowedMetrics {
  timestamp: number;
  messagesInWindow: number;
  bytesInWindow: number;
  throughputMbps: number;
}

// Calculate comprehensive bandwidth metrics
function calculateBandwidthMetrics(
  messageCount: number,
  totalBytes: number,
  duration: number,
  errors: number,
  windowedMetrics: WindowedMetrics[]
): BandwidthMetrics {
  const messagesPerSecond = messageCount / duration;
  const bytesPerSecond = totalBytes / duration;
  const megabitsPerSecond = (bytesPerSecond * 8) / (1024 * 1024);
  const averageMessageSize = messageCount > 0 ? totalBytes / messageCount : 0;
  const peakThroughput = windowedMetrics.length > 0 
    ? Math.max(...windowedMetrics.map(w => w.throughputMbps))
    : 0;

  return {
    duration,
    messageCount,
    totalBytes,
    messagesPerSecond,
    bytesPerSecond,
    megabitsPerSecond,
    averageMessageSize,
    peakThroughput,
    errors,
  };
}

// Format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Performance assessment based on bandwidth
function assessPerformance(mbps: number): string {
  if (mbps > 1000) return '🟢 EXCELLENT: >1 Gbps - Enterprise grade performance';
  if (mbps > 500) return '🟢 VERY GOOD: >500 Mbps - High performance streaming';
  if (mbps > 100) return '🟡 GOOD: >100 Mbps - Solid performance';
  if (mbps > 50) return '🟠 MODERATE: >50 Mbps - Acceptable performance';
  if (mbps > 10) return '🟠 LIMITED: >10 Mbps - Basic performance';
  return '🔴 LOW: <10 Mbps - Performance issues detected';
}

async function runNAPIBandwidthTest(testDurationSeconds: number = 30) {
  console.log('🚀 NAPI LASERSTREAM BANDWIDTH TEST');
  console.log('═'.repeat(60));
  console.log(`🔧 Test Duration: ${testDurationSeconds}s`);
  console.log(`🔧 Endpoint: ${testConfig.laserstreamProduction.endpoint}`);
  console.log(`🔧 Token: ${testConfig.laserstreamProduction.apiKey ? 'Present' : 'Missing'}`);
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

  // Test metrics
  let messageCount = 0;
  let totalBytes = 0;
  let errorCount = 0;
  const startTime = performance.now();
  const windowedMetrics: WindowedMetrics[] = [];
  const windowSize = 2000; // 2 second windows
  
  let windowStartTime = performance.now();
  let windowMessageCount = 0;
  let windowByteCount = 0;

  // Message size estimation (will be refined during test)
  const estimatedMessageSize = 1024; // Start with 1KB estimate

  console.log('🔧 Test 1: Basic NAPI Functionality');
  console.log('Creating Laserstream NAPI client...');

  let client: LaserstreamClient;
  let stream: any;

  try {
    // Initialize client
    client = new LaserstreamClient(testConfig.laserstreamProduction.endpoint, testConfig.laserstreamProduction.apiKey);
    console.log('✅ NAPI client created successfully');
    console.log();

    console.log('🔧 Test 2: High-Throughput Subscription with Replay');
    console.log('Starting high-throughput subscription with historical replay...');
    console.log('📊 Subscribing to accounts, transactions, and slots for maximum data flow');
    console.log(`🔥 Replaying from slot ${replaySlot.toLocaleString()} for maximum bandwidth pressure`);
    console.log();

    // High-throughput subscription request with replay
    const subscriptionRequest = {
      accounts: {
        'all-accounts': {
          account: [],
          owner: [],
          filters: []
        }
      },
      transactions: {
        'all-transactions': {
          vote: false,
          failed: false,
          accountInclude: [],
          accountExclude: [],
          accountRequired: []
        }
      },
      slots: {
        'all-slots': {
          filterByCommitment: false,
          interslotUpdates: true
        }
      },
      blocks: {},
      blocksMeta: {},
      entry: {},
      transactionsStatus: {},
      commitment: 0, // Processed for maximum throughput
      accountsDataSlice: [],
      fromSlot: replaySlot, // Replay from 1000 slots back for maximum bandwidth
    };

    // Callback function to handle messages
    const onMessage = (error: Error | null, update: any) => {
      if (error) {
        console.error(`❌ Stream error: ${error.message}`);
        errorCount++;
        return;
      }

      if (!update) return;

      // Estimate message size (JSON serialization approximation)
      const messageSize = JSON.stringify(update).length;
      
      messageCount++;
      totalBytes += messageSize;
      windowMessageCount++;
      windowByteCount += messageSize;

      // Check if we should create a new window
      const now = performance.now();
      if (now - windowStartTime >= windowSize) {
        const windowDuration = (now - windowStartTime) / 1000;
        const windowThroughput = (windowByteCount * 8) / (1024 * 1024 * windowDuration);
        
        windowedMetrics.push({
          timestamp: now,
          messagesInWindow: windowMessageCount,
          bytesInWindow: windowByteCount,
          throughputMbps: windowThroughput
        });

        // Reset window
        windowStartTime = now;
        windowMessageCount = 0;
        windowByteCount = 0;
      }

      // Real-time feedback every 1000 messages
      if (messageCount % 1000 === 0) {
        const elapsed = (now - startTime) / 1000;
        const currentThroughput = (totalBytes * 8) / (1024 * 1024 * elapsed);
        const messagesPerSec = messageCount / elapsed;
        
        console.log(`📊 ${messageCount.toLocaleString()} messages | ${formatBytes(totalBytes)} | ${currentThroughput.toFixed(1)} Mbps | ${messagesPerSec.toFixed(0)} msg/s`);
      }
    };

    // Start subscription
    stream = await client.subscribe(subscriptionRequest, onMessage);
    console.log('✅ High-throughput subscription started!');
    console.log('📡 Collecting bandwidth data...');
    
    // Progress reporting
    const progressInterval = setInterval(() => {
      const elapsed = (performance.now() - startTime) / 1000;
      const remaining = Math.max(0, testDurationSeconds - elapsed);
      const currentThroughput = elapsed > 0 ? (totalBytes * 8) / (1024 * 1024 * elapsed) : 0;
      const messagesPerSec = elapsed > 0 ? messageCount / elapsed : 0;
      
      console.log(`\n⏱️  Progress: ${elapsed.toFixed(1)}s / ${testDurationSeconds}s (${remaining.toFixed(1)}s remaining)`);
      console.log(`📊 Current: ${messageCount.toLocaleString()} messages | ${formatBytes(totalBytes)} | ${currentThroughput.toFixed(1)} Mbps | ${messagesPerSec.toFixed(0)} msg/s`);
      
      if (errorCount > 0) {
        console.log(`⚠️  Errors: ${errorCount}`);
      }
    }, 5000);

    // Stop test after duration
    setTimeout(() => {
      clearInterval(progressInterval);
      generateFinalReport();
    }, testDurationSeconds * 1000);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down gracefully...');
      clearInterval(progressInterval);
      generateFinalReport();
    });

    function generateFinalReport() {
      const endTime = performance.now();
      const totalDuration = (endTime - startTime) / 1000;
      
      const metrics = calculateBandwidthMetrics(
        messageCount,
        totalBytes,
        totalDuration,
        errorCount,
        windowedMetrics
      );

      console.log('\n\n🏁 NAPI LASERSTREAM BANDWIDTH REPORT');
      console.log('═'.repeat(60));
      
      // Test Configuration
                    console.log('⚙️  TEST CONFIGURATION:');
       console.log(`🔧 Test Duration: ${metrics.duration.toFixed(2)}s`);
       console.log(`🔧 Endpoint: ${testConfig.laserstreamProduction.endpoint}`);
       console.log(`🔧 Commitment Level: 0 (Processed - Maximum Throughput)`);
       console.log(`🔧 Subscription: High-throughput (accounts + transactions + slots)`);
       console.log(`🔧 Replay Mode: FROM SLOT ${replaySlot.toLocaleString()} (${currentSlot - replaySlot} slots replayed)`);
       console.log();

      // Core Metrics
      console.log('📊 CORE BANDWIDTH METRICS:');
      console.log(`📈 Messages Processed: ${metrics.messageCount.toLocaleString()}`);
      console.log(`📈 Data Transferred: ${formatBytes(metrics.totalBytes)}`);
      console.log(`📈 Messages/Second: ${metrics.messagesPerSecond.toFixed(1)}`);
      console.log(`📈 Data Rate: ${formatBytes(metrics.bytesPerSecond)}/s`);
      console.log(`📈 Bandwidth: ${metrics.megabitsPerSecond.toFixed(2)} Mbps`);
      console.log(`📈 Average Message Size: ${formatBytes(metrics.averageMessageSize)}`);
      console.log(`📈 Peak Throughput: ${metrics.peakThroughput.toFixed(2)} Mbps`);
      console.log();

      // Error Analysis
      if (metrics.errors > 0) {
        console.log('⚠️  ERROR ANALYSIS:');
        console.log(`❌ Total Errors: ${metrics.errors}`);
        console.log(`📊 Error Rate: ${(metrics.errors / (metrics.messageCount + metrics.errors) * 100).toFixed(2)}%`);
        console.log();
      }

      // Throughput Analysis
      if (windowedMetrics.length > 0) {
        console.log('📈 THROUGHPUT ANALYSIS:');
        const avgThroughput = windowedMetrics.reduce((sum, w) => sum + w.throughputMbps, 0) / windowedMetrics.length;
        const minThroughput = Math.min(...windowedMetrics.map(w => w.throughputMbps));
        const maxThroughput = Math.max(...windowedMetrics.map(w => w.throughputMbps));
        const stdDev = Math.sqrt(
          windowedMetrics.reduce((sum, w) => sum + Math.pow(w.throughputMbps - avgThroughput, 2), 0) / windowedMetrics.length
        );

        console.log(`📊 Average Throughput: ${avgThroughput.toFixed(2)} Mbps`);
        console.log(`📊 Min Throughput: ${minThroughput.toFixed(2)} Mbps`);
        console.log(`📊 Max Throughput: ${maxThroughput.toFixed(2)} Mbps`);
        console.log(`📊 Standard Deviation: ${stdDev.toFixed(2)} Mbps`);
        console.log(`📊 Throughput Stability: ${stdDev < avgThroughput * 0.2 ? '✅ Stable' : '⚠️ Variable'}`);
        console.log();
      }

      // Performance Assessment
      console.log('🏆 PERFORMANCE ASSESSMENT:');
      console.log(assessPerformance(metrics.megabitsPerSecond));
      console.log();

      // Benchmarking Context
      console.log('📋 BENCHMARKING CONTEXT:');
      console.log('🔸 Excellent (>1000 Mbps): Suitable for high-frequency trading, real-time analytics');
      console.log('🔸 Very Good (500-1000 Mbps): Great for most production applications');
      console.log('🔸 Good (100-500 Mbps): Suitable for standard blockchain applications');
      console.log('🔸 Moderate (50-100 Mbps): Acceptable for basic monitoring and logging');
      console.log('🔸 Limited (10-50 Mbps): May struggle with high-activity periods');
      console.log('🔸 Low (<10 Mbps): Investigate network or implementation issues');
      console.log();

      // Recommendations
      console.log('💡 RECOMMENDATIONS:');
      if (metrics.megabitsPerSecond > 500) {
        console.log('✅ Performance is excellent - ready for production use');
      } else if (metrics.megabitsPerSecond > 100) {
        console.log('✅ Good performance - suitable for most applications');
        console.log('💡 Consider optimizing for peak traffic periods');
      } else if (metrics.megabitsPerSecond > 50) {
        console.log('⚠️  Moderate performance - monitor during high activity');
        console.log('💡 Consider network optimization or load balancing');
      } else {
        console.log('🔴 Performance below expectations');
        console.log('💡 Check network connectivity and subscription filters');
        console.log('💡 Consider reducing subscription scope or increasing resources');
      }

      if (metrics.errors > 0) {
        console.log('⚠️  Errors detected - investigate connection stability');
      }

      // Cleanup
      if (stream && typeof stream.cancel === 'function') {
        stream.cancel();
      }
      
      process.exit(metrics.errors > 0 ? 1 : 0);
    }

    // Keep the process running
    await new Promise(() => {});

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Parse command line arguments
const testDuration = process.argv[2] ? parseInt(process.argv[2]) : 30;

if (isNaN(testDuration) || testDuration < 10) {
  console.error('❌ Invalid test duration. Use: ts-node napi-bandwidth-test.ts <seconds>');
  console.error('   Minimum duration: 10 seconds');
  process.exit(1);
}

console.log('🎯 Starting NAPI Laserstream Bandwidth Test...');
console.log(`⏱️  Test Duration: ${testDuration} seconds`);
console.log('🔧 Press Ctrl+C to stop early\n');

runNAPIBandwidthTest(testDuration).catch((error) => {
  console.error('💥 NAPI bandwidth test failed:', error);
  process.exit(1);
}); 