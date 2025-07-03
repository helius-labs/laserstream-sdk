const { LaserstreamClient: NapiClient, CommitmentLevel } = require('./index');
const { initProtobuf, decodeSubscribeUpdate } = require('./proto-decoder');

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
  const napiClient = new NapiClient(config.endpoint, config.apiKey, config.maxReconnectAttempts);

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
      console.error('❌ Failed to decode protobuf update:', decodeError);
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
    console.error('❌ Failed to subscribe:', error);
    if (onError) {
      onError(error);
    }
    throw error;
  }
}

// Export clean API with only NAPI-based subscribe
module.exports = {
  subscribe,
  CommitmentLevel,
  initProtobuf,
  decodeSubscribeUpdate
}; 