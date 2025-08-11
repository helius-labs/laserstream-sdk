import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig, CompressionAlgorithms } from '../client';

async function main() {
  // Try to load from test config or env
  let apiKey, endpoint;
  try {
    const credentials = require('../test-config');
    apiKey = credentials.laserstreamProduction.apiKey;
    endpoint = credentials.laserstreamProduction.endpoint;
  } catch (e) {
    apiKey = process.env.LASERSTREAM_PRODUCTION_API_KEY || process.env.HELIUS_API_KEY;
    endpoint = process.env.LASERSTREAM_PRODUCTION_ENDPOINT || process.env.LASERSTREAM_ENDPOINT;
  }

  if (!apiKey || !endpoint) {
    console.error('Please set LASERSTREAM_PRODUCTION_API_KEY or HELIUS_API_KEY and endpoint');
    process.exit(1);
  }

  const config: LaserstreamConfig = {
    apiKey,
    endpoint,
    maxReconnectAttempts: 10,
    channelOptions: {
      'grpc.default_compression_algorithm': CompressionAlgorithms.zstd,  // Use zstd compression
      'grpc.max_receive_message_length': 1_000_000_000,  // 1GB
      'grpc.max_send_message_length': 32_000_000,     // 32MB
      'grpc.keepalive_time_ms': 30000,
      'grpc.keepalive_timeout_ms': 5000,
    }
  };

  const request = {
    slots: {
      "compressed-slots": {}
    },
    commitment: CommitmentLevel.PROCESSED,
  };

  console.log('🚀 Starting stream with zstd compression (more efficient than gzip!)...');
  
  let slotCount = 0;
  const maxSlots = 10;

  const stream = await subscribe(
    config,
    request,
    async (update: SubscribeUpdate) => {
      if (update.slot) {
        slotCount++;
        console.log(`✅ Received zstd compressed slot update #${slotCount}: slot=${update.slot.slot}`);
        
        if (slotCount >= maxSlots) {
          console.log(`\n🎉 Received ${maxSlots} zstd compressed slot updates. Stopping...`);
          stream.cancel();
          process.exit(0);
        }
      }
    },
    async (err) => {
      console.error('❌ Stream error:', err);
    }
  );

  console.log(`✅ Stream connected with ID: ${stream.id}`);
  console.log('🔄 Using zstd compression for maximum efficiency');
}

main().catch(console.error);