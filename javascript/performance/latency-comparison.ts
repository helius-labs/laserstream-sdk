import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';
import Client, { SubscribeRequest } from '@triton-one/yellowstone-grpc';
import bs58 from 'bs58';

const config = require('../test-config');

interface LatencyStats {
  laserstreamWins: number;
  yellowstoneWins: number;
  totalTransactions: number;
  avgLatencyDiff: number;
  maxLatencyDiff: number;
  minLatencyDiff: number;
  latencyDiffs: number[];
  // LaserStream loss specific metrics
  laserstreamLosses: number[];
  avgLaserstreamLoss: number;
  maxLaserstreamLoss: number;
  minLaserstreamLoss: number;
}

class LatencyComparator {
  private stats: LatencyStats = {
    laserstreamWins: 0,
    yellowstoneWins: 0,
    totalTransactions: 0,
    avgLatencyDiff: 0,
    maxLatencyDiff: 0,
    minLatencyDiff: Number.MAX_VALUE,
    latencyDiffs: [],
    // LaserStream loss specific metrics
    laserstreamLosses: [],
    avgLaserstreamLoss: 0,
    maxLaserstreamLoss: 0,
    minLaserstreamLoss: Number.MAX_VALUE
  };

  private transactionReceived: Map<string, { source: 'laserstream' | 'yellowstone', timestamp: number }> = new Map();
  private startTime: number = Date.now();
  private testDuration: number = 5 * 60 * 1000; // 5 minutes

  constructor() {}

  async start() {
    console.log('🚀 Starting LaserStream vs Yellowstone latency comparison...');
    console.log('🎯 Testing transaction subscriptions with TokenKeg for 5 minutes');
    console.log('⏱️  Measuring which stream receives transactions first');
    
    // Start both streams in parallel
    await Promise.all([
      this.startLaserStreamSubscription(),
      this.startYellowstoneSubscription()
    ]);

    // Stop after 5 minutes
    setTimeout(() => {
      this.printStats();
      process.exit(0);
    }, this.testDuration);
  }

  private async startLaserStreamSubscription() {
    console.log('🔥 Starting LaserStream subscription...');
    
    const clientConfig: LaserstreamConfig = {
      apiKey: config.laserstreamProduction.apiKey,
      endpoint: config.laserstreamProduction.endpoint
    };

    const subscribeRequest = {
      transactions: {
        "tokenkeg-transactions": {
          vote: false,
          failed: false,
          accountsInclude: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']
        }
      },
      commitment: CommitmentLevel.PROCESSED,
      accounts: {},
      slots: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: []
    };

    try {
      const stream = await subscribe(
        clientConfig,
        subscribeRequest,
        (update: SubscribeUpdate) => {
          if (update.transaction) {
            const tx = update.transaction.transaction;
            if (tx && tx.signature) {
              this.handleTransaction(tx.signature, 'laserstream');
            }
          }
        },
        (error: Error) => {
          console.error('LaserStream error:', error);
        }
      );

      console.log('✅ LaserStream subscription started');
      
      process.on('SIGINT', () => {
        stream.cancel();
        this.printStats();
        process.exit(0);
      });

    } catch (error) {
      console.error('LaserStream subscription failed:', error);
    }
  }

