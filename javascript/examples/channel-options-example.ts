import { subscribe, CommitmentLevel, SubscribeUpdate, StreamHandle, LaserstreamConfig, ChannelOptions } from '../client';

const credentials = require('../test-config');

async function main() {
  console.log('⚙️  Laserstream Channel Options Example');

  // Custom channel options
  const channelOptions: ChannelOptions = {
    // Connection timeouts
    connectTimeoutSecs: 20,              // 20 seconds instead of default 10
    timeoutSecs: 60,                     // 60 seconds instead of default 30
    
    // Message size limits
    maxDecodingMessageSize: 2000000000,  // 2GB instead of default 1GB
    maxEncodingMessageSize: 64000000,    // 64MB instead of default 32MB
    
    // Keep-alive settings
    http2KeepAliveIntervalSecs: 15,     // 15 seconds instead of default 30
    keepAliveTimeoutSecs: 10,           // 10 seconds instead of default 5
    keepAliveWhileIdle: true,
    
    // Window sizes for flow control
    initialStreamWindowSize: 8388608,    // 8MB instead of default 4MB
    initialConnectionWindowSize: 16777216, // 16MB instead of default 8MB
    
    // Performance options
    http2AdaptiveWindow: true,
    tcpNodelay: true,
    tcpKeepaliveSecs: 30,               // 30 seconds instead of default 60
    bufferSize: 131072,                 // 128KB instead of default 64KB
  };

  // Configuration with custom channel options
  const config: LaserstreamConfig = {
    apiKey: credentials.laserstreamProduction.apiKey,
    endpoint: credentials.laserstreamProduction.endpoint,
    maxReconnectAttempts: 5,
    channelOptions: channelOptions
  };

  // Subscription request
  const request = {
    slots: {
      client: {
        filterByCommitment: true,
      }
    },
    commitment: CommitmentLevel.CONFIRMED
  };

  try {
    const stream: StreamHandle = await subscribe(
      config,
      request,
      // Data callback
      async (update: SubscribeUpdate) => {
        if (update.slot) {
          console.log(`🎰 Slot update: ${update.slot.slot}`);
        } else {
          console.log('📦 Received update:', update);
        }
      },
      // Error callback
      async (error: Error) => {
        console.error('❌ Stream error:', error);
      }
    );

    console.log(`✅ Stream started with ID: ${stream.id}`);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down...');
      stream.cancel();
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ Failed to subscribe:', error);
    process.exit(1);
  }
}

main().catch(console.error);