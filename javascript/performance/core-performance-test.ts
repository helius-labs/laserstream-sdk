import { LaserstreamClient, CommitmentLevel } from '../index';
import Client from '@triton-one/yellowstone-grpc';
import bs58 from 'bs58';

const testConfig = require('../test-config.js');

interface TimingData {
  signature: string;
  slot: string;
  laserstreamTime?: number;
  yellowstoneTime?: number;
  timeDifference?: number; // negative = laserstream faster, positive = yellowstone faster
}

interface PerformanceMetrics {
  // Message counts
  laserstreamMessages: number;
  yellowstoneMessages: number;
  sharedMessages: number;
  
  // Timing analysis (for shared messages only)
  timingDifferences: number[];
  averageTimeDiff: number;
  medianTimeDiff: number;
  standardDeviation: number;
  
  // Win rates (for shared messages only)
  laserstreamWins: number;
  yellowstoneWins: number;
  
  // Throughput
  testDurationSeconds: number;
  laserstreamThroughput: number; // msgs/sec
  yellowstoneThroughput: number; // msgs/sec
}

function calculateMetrics(messages: Map<string, TimingData>, durationSeconds: number): PerformanceMetrics {
  const allMessages = Array.from(messages.values());
  const sharedMessages = allMessages.filter(m => m.laserstreamTime && m.yellowstoneTime);
  
  const timingDifferences = sharedMessages
    .map(m => m.timeDifference!)
    .filter(diff => !isNaN(diff));
  
  const averageTimeDiff = timingDifferences.length > 0 
    ? timingDifferences.reduce((sum, diff) => sum + diff, 0) / timingDifferences.length 
    : 0;
  
  const sortedDiffs = [...timingDifferences].sort((a, b) => a - b);
  const medianTimeDiff = sortedDiffs.length > 0 
    ? sortedDiffs[Math.floor(sortedDiffs.length / 2)] 
    : 0;
  
  const variance = timingDifferences.length > 0
    ? timingDifferences.reduce((sum, diff) => sum + Math.pow(diff - averageTimeDiff, 2), 0) / timingDifferences.length
    : 0;
  const standardDeviation = Math.sqrt(variance);
  
  const laserstreamWins = timingDifferences.filter(diff => diff < 0).length;
  const yellowstoneWins = timingDifferences.filter(diff => diff > 0).length;
  
  return {
    laserstreamMessages: allMessages.filter(m => m.laserstreamTime).length,
    yellowstoneMessages: allMessages.filter(m => m.yellowstoneTime).length,
    sharedMessages: sharedMessages.length,
    timingDifferences,
    averageTimeDiff,
    medianTimeDiff,
    standardDeviation,
    laserstreamWins,
    yellowstoneWins,
    testDurationSeconds: durationSeconds,
    laserstreamThroughput: allMessages.filter(m => m.laserstreamTime).length / durationSeconds,
    yellowstoneThroughput: allMessages.filter(m => m.yellowstoneTime).length / durationSeconds,
  };
}

