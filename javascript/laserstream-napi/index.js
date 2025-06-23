const {
  LaserStreamClient: NativeLaserStreamClient,
} = require("./laserstream-napi.node");

class LaserStream {
  constructor(endpoint, token = null) {
    this.native = new NativeLaserStreamClient(endpoint, token);
    this.streams = new Map();
  }

  async subscribe(request, onMessage, onError = null) {
    try {
      const handle = await this.native.subscribe(request, (buffer) => {
        try {
          // Pass raw buffer to user callback
          // User can parse protobuf if needed
          onMessage(buffer);
        } catch (err) {
          if (onError) {
            onError(err);
          } else {
            console.error("Error in message callback:", err);
          }
        }
      });

      this.streams.set(handle.id, handle);

      // Return handle with additional methods
      return {
        id: handle.id,
        cancel: () => {
          handle.cancel();
          this.streams.delete(handle.id);
        },
        get metrics() {
          return handle.metrics;
        },
      };
    } catch (error) {
      if (onError) {
        onError(error);
      }
      throw error;
    }
  }

  getMetrics() {
    return this.native.metrics;
  }

  getStreamMetrics(streamId) {
    const handle = this.streams.get(streamId);
    return handle ? handle.metrics : null;
  }

  async close() {
    // Cancel all active streams
    for (const [id, handle] of this.streams) {
      handle.cancel();
    }
    this.streams.clear();
  }

  // Convenience method for bandwidth testing
  async subscribeAll(onMessage, onError = null) {
    return this.subscribe(
      {
        accounts: {},
        transactions: {},
        blocks: {},
        slots: {},
      },
      onMessage,
      onError,
    );
  }

  // Method to create multiple parallel streams for testing
  async createParallelStreams(count, request, onMessage, onError = null) {
    const promises = [];

    for (let i = 0; i < count; i++) {
      promises.push(this.subscribe(request, onMessage, onError));
    }

    return Promise.all(promises);
  }
}

module.exports = LaserStream;
