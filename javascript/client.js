const { LaserstreamClient: NapiClient, CommitmentLevel, shutdownAllStreams, getActiveStreamCount } = require('./index');
const { initProtobuf, decodeSubscribeUpdate, decodeSubscribePreprocessedUpdate } = require('./proto-decoder');

// Compression algorithms enum
const CompressionAlgorithms = {
  identity: 0,
  deflate: 1,
  gzip: 2,
  zstd: 3  // zstd is supported in our Rust NAPI bindings
};

// Initialize protobuf on module load
let protobufInitialized = false;

async function ensureProtobufInitialized() {
  if (!protobufInitialized) {
    await initProtobuf();
    protobufInitialized = true;
  }
}

// Single subscribe function using NAPI directly
async function subscribe(config, request, onData, onError) {
  // Ensure protobuf is initialized
  await ensureProtobufInitialized();

  // Create NAPI client instance directly
  const napiClient = new NapiClient(
    config.endpoint,
    config.apiKey,
    config.maxReconnectAttempts,
    config.channelOptions,
    config.replay
  );

  // Wrap the callbacks to decode protobuf bytes
  const wrappedCallback = (error, updateBytes) => {
    if (error) {
      if (onError) {
        onError(error);
      }
      return;
    }

    try {
      // Decode the protobuf bytes to JavaScript object
      const decodedUpdate = decodeSubscribeUpdate(updateBytes);
      if (onData) {
        onData(decodedUpdate);
      }
    } catch (decodeError) {
      if (onError) {
        onError(decodeError);
      }
    }
  };

  // Call the NAPI client directly with the wrapped callback
  try {
    const streamHandle = await napiClient.subscribe(request, wrappedCallback);
    return streamHandle;
  } catch (error) {
    if (onError) {
      onError(error);
    }
    throw error;
  }
}

// Subscribe to preprocessed transactions
async function subscribePreprocessed(config, request, onData, onError) {
  // Ensure protobuf is initialized
  await ensureProtobufInitialized();

  // Create NAPI client instance directly
  const napiClient = new NapiClient(
    config.endpoint,
    config.apiKey,
    config.maxReconnectAttempts,
    config.channelOptions,
    false  // replay is not used for preprocessed subscriptions
  );

  // Wrap the callbacks to decode protobuf bytes
  const wrappedCallback = (error, updateBytes) => {
    if (error) {
      if (onError) {
        onError(error);
      }
      return;
    }

    try {
      // Decode the preprocessed protobuf bytes to JavaScript object
      const decodedUpdate = decodeSubscribePreprocessedUpdate(updateBytes);
      if (onData) {
        onData(decodedUpdate);
      }
    } catch (decodeError) {
      if (onError) {
        onError(decodeError);
      }
    }
  };

  // Call the NAPI client's subscribePreprocessed method
  try {
    const streamHandle = await napiClient.subscribePreprocessed(request, wrappedCallback);
    return streamHandle;
  } catch (error) {
    if (onError) {
      onError(error);
    }
    throw error;
  }
}

// Export clean API with only NAPI-based subscribe
module.exports = {
  subscribe,
  subscribePreprocessed,
  CommitmentLevel,
  CompressionAlgorithms,
  initProtobuf,
  decodeSubscribeUpdate,
  decodeSubscribePreprocessedUpdate,
  // re-export lifecycle helpers from native binding
  shutdownAllStreams,
  getActiveStreamCount,
}; 