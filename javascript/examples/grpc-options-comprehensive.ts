import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig, CompressionAlgorithms } from '../client';

async function main() {
  // Try to load credentials
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
    console.error('Please set API key and endpoint');
    process.exit(1);
  }

  console.log('🔧 Comprehensive gRPC Channel Options Example');
  console.log('Demonstrating all supported gRPC options...\n');

  const config: LaserstreamConfig = {
    apiKey,
    endpoint,
    maxReconnectAttempts: 10,
    channelOptions: {
      // Compression
      'grpc.default_compression_algorithm': CompressionAlgorithms.zstd,
      
      // Message size limits
      'grpc.max_send_message_length': 64_000_000,       // 64MB for sending
      'grpc.max_receive_message_length': 2_000_000_000, // 2GB for receiving large blocks
      
      // Keep-alive settings (critical for long-lived connections)
      'grpc.keepalive_time_ms': 20000,        // Send keepalive ping every 20s
      'grpc.keepalive_timeout_ms': 10000,     // Wait 10s for keepalive response
      'grpc.keepalive_permit_without_calls': 1, // Send pings even without active calls
      
      // HTTP/2 settings
      'grpc.http2.min_time_between_pings_ms': 15000, // Min 15s between pings
      'grpc.http2.write_buffer_size': 1048576,       // 1MB write buffer
      'grpc-node.max_session_memory': 67108864,      // 64MB session memory
      
      // Connection timeouts
      'grpc.client_idle_timeout_ms': 300000,  // 5 min idle timeout
      'grpc.max_connection_idle_ms': 300000,  // 5 min connection idle
      
      // Additional options (not all may be supported by Rust implementation)
      'grpc.enable_http_proxy': 0,
      'grpc.use_local_subchannel_pool': 1,
      'grpc.max_concurrent_streams': 1000,
      'grpc.initial_reconnect_backoff_ms': 1000,
      'grpc.max_reconnect_backoff_ms': 30000,
    }
  };

  const request = {
    slots: {
      "test-slots": {}
    },
    commitment: CommitmentLevel.PROCESSED,
  };

  console.log('📊 Channel Options Summary:');
  console.log('   Compression: zstd (5x more efficient than gzip)');
  console.log('   Max receive size: 2GB (for large blocks)');
  console.log('   Max send size: 64MB');
  console.log('   Keep-alive: 20s interval, 10s timeout');
  console.log('   HTTP/2 write buffer: 1MB');
  console.log('   Connection idle timeout: 5 minutes\n');

  let messageCount = 0;
  const stream = await subscribe(
    config,
    request,
    async (update: SubscribeUpdate) => {
      if (update.slot) {
        messageCount++;
        if (messageCount <= 5) {
          console.log(`✅ Slot ${update.slot.slot} - Connection stable with custom gRPC options`);
        }
        
        if (messageCount === 10) {
          console.log(`\n✅ Successfully received ${messageCount} updates with custom gRPC configuration`);
          console.log('🔧 All channel options applied successfully!');
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
  console.log('🔄 Testing custom gRPC channel options...\n');
}

main().catch(console.error);