async function runCorePerformanceTest(testDurationSeconds: number = 60) {
  console.log('🎯 CORE PERFORMANCE TEST - Laserstream vs Yellowstone');
  console.log(`Duration: ${testDurationSeconds}s | Focus: Timing differences for shared messages\n`);

  // High-volume programs for meaningful data
  const PROGRAMS = [
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter
  ];

  const subscriptionRequest = {
    transactions: {
      test: {
        accountInclude: PROGRAMS,
        accountExclude: [],
        accountRequired: [],
        vote: false,
        failed: false
      }
    },
    commitment: CommitmentLevel.Confirmed,
    accounts: {},
    slots: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  const yellowstoneRequest = {
    transactions: {
      test: {
        accountInclude: PROGRAMS,
        accountExclude: [],
        accountRequired: [],
        vote: false,
        failed: false
      }
    },
    commitment: 1, // Confirmed
    accounts: {},
    slots: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  const messages = new Map<string, TimingData>();
  const startTime = Date.now();

  function extractSignature(update: any): { sig: string | null; slot: string | null } {
    try {
      const sig = update?.transaction?.transaction?.signature;
      const slot = update?.transaction?.slot;
      if (!sig) return { sig: null, slot: null };
      return { sig: bs58.encode(Buffer.from(sig)), slot: slot?.toString() || 'unknown' };
    } catch {
      return { sig: null, slot: null };
    }
  }

  // Start Laserstream
  console.log('🟦 Starting Laserstream...');
  const laserstreamClient = new LaserstreamClient(
    testConfig.laserstreamProduction.endpoint,
    testConfig.laserstreamProduction.apiKey
  );

  const laserstreamStream = await laserstreamClient.subscribe(
    subscriptionRequest,
    (error: Error | null, update: any) => {
      if (error) {
        console.error('❌ Laserstream error:', error.message);
        return;
      }

      const { sig, slot } = extractSignature(update);
      if (!sig) return;

      const now = performance.now();
      
      let message = messages.get(sig);
      if (!message) {
        message = { signature: sig, slot: slot || 'unknown' };
        messages.set(sig, message);
      }

      message.laserstreamTime = now;

      // Calculate timing difference if both clients have seen this message
      if (message.yellowstoneTime) {
        message.timeDifference = message.yellowstoneTime - message.laserstreamTime;
        const winner = message.timeDifference > 0 ? 'LS' : 'YS';
        const diff = Math.abs(message.timeDifference).toFixed(2);
        console.log(`${winner} first by ${diff}ms: ${sig.slice(0, 8)}...`);
      }
    }
  );

  // Start Yellowstone  
  console.log('🟨 Starting Yellowstone...');
  const yellowstoneClient = new Client(testConfig.yellowstone.endpoint, testConfig.yellowstone.apiKey, {
    "grpc.max_receive_message_length": 64 * 1024 * 1024,
  });

  const yellowstoneStream = await yellowstoneClient.subscribe();
  await new Promise<void>((resolve, reject) => {
    yellowstoneStream.write(yellowstoneRequest, (err: Error | null | undefined) => {
      if (err) reject(err);
      else resolve();
    });
  });

  yellowstoneStream.on('data', (update: any) => {
    const { sig, slot } = extractSignature(update);
    if (!sig) return;

    const now = performance.now();
    
    let message = messages.get(sig);
    if (!message) {
      message = { signature: sig, slot: slot || 'unknown' };
      messages.set(sig, message);
    }

    message.yellowstoneTime = now;

    // Calculate timing difference if both clients have seen this message
    if (message.laserstreamTime) {
      message.timeDifference = message.yellowstoneTime - message.laserstreamTime;
      const winner = message.timeDifference > 0 ? 'LS' : 'YS';
      const diff = Math.abs(message.timeDifference).toFixed(2);
      console.log(`${winner} first by ${diff}ms: ${sig.slice(0, 8)}...`);
    }
  });

  yellowstoneStream.on('error', (error: Error) => {
    console.error('❌ Yellowstone error:', error.message);
  });

  // Progress updates
  const progressInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const remaining = Math.max(0, testDurationSeconds - elapsed);
    const metrics = calculateMetrics(messages, elapsed);
    
    console.log(`\n⏱️  Progress: ${elapsed.toFixed(0)}s / ${testDurationSeconds}s (${remaining.toFixed(0)}s remaining)`);
    console.log(`📊 Messages: LS ${metrics.laserstreamMessages} | YS ${metrics.yellowstoneMessages} | Shared ${metrics.sharedMessages}`);
    if (metrics.sharedMessages > 0) {
      console.log(`⚡ Avg timing diff: ${metrics.averageTimeDiff.toFixed(2)}ms ${metrics.averageTimeDiff < 0 ? '(LS faster)' : '(YS faster)'}`);
    }
  }, 10000);

  // Auto-stop after duration
  setTimeout(() => {
    clearInterval(progressInterval);
    generateFinalReport();
  }, testDurationSeconds * 1000);

  // Manual stop handler
  process.on('SIGINT', () => {
    clearInterval(progressInterval);
    generateFinalReport();
  });

  function generateFinalReport() {
    const elapsed = (Date.now() - startTime) / 1000;
    const metrics = calculateMetrics(messages, elapsed);

    console.log('\n\n🏁 FINAL PERFORMANCE REPORT');
    console.log('═'.repeat(60));
    console.log(`⏱️  Test Duration: ${elapsed.toFixed(1)}s`);
    console.log();

    // Message Counts
    console.log('📈 MESSAGE COUNTS:');
    console.log(`🟦 Laserstream: ${metrics.laserstreamMessages.toLocaleString()} messages`);
    console.log(`🟨 Yellowstone: ${metrics.yellowstoneMessages.toLocaleString()} messages`);
    console.log(`🔄 Shared (both saw): ${metrics.sharedMessages.toLocaleString()} messages`);
    console.log(`🟦 LS-only: ${(metrics.laserstreamMessages - metrics.sharedMessages).toLocaleString()}`);
    console.log(`🟨 YS-only: ${(metrics.yellowstoneMessages - metrics.sharedMessages).toLocaleString()}`);
    console.log();

    // Message Count Analysis
    const countRatio = metrics.laserstreamMessages / Math.max(metrics.yellowstoneMessages, 1);
    if (countRatio > 2 || countRatio < 0.5) {
      console.log('⚠️  MESSAGE COUNT DISPARITY:');
      if (countRatio > 2) {
        console.log(`🟦 Laserstream saw ${countRatio.toFixed(1)}x more messages than Yellowstone`);
      } else {
        console.log(`🟨 Yellowstone saw ${(1/countRatio).toFixed(1)}x more messages than Laserstream`);
      }
      console.log('💡 Possible causes:');
      console.log('   - Network/connection differences between clients');
      console.log('   - Server-side filtering differences');
      console.log('   - Message dropping under load');
      console.log('   - Genuine performance differences');
      console.log();
    }

    // Throughput
    console.log('🚀 THROUGHPUT:');
    console.log(`🟦 Laserstream: ${metrics.laserstreamThroughput.toFixed(1)} messages/second`);
    console.log(`🟨 Yellowstone: ${metrics.yellowstoneThroughput.toFixed(1)} messages/second`);
    console.log();

    // Timing Analysis (Core Metric)
    if (metrics.sharedMessages > 0) {
      console.log('⚡ TIMING ANALYSIS (CORE METRIC):');
      console.log(`📊 Sample size: ${metrics.sharedMessages.toLocaleString()} shared messages`);
      console.log(`📊 Average difference: ${metrics.averageTimeDiff.toFixed(3)}ms ${metrics.averageTimeDiff < 0 ? '(🟦 LS faster)' : '(🟨 YS faster)'}`);
      console.log(`📊 Median difference: ${metrics.medianTimeDiff.toFixed(3)}ms`);
      console.log(`📊 Standard deviation: ${metrics.standardDeviation.toFixed(3)}ms`);
      console.log();

      // Win Rates
      const lsWinRate = (metrics.laserstreamWins / metrics.sharedMessages) * 100;
      const ysWinRate = (metrics.yellowstoneWins / metrics.sharedMessages) * 100;
      
      console.log('🏆 WIN RATES (for shared messages):');
      console.log(`🟦 Laserstream wins: ${metrics.laserstreamWins.toLocaleString()} (${lsWinRate.toFixed(1)}%)`);
      console.log(`🟨 Yellowstone wins: ${metrics.yellowstoneWins.toLocaleString()} (${ysWinRate.toFixed(1)}%)`);
      console.log();

      // Statistical Significance
      const marginOfError = (1.96 * metrics.standardDeviation) / Math.sqrt(metrics.sharedMessages);
      console.log('📊 STATISTICAL ANALYSIS:');
      console.log(`📊 Margin of error (95% confidence): ±${marginOfError.toFixed(3)}ms`);
      
      if (Math.abs(metrics.averageTimeDiff) > marginOfError) {
        const fasterClient = metrics.averageTimeDiff < 0 ? 'Laserstream' : 'Yellowstone';
        const advantage = Math.abs(metrics.averageTimeDiff).toFixed(3);
        console.log(`✅ STATISTICALLY SIGNIFICANT: ${fasterClient} is ${advantage}ms faster on average`);
      } else {
        console.log(`⚪ NOT STATISTICALLY SIGNIFICANT: Difference could be due to random variation`);
      }
      console.log();

      // Final Verdict
      console.log('🏅 FINAL VERDICT:');
      if (Math.abs(lsWinRate - ysWinRate) < 5) {
        console.log('🤝 PERFORMANCE TIE - Both clients perform similarly');
      } else if (lsWinRate > ysWinRate) {
        console.log(`🥇 LASERSTREAM WINS! (${lsWinRate.toFixed(1)}% vs ${ysWinRate.toFixed(1)}%)`);
        console.log(`   Average advantage: ${Math.abs(metrics.averageTimeDiff).toFixed(3)}ms faster`);
      } else {
        console.log(`🥇 YELLOWSTONE WINS! (${ysWinRate.toFixed(1)}% vs ${lsWinRate.toFixed(1)}%)`);
        console.log(`   Average advantage: ${Math.abs(metrics.averageTimeDiff).toFixed(3)}ms faster`);
      }
    } else {
      console.log('❌ NO SHARED MESSAGES - Cannot perform timing analysis');
      console.log('💡 Both clients may be seeing completely different message sets');
    }

    // Cleanup
    if (laserstreamStream && typeof laserstreamStream.cancel === 'function') {
      laserstreamStream.cancel();
    }
    if (yellowstoneStream && typeof yellowstoneStream.end === 'function') {
      yellowstoneStream.end();
    }
    
    process.exit(0);
  }

  console.log('✅ Both clients connected! Starting performance measurement...');
  console.log(`⏱️  Test will run for ${testDurationSeconds} seconds`);
  console.log('🎯 Focus: Timing differences for messages seen by both clients');
  console.log('⏹️  Press Ctrl+C to stop early\n');

  // Keep running
  await new Promise(() => {});
}

// Parse command line argument for test duration
const testDuration = process.argv[2] ? parseInt(process.argv[2]) : 60;

runCorePerformanceTest(testDuration).catch((error) => {
  console.error('💥 Performance test failed:', error);
  process.exit(1);
}); 