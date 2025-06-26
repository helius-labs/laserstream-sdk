import { LaserstreamClient, CommitmentLevel } from '../index';
import Client from '@triton-one/yellowstone-grpc';

const testConfig = require('../test-config.js');

interface TimingData {
  slotNumber: string;
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
  
  // CORRECTED: If timeDifference > 0, then yellowstoneTime > laserstreamTime, so Laserstream was faster
  const laserstreamWins = timingDifferences.filter(diff => diff > 0).length;
  const yellowstoneWins = timingDifferences.filter(diff => diff < 0).length;
  
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

async function runSlotPerformanceTest(testDurationSeconds: number = 60) {
  console.log('🎯 SLOT PERFORMANCE TEST - Laserstream vs Yellowstone (LOW THROUGHPUT)');
  console.log(`Duration: ${testDurationSeconds}s | Focus: Slot updates timing comparison (~2-3 msgs/sec)\n`);

  // Use IDENTICAL slot subscription requests for both clients
  const COMMITMENT_LEVEL = 1; // Confirmed
  
  const subscriptionRequest = {
    slots: {
      'slot-updates': {
        filterByCommitment: true,
        interslotUpdates: false
      }
    },
    commitment: COMMITMENT_LEVEL,
    accounts: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  const yellowstoneRequest = {
    slots: {
      'slot-updates': {
        filterByCommitment: true,
        interslotUpdates: false
      }
    },
    commitment: COMMITMENT_LEVEL, // IDENTICAL to Laserstream
    accounts: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  const messages = new Map<string, TimingData>();
  const startTime = Date.now();
  let connectionDelayMs = 0; // Track connection time difference for reporting only

  function extractSlotInfo(update: any): { slotNumber: string | null } {
    try {
      const slotNumber = update?.slot?.slot;
      if (!slotNumber) return { slotNumber: null };
      return { slotNumber: slotNumber.toString() };
    } catch {
      return { slotNumber: null };
    }
  }

  // Use shared timing baseline for fair comparison
  const timingBaseline = performance.now();

  // Start Laserstream
  console.log('🟦 Starting Laserstream...');
  console.log(`🔧 Using SAME endpoint: ${testConfig.laserstreamProduction.endpoint}`);
  console.log(`🔧 Using SAME commitment: ${COMMITMENT_LEVEL} (Confirmed)`);
  console.log('📊 Expected throughput: ~2-3 slot updates per second');
  
  const laserstreamStartTime = performance.now();
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

      const { slotNumber } = extractSlotInfo(update);
      if (!slotNumber) return;

      // Use consistent timing baseline for both clients
      const now = performance.now() - timingBaseline;
      
      let message = messages.get(slotNumber);
      if (!message) {
        message = { slotNumber };
        messages.set(slotNumber, message);
      }

      message.laserstreamTime = now;

      // Calculate timing difference if both clients have seen this message
      if (message.yellowstoneTime) {
        message.timeDifference = message.yellowstoneTime - message.laserstreamTime;
        // Only log significant differences to reduce noise
        if (Math.abs(message.timeDifference) > 5) {
          const winner = message.timeDifference > 0 ? 'LS' : 'YS';
          const diff = Math.abs(message.timeDifference).toFixed(1);
          console.log(`${winner} first by ${diff}ms: Slot ${slotNumber}`);
        }
      }
    }
  );
  
  // Start Yellowstone
  console.log('🟨 Starting Yellowstone...');
  const yellowstoneStartTime = performance.now();
  connectionDelayMs = yellowstoneStartTime - laserstreamStartTime; // For reporting only
  
  const yellowstoneClient = new Client(testConfig.laserstreamProduction.endpoint, testConfig.laserstreamProduction.apiKey, {
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
    const { slotNumber } = extractSlotInfo(update);
    if (!slotNumber) return;

    // Use SAME timing baseline as Laserstream for fair comparison
    const now = performance.now() - timingBaseline;
    
    let message = messages.get(slotNumber);
    if (!message) {
      message = { slotNumber };
      messages.set(slotNumber, message);
    }

    message.yellowstoneTime = now;

    // Calculate timing difference if both clients have seen this message
    if (message.laserstreamTime) {
      message.timeDifference = message.yellowstoneTime - message.laserstreamTime;
      // Only log significant differences to reduce noise
      if (Math.abs(message.timeDifference) > 5) {
        const winner = message.timeDifference > 0 ? 'LS' : 'YS';
        const diff = Math.abs(message.timeDifference).toFixed(1);
        console.log(`${winner} first by ${diff}ms: Slot ${slotNumber}`);
      }
    }
  });

  yellowstoneStream.on('error', (error: Error) => {
    console.error('❌ Yellowstone error:', error.message);
  });

  // Progress updates with enhanced diagnostics
  const progressInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const remaining = Math.max(0, testDurationSeconds - elapsed);
    const metrics = calculateMetrics(messages, elapsed);
    
    console.log(`\n⏱️  Progress: ${elapsed.toFixed(0)}s / ${testDurationSeconds}s (${remaining.toFixed(0)}s remaining)`);
    console.log(`📊 Slot Updates: LS ${metrics.laserstreamMessages} | YS ${metrics.yellowstoneMessages} | Shared ${metrics.sharedMessages}`);
    
    // Enhanced diagnostics
    const lsOnlyMessages = metrics.laserstreamMessages - metrics.sharedMessages;
    const ysOnlyMessages = metrics.yellowstoneMessages - metrics.sharedMessages;
    const shareRate = metrics.sharedMessages / Math.max(metrics.laserstreamMessages, metrics.yellowstoneMessages) * 100;
    
    console.log(`🔍 LS-only: ${lsOnlyMessages} | YS-only: ${ysOnlyMessages} | Share rate: ${shareRate.toFixed(1)}%`);
    
    if (metrics.sharedMessages > 0) {
      console.log(`⚡ Avg timing diff: ${metrics.averageTimeDiff.toFixed(2)}ms ${metrics.averageTimeDiff > 0 ? '(LS faster)' : '(YS faster)'}`);
      console.log(`🏆 Win rate: LS ${(metrics.laserstreamWins/metrics.sharedMessages*100).toFixed(1)}% vs YS ${(metrics.yellowstoneWins/metrics.sharedMessages*100).toFixed(1)}%`);
    }
  }, 20000); // Less frequent updates due to low throughput

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

    console.log('\n\n🏁 SLOT PERFORMANCE REPORT');
    console.log('═'.repeat(60));
    console.log(`⏱️  Test Duration: ${elapsed.toFixed(1)}s`);
    console.log(`🔧 Connection Start Delay: ${connectionDelayMs.toFixed(1)}ms (reporting only)`);
    console.log();
    
    console.log('⚙️  TEST CONFIGURATION:');
    console.log(`🟦 Laserstream Endpoint: ${testConfig.laserstreamProduction.endpoint}`);
    console.log(`🟨 Yellowstone Endpoint: ${testConfig.laserstreamProduction.endpoint} (SAME)`);
    console.log(`📡 Commitment Level: ${COMMITMENT_LEVEL} (Confirmed) for BOTH clients`);
    console.log(`🕒 Timing Baseline: Shared baseline for fair comparison`);
    console.log(`📊 Data Type: Slot updates (LOW throughput)`);
    console.log();

    // Message Counts with Enhanced Analysis
    console.log('📈 SLOT UPDATE COUNTS:');
    console.log(`🟦 Laserstream: ${metrics.laserstreamMessages.toLocaleString()} slot updates`);
    console.log(`🟨 Yellowstone: ${metrics.yellowstoneMessages.toLocaleString()} slot updates`);
    console.log(`🔄 Shared (both saw): ${metrics.sharedMessages.toLocaleString()} slot updates`);
    const lsOnlyMessages = metrics.laserstreamMessages - metrics.sharedMessages;
    const ysOnlyMessages = metrics.yellowstoneMessages - metrics.sharedMessages;
    console.log(`🟦 LS-only: ${lsOnlyMessages.toLocaleString()}`);
    console.log(`🟨 YS-only: ${ysOnlyMessages.toLocaleString()}`);
    
    // Share Rate Analysis
    const shareRate = metrics.sharedMessages / Math.max(metrics.laserstreamMessages, metrics.yellowstoneMessages) * 100;
    console.log(`📊 Share Rate: ${shareRate.toFixed(1)}% (higher is better for comparison validity)`);
    console.log();

    // Throughput
    console.log('🚀 THROUGHPUT:');
    console.log(`🟦 Laserstream: ${metrics.laserstreamThroughput.toFixed(2)} slot updates/second`);
    console.log(`🟨 Yellowstone: ${metrics.yellowstoneThroughput.toFixed(2)} slot updates/second`);
    console.log();

    // Enhanced Timing Analysis (Core Metric)
    if (metrics.sharedMessages > 5) { // Lower threshold for slot updates
      console.log('⚡ TIMING ANALYSIS (CORE METRIC):');
      console.log(`📊 Sample size: ${metrics.sharedMessages.toLocaleString()} shared slot updates`);
      // CORRECTED: If averageTimeDiff > 0, then yellowstoneTime > laserstreamTime on average, so LS is faster
      console.log(`📊 Average difference: ${metrics.averageTimeDiff.toFixed(3)}ms ${metrics.averageTimeDiff > 0 ? '(🟦 LS faster)' : '(🟨 YS faster)'}`);
      console.log(`📊 Median difference: ${metrics.medianTimeDiff.toFixed(3)}ms`);
      console.log(`📊 Standard deviation: ${metrics.standardDeviation.toFixed(3)}ms`);
      
      // Outlier detection
      const q1Index = Math.floor(metrics.timingDifferences.length * 0.25);
      const q3Index = Math.floor(metrics.timingDifferences.length * 0.75);
      const sortedDiffs = [...metrics.timingDifferences].sort((a, b) => a - b);
      const q1 = sortedDiffs[q1Index];
      const q3 = sortedDiffs[q3Index];
      const iqr = q3 - q1;
      const outlierThreshold = 1.5 * iqr;
      const outliers = metrics.timingDifferences.filter(diff => 
        diff < (q1 - outlierThreshold) || diff > (q3 + outlierThreshold)
      ).length;
      
      console.log(`📊 Outliers detected: ${outliers} (${(outliers/metrics.sharedMessages*100).toFixed(1)}%)`);
      console.log();

      // Win Rates
      const lsWinRate = (metrics.laserstreamWins / metrics.sharedMessages) * 100;
      const ysWinRate = (metrics.yellowstoneWins / metrics.sharedMessages) * 100;
      
      console.log('🏆 WIN RATES (for shared slot updates):');
      console.log(`🟦 Laserstream wins: ${metrics.laserstreamWins.toLocaleString()} (${lsWinRate.toFixed(1)}%)`);
      console.log(`🟨 Yellowstone wins: ${metrics.yellowstoneWins.toLocaleString()} (${ysWinRate.toFixed(1)}%)`);
      console.log();

      // Enhanced Statistical Significance
      const marginOfError = (1.96 * metrics.standardDeviation) / Math.sqrt(metrics.sharedMessages);
      console.log('📊 STATISTICAL ANALYSIS:');
      console.log(`📊 Margin of error (95% confidence): ±${marginOfError.toFixed(3)}ms`);
      console.log(`📊 Sample size adequacy: ${metrics.sharedMessages >= 10 ? '✅ Good' : '⚠️ Small'} (${metrics.sharedMessages} samples)`);
      
      if (Math.abs(metrics.averageTimeDiff) > marginOfError && metrics.sharedMessages >= 10) {
        const fasterClient = metrics.averageTimeDiff > 0 ? 'Laserstream' : 'Yellowstone';
        const advantage = Math.abs(metrics.averageTimeDiff).toFixed(3);
        console.log(`✅ STATISTICALLY SIGNIFICANT: ${fasterClient} is ${advantage}ms faster on average`);
      } else {
        console.log(`⚪ NOT STATISTICALLY SIGNIFICANT: Difference could be due to random variation`);
        if (metrics.sharedMessages < 10) {
          console.log(`   (Sample size too small: ${metrics.sharedMessages} < 10)`);
        }
      }
      console.log();

      // Final Verdict with Enhanced Logic
      console.log('🏅 FINAL VERDICT:');
      if (shareRate < 30) {
        console.log('❌ INVALID COMPARISON - Share rate too low for meaningful analysis');
        console.log(`   Only ${shareRate.toFixed(1)}% of slot updates were seen by both clients`);
      } else if (Math.abs(lsWinRate - ysWinRate) < 5 && Math.abs(metrics.averageTimeDiff) <= marginOfError) {
        console.log('🤝 PERFORMANCE TIE - Both clients perform similarly');
        console.log(`   Win rates within 5% (${Math.abs(lsWinRate - ysWinRate).toFixed(1)}% difference)`);
      } else if (lsWinRate > ysWinRate && metrics.averageTimeDiff > marginOfError) {
        console.log(`🥇 LASERSTREAM WINS! (${lsWinRate.toFixed(1)}% vs ${ysWinRate.toFixed(1)}%)`);
        console.log(`   Average advantage: ${Math.abs(metrics.averageTimeDiff).toFixed(3)}ms faster`);
        console.log(`   Throughput advantage: ${((metrics.laserstreamThroughput / metrics.yellowstoneThroughput - 1) * 100).toFixed(1)}%`);
      } else if (ysWinRate > lsWinRate && metrics.averageTimeDiff < -marginOfError) {
        console.log(`🥇 YELLOWSTONE WINS! (${ysWinRate.toFixed(1)}% vs ${lsWinRate.toFixed(1)}%)`);
        console.log(`   Average advantage: ${Math.abs(metrics.averageTimeDiff).toFixed(3)}ms faster`);
      } else {
        console.log('🤔 MIXED RESULTS - Conflicting metrics detected');
        console.log(`   Win rates favor: ${lsWinRate > ysWinRate ? 'Laserstream' : 'Yellowstone'}`);
        console.log(`   Average timing favors: ${metrics.averageTimeDiff > 0 ? 'Laserstream' : 'Yellowstone'}`);
        console.log('💡 Consider longer test duration for clearer results');
      }
    } else {
      console.log('❌ INSUFFICIENT SHARED SLOT UPDATES - Cannot perform timing analysis');
      console.log(`   Only ${metrics.sharedMessages} shared slot updates (minimum: 5)`);
      console.log('💡 Both clients may be seeing completely different slot update sets');
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

  console.log('✅ Both clients connected! Starting SLOT performance measurement...');
  console.log(`⏱️  Test will run for ${testDurationSeconds} seconds`);
  console.log('🎯 Focus: Slot update timing comparison (low throughput)');
  console.log('🔧 Same endpoints, same commitment, same timing baseline');
  console.log('⏹️  Press Ctrl+C to stop early\n');

  // Keep running
  await new Promise(() => {});
}

// Parse command line argument for test duration
const testDuration = process.argv[2] ? parseInt(process.argv[2]) : 60;

runSlotPerformanceTest(testDuration).catch((error) => {
  console.error('💥 Slot performance test failed:', error);
  process.exit(1);
}); 