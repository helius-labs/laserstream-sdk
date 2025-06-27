import { LaserstreamClient } from '../index';
import { performance } from 'perf_hooks';

const testConfig = require('../test-config.js');

// Function to get current slot number
async function getCurrentSlot(): Promise<number> {
  try {
    if (typeof fetch === 'undefined') {
      console.warn('⚠️  Fetch not available, using fallback slot');
      return 280000000;
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
    return data.result || 280000000;
  } catch (error) {
    console.warn('⚠️  Could not fetch current slot, using fallback');
    return 280000000;
  }
}

// gRPC Performance metrics following best practices
interface GrpcPerformanceMetrics {
  duration: number;
  messageCount: number;
  totalBytes: number;
  messagesPerSecond: number;
  bytesPerSecond: number;
  megabytesPerSecond: number;
  gigabytesPerSecond: number;
  averageMessageSize: number;
  peakThroughputMBps: number;
  errors: number;
  connectionEfficiency: number;
}

interface WindowedMetrics {
  timestamp: number;
  messagesInWindow: number;
  bytesInWindow: number;
  throughputBytesPerSec: number;
  throughputMBps: number;
}

// Calculate gRPC performance metrics (bytes-based)
function calculateGrpcMetrics(
  messageCount: number,
  totalBytes: number,
  duration: number,
  errors: number,
  windowedMetrics: WindowedMetrics[]
): GrpcPerformanceMetrics {
  const messagesPerSecond = messageCount / duration;
  const bytesPerSecond = totalBytes / duration;
  const megabytesPerSecond = bytesPerSecond / (1024 * 1024);
  const gigabytesPerSecond = bytesPerSecond / (1024 * 1024 * 1024);
  const averageMessageSize = messageCount > 0 ? totalBytes / messageCount : 0;
  const peakThroughputMBps = windowedMetrics.length > 0 
    ? Math.max(...windowedMetrics.map(w => w.throughputMBps))
    : 0;
  
  // Connection efficiency: how well we're using the gRPC connection
  const connectionEfficiency = messageCount > 0 ? (messagesPerSecond / messageCount) * 100 : 0;

  return {
    duration,
    messageCount,
    totalBytes,
    messagesPerSecond,
    bytesPerSecond,
    megabytesPerSecond,
    gigabytesPerSecond,
    averageMessageSize,
    peakThroughputMBps,
    errors,
    connectionEfficiency,
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

// Format throughput (bytes per second)
function formatThroughput(bytesPerSec: number): string {
  if (bytesPerSec === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// gRPC Performance assessment (based on message throughput)
function assessGrpcPerformance(messagesPerSec: number, megabytesPerSec: number): string {
  if (messagesPerSec > 50000 && megabytesPerSec > 1000) {
    return '🟢 EXCELLENT: High-frequency trading ready (>50K msg/s, >1GB/s)';
  }
  if (messagesPerSec > 20000 && megabytesPerSec > 500) {
    return '🟢 VERY GOOD: Production ready (>20K msg/s, >500MB/s)';
  }
  if (messagesPerSec > 10000 && megabytesPerSec > 100) {
    return '🟡 GOOD: Solid performance (>10K msg/s, >100MB/s)';
  }
  if (messagesPerSec > 5000 && megabytesPerSec > 50) {
    return '🟠 MODERATE: Acceptable (>5K msg/s, >50MB/s)';
  }
  if (messagesPerSec > 1000 && megabytesPerSec > 10) {
    return '🟠 LIMITED: Basic performance (>1K msg/s, >10MB/s)';
  }
  return '🔴 LOW: Performance issues detected (<1K msg/s, <10MB/s)';
}

async function runGrpcPerformanceTest(testDurationSeconds: number = 30) {
  console.log('🚀 Starting gRPC Performance Test...');
  console.log('🚀 NAPI GRPC PERFORMANCE TEST');
  console.log('═'.repeat(60));
  console.log(`🔧 Test Duration: ${testDurationSeconds}s`);
  console.log(`🔧 Endpoint: ${testConfig.laserstreamProduction.endpoint}`);
  console.log(`🔧 Token: ${testConfig.laserstreamProduction.apiKey ? 'Present' : 'Missing'}`);
  console.log('🔧 Measurement: Bytes/s (following gRPC best practices)');
  console.log('🔧 Optimization: Maximum throughput configuration');
  console.log();
  
  // Performance optimization warnings
  console.log('⚠️  PERFORMANCE PREREQUISITES:');
  console.log('📊 Ensure sufficient bandwidth (>500 Mbps recommended)');
  console.log('📊 CPU: Modern CPU with >3GHz all-core boost');
  console.log('📊 Memory: >16GB RAM (Solana data is memory intensive)');
  console.log('📊 Network: Low latency to Yellowstone gRPC endpoint');
  console.log();

  if (!testConfig.laserstreamProduction.apiKey) {
    console.error('❌ ERROR: Missing API token');
    process.exit(1);
  }

  // Get current slot for replay (gRPC streaming best practice)
  console.log('🔄 Getting current slot for replay...');
  const currentSlot = await getCurrentSlot();
  const replaySlot = Math.max(0, currentSlot - 1000);
  
  console.log(`📊 Current Slot: ${currentSlot.toLocaleString()}`);
  console.log(`📊 Replay From Slot: ${replaySlot.toLocaleString()}`);
  console.log(`🔥 Replaying ${currentSlot - replaySlot} slots for maximum gRPC load!`);
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

  console.log('🔧 Test 1: gRPC Client Initialization');
  console.log('Creating NAPI gRPC client (following channel reuse best practices)...');

  let client: LaserstreamClient;
  let stream: any;

  try {
    // Initialize client with maximum throughput settings
    client = new LaserstreamClient(
      testConfig.laserstreamProduction.endpoint, 
      testConfig.laserstreamProduction.apiKey,
    );
    console.log('✅ gRPC client created successfully');
    console.log();

    console.log('🔧 Test 2: High-Throughput gRPC Streaming');
    console.log('Starting gRPC streaming subscription with historical replay...');
    console.log('📊 Subscribing to accounts, transactions, and slots');
    console.log(`🔥 Using fromSlot parameter for maximum protobuf message flow`);
    console.log();

    // MAXIMUM THROUGHPUT subscription (all data streams)
    const subscriptionRequest = {
      // All account updates (massive volume)
      accounts: {
        'max-throughput-accounts': {
          account: [], // Empty = all accounts
          owner: [],   // Empty = all owners  
          filters: []  // No filters = maximum data
        }
      },
      // All transactions including votes (highest volume)
      transactions: {
        'max-throughput-transactions': {
          vote: true,           // ✅ Include vote transactions (~1000+/sec)
          failed: true,         // ✅ Include failed transactions
          accountInclude: [],   // Empty = all programs
          accountExclude: [],   // No exclusions
          accountRequired: []   // No requirements
        }
      },
      // All slot updates with inter-slot data
      slots: {
        'max-throughput-slots': {
          filterByCommitment: false,  // All commitment levels
          interslotUpdates: true      // Include intermediate updates
        }
      },
      // Include transaction status updates
      transactionsStatus: {
        'max-throughput-tx-status': {
          vote: true,
          failed: true,
          accountInclude: [],
          accountExclude: [],
          accountRequired: []
        }
      },
      // All block data (heavy but comprehensive)
      blocks: {
        'max-throughput-blocks': {
          accountInclude: [],
          includeTransactions: true,  // Include full transaction data
          includeAccounts: true,      // Include account updates
          includeEntries: true        // Include all entries
        }
      },
      blocksMeta: {
        'max-throughput-block-meta': {} // All block metadata
      },
      entry: {
        'max-throughput-entries': {} // All ledger entries
      },
      commitment: 0, // Processed = maximum throughput (lowest latency)
      accountsDataSlice: [], // No data slicing = full account data
      fromSlot: replaySlot,  // Historical replay for maximum initial load
    };

    // gRPC message callback
    const onMessage = (error: Error | null, update: any) => {
      if (error) {
        console.error(`❌ gRPC Stream error: ${error.message}`);
        errorCount++;
        return;
      }

      if (!update) return;

      // Calculate protobuf message size (binary, not JSON)
      const messageSize = JSON.stringify(update).length; // Approximation for now
      
      messageCount++;
      totalBytes += messageSize;
      windowMessageCount++;
      windowByteCount += messageSize;

      // Check if we should create a new performance window
      const now = performance.now();
      if (now - windowStartTime >= windowSize) {
        const windowDuration = (now - windowStartTime) / 1000;
        const windowThroughputBytesPerSec = windowByteCount / windowDuration;
        const windowThroughputMBps = windowThroughputBytesPerSec / (1024 * 1024);
        
        windowedMetrics.push({
          timestamp: now,
          messagesInWindow: windowMessageCount,
          bytesInWindow: windowByteCount,
          throughputBytesPerSec: windowThroughputBytesPerSec,
          throughputMBps: windowThroughputMBps
        });

        // Reset window
        windowStartTime = now;
        windowMessageCount = 0;
        windowByteCount = 0;
      }

      // Real-time feedback every 1000 messages
      if (messageCount % 1000 === 0) {
        const elapsed = (now - startTime) / 1000;
        const currentThroughput = formatThroughput(totalBytes / elapsed);
        const messagesPerSec = messageCount / elapsed;
        
        console.log(`📊 ${messageCount.toLocaleString()} msgs | ${formatBytes(totalBytes)} | ${currentThroughput} | ${messagesPerSec.toFixed(0)} msg/s`);
      }
    };

    // Start gRPC streaming
    stream = await client.subscribe(subscriptionRequest, onMessage);
    console.log('✅ gRPC streaming started!');
    console.log('📡 Collecting protobuf message performance data...');
    
    // Progress reporting
    const progressInterval = setInterval(() => {
      const elapsed = (performance.now() - startTime) / 1000;
      const remaining = Math.max(0, testDurationSeconds - elapsed);
      const currentThroughput = formatThroughput(elapsed > 0 ? totalBytes / elapsed : 0);
      const messagesPerSec = elapsed > 0 ? messageCount / elapsed : 0;
      
      console.log(`\n⏱️  Progress: ${elapsed.toFixed(1)}s / ${testDurationSeconds}s (${remaining.toFixed(1)}s remaining)`);
      console.log(`📊 Current: ${messageCount.toLocaleString()} msgs | ${formatBytes(totalBytes)} | ${currentThroughput} | ${messagesPerSec.toFixed(0)} msg/s`);
      
      if (errorCount > 0) {
        console.log(`⚠️  gRPC Errors: ${errorCount}`);
      }
    }, 5000);

    // Stop test after duration
    setTimeout(() => {
      clearInterval(progressInterval);
      generateGrpcReport();
    }, testDurationSeconds * 1000);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down gRPC connection gracefully...');
      clearInterval(progressInterval);
      generateGrpcReport();
    });

    function generateGrpcReport() {
      const endTime = performance.now();
      const totalDuration = (endTime - startTime) / 1000;
      
      const metrics = calculateGrpcMetrics(
        messageCount,
        totalBytes,
        totalDuration,
        errorCount,
        windowedMetrics
      );

      console.log('\n\n🏁 GRPC PERFORMANCE REPORT');
      console.log('═'.repeat(60));
      
      // Test Configuration
      console.log('⚙️  TEST CONFIGURATION:');
      console.log(`🔧 Test Duration: ${metrics.duration.toFixed(2)}s`);
      console.log(`🔧 Endpoint: ${testConfig.laserstreamProduction.endpoint}`);
      console.log(`🔧 Protocol: gRPC with HTTP/2 (binary protobuf)`);
      console.log(`🔧 Commitment Level: 0 (Processed - Maximum Throughput)`);
      console.log(`🔧 Subscription: High-throughput streaming`);
      console.log(`🔧 Replay Mode: FROM SLOT ${replaySlot.toLocaleString()} (${currentSlot - replaySlot} slots)`);
      console.log();

      // Core gRPC Metrics (bytes-based)
      console.log('📊 CORE GRPC PERFORMANCE METRICS:');
      console.log(`📈 Messages Processed: ${metrics.messageCount.toLocaleString()}`);
      console.log(`📈 Total Data: ${formatBytes(metrics.totalBytes)}`);
      console.log(`📈 Test Duration: ${metrics.duration.toFixed(2)}s`);
      console.log(`📈 Message Rate: ${metrics.messagesPerSecond.toFixed(1)} msg/s`);
      console.log(`📈 Data Throughput: ${formatThroughput(metrics.bytesPerSecond)}`);
      console.log(`📈 Peak Throughput: ${metrics.peakThroughputMBps.toFixed(2)} MB/s`);
      console.log(`📈 Average Message Size: ${formatBytes(metrics.averageMessageSize)}`);
      console.log();
      
      // gRPC-Specific Analysis
      console.log('🔍 GRPC ANALYSIS:');
      console.log(`📊 Messages/s: ${metrics.messagesPerSecond.toFixed(1)} (primary gRPC metric)`);
      console.log(`📊 Throughput: ${metrics.megabytesPerSecond.toFixed(2)} MB/s`);
      console.log(`📊 Protobuf Efficiency: ${(metrics.totalBytes / messageCount / 1024).toFixed(2)} KB per message`);
      console.log();

      // Error Analysis
      if (metrics.errors > 0) {
        console.log('⚠️  ERROR ANALYSIS:');
        console.log(`❌ gRPC Errors: ${metrics.errors}`);
        console.log(`📊 Error Rate: ${(metrics.errors / (metrics.messageCount + metrics.errors) * 100).toFixed(2)}%`);
        console.log();
      }

      // Windowed Analysis
      if (windowedMetrics.length > 0) {
        console.log('📈 WINDOWED PERFORMANCE ANALYSIS (2-second windows):');
        const avgThroughputMBps = windowedMetrics.reduce((sum, w) => sum + w.throughputMBps, 0) / windowedMetrics.length;
        const minThroughputMBps = Math.min(...windowedMetrics.map(w => w.throughputMBps));
        const maxThroughputMBps = Math.max(...windowedMetrics.map(w => w.throughputMBps));
        const stdDev = Math.sqrt(
          windowedMetrics.reduce((sum, w) => sum + Math.pow(w.throughputMBps - avgThroughputMBps, 2), 0) / windowedMetrics.length
        );

        console.log(`📊 Average: ${avgThroughputMBps.toFixed(2)} MB/s`);
        console.log(`📊 Range: ${minThroughputMBps.toFixed(2)} - ${maxThroughputMBps.toFixed(2)} MB/s`);
        console.log(`📊 Stability: ${stdDev < avgThroughputMBps * 0.2 ? '✅ Stable' : '⚠️ Variable'} (${(stdDev/avgThroughputMBps*100).toFixed(1)}% variation)`);
        console.log(`📊 Windows: ${windowedMetrics.length} × 2s samples`);
        console.log();
      }

      // gRPC Performance Assessment
      console.log('🏆 GRPC PERFORMANCE ASSESSMENT:');
      console.log(assessGrpcPerformance(metrics.messagesPerSecond, metrics.megabytesPerSecond));
      console.log();

      // gRPC Best Practices Context
      console.log('📋 GRPC PERFORMANCE CONTEXT:');
      console.log('🔸 Excellent (>50K msg/s): Real-time trading, high-frequency analytics');
      console.log('🔸 Very Good (20-50K msg/s): Production streaming applications');
      console.log('🔸 Good (10-20K msg/s): Standard blockchain applications');
      console.log('🔸 Moderate (5-10K msg/s): Basic monitoring and logging');
      console.log('🔸 Limited (1-5K msg/s): Low-frequency applications');
      console.log('🔸 Low (<1K msg/s): Investigate gRPC connection issues');
      console.log();

      // Recommendations
      console.log('💡 GRPC OPTIMIZATION RECOMMENDATIONS:');
      if (metrics.messagesPerSecond > 20000) {
        console.log('✅ Excellent gRPC performance - ready for production');
        console.log('💡 Consider connection pooling for even higher loads');
      } else if (metrics.messagesPerSecond > 10000) {
        console.log('✅ Good gRPC performance - suitable for most applications');
        console.log('💡 Monitor HTTP/2 connection utilization during peak loads');
      } else if (metrics.messagesPerSecond > 5000) {
        console.log('⚠️  Moderate gRPC performance - acceptable for basic use');
        console.log('💡 Consider optimizing protobuf message sizes');
        console.log('💡 Check gRPC keepalive settings');
      } else {
        console.log('🔴 Low gRPC performance detected');
        console.log('💡 Check network connectivity and HTTP/2 settings');
        console.log('💡 Verify gRPC channel reuse patterns');
        console.log('💡 Consider protobuf message optimization');
      }

      if (metrics.errors > 0) {
        console.log('⚠️  gRPC errors detected - investigate connection stability');
      }

      // Cleanup gRPC resources
      if (stream && typeof stream.cancel === 'function') {
        stream.cancel();
      }
      
      process.exit(metrics.errors > 0 ? 1 : 0);
    }

    // Keep the gRPC connection running
    await new Promise(() => {});

  } catch (error) {
    console.error('❌ gRPC test failed:', error);
    process.exit(1);
  }
}

// Parse command line arguments
const testDuration = process.argv[2] ? parseInt(process.argv[2]) : 30;

if (isNaN(testDuration) || testDuration < 10) {
  console.error('❌ Invalid test duration. Use: ts-node napi-grpc-performance-test.ts <seconds>');
  console.error('   Minimum duration: 10 seconds');
  process.exit(1);
}

console.log('🎯 Starting NAPI gRPC Performance Test...');
console.log(`⏱️  Test Duration: ${testDuration} seconds`);
console.log('🔧 Following gRPC best practices (bytes-based measurements)');
console.log('🔧 Press Ctrl+C to stop early\n');

runGrpcPerformanceTest(testDuration).catch((error) => {
  console.error('💥 gRPC performance test failed:', error);
  process.exit(1);
}); 