    private async startYellowstoneSubscription() {
    console.log('🟡 Starting Yellowstone subscription...');
    
    const client = new Client(config.yellowstone.endpoint, config.yellowstone.apiKey, {
      "grpc.max_receive_message_length": 1024 * 1024 * 1024,
      "grpc.max_send_message_length": 1024 * 1024 * 1024,
      "grpc.max_message_size": 1024 * 1024 * 1024,
    });

    const subscribeRequest = {
      accounts: {},
      slots: {},
      transactions: {
        "tokenkeg-transactions": {
          accountInclude: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
          accountExclude: [],
          accountRequired: [],
          vote: false,
          failed: false
        }
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: CommitmentLevel.PROCESSED,
      accountsDataSlice: []
    };

    try {
      const stream = await client.subscribe();
      
      await new Promise<void>((resolve, reject) => {
        stream.write(subscribeRequest, (err: Error | null | undefined) => {
          if (err == null) resolve();
          else reject(err);
        });
      });

      stream.on('data', (update: any) => {
        if (update.transaction) {
          const tx = update.transaction.transaction;
          if (tx && tx.signature) {
            this.handleTransaction(tx.signature, 'yellowstone');
          }
        }
      });

      stream.on('error', (error: Error) => {
        console.error('Yellowstone stream error:', error);
      });

      stream.on('end', () => {
        console.log('Yellowstone stream ended');
      });

      console.log('✅ Yellowstone subscription started');

    } catch (error) {
      console.error('Yellowstone subscription failed:', error);
      throw error;
    }
  }

  private handleTransaction(signature: Uint8Array, source: 'laserstream' | 'yellowstone') {
    const sigString = bs58.encode(signature);
    const timestamp = Date.now();
    
    if (this.transactionReceived.has(sigString)) {
      // We've seen this transaction before - calculate latency difference
      const firstReceived = this.transactionReceived.get(sigString)!;
      const latencyDiff = timestamp - firstReceived.timestamp;
      
      this.stats.totalTransactions++;
      this.stats.latencyDiffs.push(latencyDiff);
      
      if (firstReceived.source === 'laserstream') {
        this.stats.laserstreamWins++;
        console.log(`🔥 LaserStream WINS by ${latencyDiff}ms - TX: ${sigString.substring(0, 8)}...`);
      } else {
        this.stats.yellowstoneWins++;
        console.log(`🟡 Yellowstone WINS by ${latencyDiff}ms - TX: ${sigString.substring(0, 8)}...`);
        
        // Track LaserStream loss specific metrics
        this.stats.laserstreamLosses.push(latencyDiff);
        
        // Update LaserStream loss min/max
        if (latencyDiff > this.stats.maxLaserstreamLoss) {
          this.stats.maxLaserstreamLoss = latencyDiff;
        }
        if (latencyDiff < this.stats.minLaserstreamLoss) {
          this.stats.minLaserstreamLoss = latencyDiff;
        }
        
        // Calculate running average of LaserStream losses
        this.stats.avgLaserstreamLoss = this.stats.laserstreamLosses.reduce((a, b) => a + b, 0) / this.stats.laserstreamLosses.length;
      }
      
      // Update min/max latency diffs
      if (latencyDiff > this.stats.maxLatencyDiff) {
        this.stats.maxLatencyDiff = latencyDiff;
      }
      if (latencyDiff < this.stats.minLatencyDiff) {
        this.stats.minLatencyDiff = latencyDiff;
      }
      
      // Calculate running average
      this.stats.avgLatencyDiff = this.stats.latencyDiffs.reduce((a, b) => a + b, 0) / this.stats.latencyDiffs.length;
      
      // Remove from map to free memory
      this.transactionReceived.delete(sigString);
      
    } else {
      // First time seeing this transaction
      this.transactionReceived.set(sigString, { source, timestamp });
    }
  }

  private printStats() {
    const elapsedTime = Date.now() - this.startTime;
    const elapsedMinutes = Math.floor(elapsedTime / 60000);
    const elapsedSeconds = Math.floor((elapsedTime % 60000) / 1000);
    
    console.log('\n\n🏁 LATENCY COMPARISON RESULTS');
    console.log('==========================================');
    console.log(`⏱️  Test Duration: ${elapsedMinutes}m ${elapsedSeconds}s`);
    console.log(`📊 Total Transactions Compared: ${this.stats.totalTransactions}`);
    console.log(`🔥 LaserStream Wins: ${this.stats.laserstreamWins} (${(this.stats.laserstreamWins / this.stats.totalTransactions * 100).toFixed(1)}%)`);
    console.log(`🟡 Yellowstone Wins: ${this.stats.yellowstoneWins} (${(this.stats.yellowstoneWins / this.stats.totalTransactions * 100).toFixed(1)}%)`);
    console.log('\n📈 LATENCY STATISTICS:');
    console.log(`   Average Latency Diff: ${this.stats.avgLatencyDiff.toFixed(2)}ms`);
    console.log(`   Max Latency Diff: ${this.stats.maxLatencyDiff}ms`);
    console.log(`   Min Latency Diff: ${this.stats.minLatencyDiff === Number.MAX_VALUE ? 0 : this.stats.minLatencyDiff}ms`);
    
    if (this.stats.latencyDiffs.length > 0) {
      const sorted = this.stats.latencyDiffs.sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];
      
      console.log(`   P50 Latency Diff: ${p50}ms`);
      console.log(`   P95 Latency Diff: ${p95}ms`);
      console.log(`   P99 Latency Diff: ${p99}ms`);
    }
    
    // LaserStream Loss Analysis
    if (this.stats.laserstreamLosses.length > 0) {
      console.log('\n🔍 LASERSTREAM LOSS ANALYSIS:');
      console.log(`   Total LaserStream Losses: ${this.stats.laserstreamLosses.length}`);
      console.log(`   Average Loss Latency: ${this.stats.avgLaserstreamLoss.toFixed(2)}ms`);
      console.log(`   Max Loss Latency: ${this.stats.maxLaserstreamLoss}ms`);
      console.log(`   Min Loss Latency: ${this.stats.minLaserstreamLoss === Number.MAX_VALUE ? 0 : this.stats.minLaserstreamLoss}ms`);
      
      const sortedLosses = this.stats.laserstreamLosses.sort((a, b) => a - b);
      const lossP50 = sortedLosses[Math.floor(sortedLosses.length * 0.5)];
      const lossP95 = sortedLosses[Math.floor(sortedLosses.length * 0.95)];
      const lossP99 = sortedLosses[Math.floor(sortedLosses.length * 0.99)];
      
      console.log(`   P50 Loss Latency: ${lossP50}ms`);
      console.log(`   P95 Loss Latency: ${lossP95}ms`);
      console.log(`   P99 Loss Latency: ${lossP99}ms`);
    } else {
      console.log('\n🔍 LASERSTREAM LOSS ANALYSIS:');
      console.log('   🎯 LaserStream never lost!');
    }
    
    console.log('\n💡 INSIGHTS:');
    if (this.stats.laserstreamWins > this.stats.yellowstoneWins) {
      console.log('   🎯 LaserStream is generally faster');
    } else if (this.stats.yellowstoneWins > this.stats.laserstreamWins) {
      console.log('   🔍 Yellowstone has more wins than expected');
    } else {
      console.log('   ⚖️  Both streams perform similarly');
    }
    
    if (this.stats.avgLatencyDiff > 100) {
      console.log('   ⚠️  High average latency difference detected');
    }
    
    // LaserStream loss insights
    if (this.stats.laserstreamLosses.length > 0) {
      const lossRate = (this.stats.laserstreamLosses.length / this.stats.totalTransactions) * 100;
      console.log(`   📊 LaserStream loss rate: ${lossRate.toFixed(1)}%`);
      
      if (this.stats.avgLaserstreamLoss > 50) {
        console.log('   ⚠️  LaserStream loses by significant margins when it does lose');
      } else if (this.stats.avgLaserstreamLoss < 20) {
        console.log('   ✅ LaserStream loses by small margins when it does lose');
      }
      
      if (this.stats.maxLaserstreamLoss > 200) {
        console.log('   🔴 Some LaserStream losses are very high latency');
      }
    }
    
    console.log('==========================================\n');
  }
}

async function main() {
  const comparator = new LatencyComparator();
  await comparator.start();
}

main().catch(console.error);