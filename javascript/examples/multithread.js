const { CommitmentLevel } = require("@triton-one/yellowstone-grpc");
const grpc = require("@triton-one/yellowstone-grpc");
const os = require("os");

function formatBytes(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

class MultiThreadLaserStream {
  constructor(config = {}) {
    this.config = {
      connections: config.connections || os.cpus().length,
      deduplicationWindow: config.deduplicationWindow || 10000,
      orderingBuffer: config.orderingBuffer || 1000,
      url: config.url || "http://localhost:9443",
      token: config.token || "4c3081a5-78cd-4433-af8b-f62ae6dc937c",
      ...config,
    };

    this.connections = [];
    this.messageCache = new Map(); // For deduplication
    this.orderingBuffer = new Map(); // For ordering by slot
    this.lastEmittedSlot = 0;
    this.stats = {
      total: { messages: 0, bytes: 0 },
      connections: new Map(),
    };
    this.startTime = Date.now();
    this.eventHandlers = new Map();
  }

  async initialize() {
    console.log(`Creating ${this.config.connections} parallel connections...`);

    for (let i = 0; i < this.config.connections; i++) {
      await this.createConnection(i);
    }

    // Start periodic cleanup and stats
    this.startPeriodicTasks();
    console.log("All connections initialized!");
  }

  async createConnection(id) {
    const client = new grpc.default(this.config.url, this.config.token, {
      "grpc.max_receive_message_length": 100 * 1024 * 1024, // 100MB
      "grpc-node.flow_control_window": 65 * 1024 * 1024, // 65MB
      "grpc.keepalive_time_ms": 30000,
      "grpc.max_concurrent_streams": 1000,
      "grpc-node.max_session_memory": 512 * 1024 * 1024, // 512MB
    });

    const stream = await client.subscribeOnce(
      // accounts
      {
        allAccounts: {
          account: [],
          owner: [],
          filters: [],
          nonemptyTxnSignature: true,
        },
      },
      // slots
      {},
      // transactions
      {
        allTransactions: {
          accountInclude: [],
          accountExclude: [],
          accountRequired: [],
        },
      },
      // transactionsStatus
      {},
      // entry
      {},
      // blocks
      {
        blocks: {
          includeAccounts: false,
          includeEntries: false,
          includeTransactions: false,
          accountInclude: [],
        },
      },
      // blocksMeta
      { meta: { includeAccounts: false } },
      // commitment
      CommitmentLevel.PROCESSED,
      // accountsDataSlice
      [],
    );

    const connection = {
      id,
      client,
      stream,
      stats: { messages: 0, bytes: 0 },
    };

    this.connections.push(connection);
    this.stats.connections.set(id, connection.stats);

    // Set up event handlers
    stream.on("data", (data) => this.handleMessage(id, data));
    stream.on("error", (err) => this.handleError(id, err));
    stream.on("end", () => this.handleEnd(id));

    return connection;
  }

  handleMessage(connectionId, data) {
    const connection = this.connections.find((c) => c.id === connectionId);

    // Update connection stats
    const estimatedSize = JSON.stringify(data).length;
    connection.stats.messages++;
    connection.stats.bytes += estimatedSize;

    // Create unique message key for deduplication
    const messageKey = this.createMessageKey(data);

    // Skip if we've seen this message recently
    if (this.messageCache.has(messageKey)) {
      return;
    }

    // Add to deduplication cache
    this.messageCache.set(messageKey, Date.now());

    // Handle ordering if message has slot info
    if (this.shouldOrder(data)) {
      this.addToOrderingBuffer(data, estimatedSize);
      this.processOrderedMessages();
    } else {
      // Emit immediately for non-ordered messages
      this.emitMessage(data, estimatedSize);
    }
  }

  createMessageKey(data) {
    // Create unique key based on message content
    if (data.transaction && data.transaction.signature) {
      return `tx:${data.transaction.signature}`;
    }
    if (data.account && data.account.pubkey) {
      return `acc:${data.account.pubkey}:${data.account.lamports}`;
    }
    if (data.slot) {
      return `slot:${data.slot.slot}:${data.slot.parent}`;
    }
    // Fallback to hash of the entire message
    return `msg:${this.simpleHash(JSON.stringify(data))}`;
  }

  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString();
  }

  shouldOrder(data) {
    // Only order slot-based messages
    return data.slot !== undefined;
  }

  addToOrderingBuffer(data, size) {
    const slot = data.slot?.slot || 0;
    if (!this.orderingBuffer.has(slot)) {
      this.orderingBuffer.set(slot, []);
    }
    this.orderingBuffer.get(slot).push({ data, size });
  }

  processOrderedMessages() {
    // Process messages in slot order
    const sortedSlots = Array.from(this.orderingBuffer.keys()).sort(
      (a, b) => a - b,
    );

    for (const slot of sortedSlots) {
      if (slot <= this.lastEmittedSlot) {
        // Skip already processed slots
        this.orderingBuffer.delete(slot);
        continue;
      }

      if (slot === this.lastEmittedSlot + 1) {
        // Emit messages for this slot
        const messages = this.orderingBuffer.get(slot);
        for (const { data, size } of messages) {
          this.emitMessage(data, size);
        }
        this.orderingBuffer.delete(slot);
        this.lastEmittedSlot = slot;
      } else {
        // Gap in sequence, wait for missing slots
        break;
      }
    }

    // Clean up old buffered messages to prevent memory leak
    if (this.orderingBuffer.size > this.config.orderingBuffer) {
      const oldSlots = sortedSlots.slice(
        0,
        sortedSlots.length - this.config.orderingBuffer,
      );
      for (const slot of oldSlots) {
        this.orderingBuffer.delete(slot);
      }
    }
  }

  emitMessage(data, size) {
    // Update total stats
    this.stats.total.messages++;
    this.stats.total.bytes += size;

    // Emit to registered handlers
    this.emit("data", data);
  }

  handleError(connectionId, error) {
    console.error(`❌ Connection ${connectionId} error:`, error.message);
    this.emit("error", { connectionId, error });

    // TODO: Implement auto-reconnection
  }

  handleEnd(connectionId) {
    console.log(`🔚 Connection ${connectionId} ended`);
    this.emit("end", { connectionId });
  }

  startPeriodicTasks() {
    // Stats reporting
    this.statsInterval = setInterval(() => {
      this.reportStats();
    }, 5000);

    // Cache cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanupCache();
    }, 30000);
  }

  reportStats() {
    const now = Date.now();
    const elapsed = (now - this.startTime) / 1000;
    const { total } = this.stats;

    console.log(`\n=== Multi-Connection Performance ===`);
    console.log(`Connections: ${this.config.connections}`);
    console.log(`Total messages: ${total.messages}`);
    console.log(`Total data: ${formatBytes(total.bytes)}`);
    console.log(`Messages/sec: ${(total.messages / elapsed).toFixed(2)}`);
    console.log(`MB/sec: ${(total.bytes / elapsed / 1024 / 1024).toFixed(2)}`);

    console.log(`\nPer-connection breakdown:`);
    for (const [id, stats] of this.stats.connections) {
      const msgPerSec = stats.messages / elapsed;
      console.log(
        `  Conn ${id}: ${stats.messages} msgs (${msgPerSec.toFixed(2)} msg/s)`,
      );
    }

    console.log(`Cache size: ${this.messageCache.size} messages`);
    console.log(`Ordering buffer: ${this.orderingBuffer.size} slots`);
    console.log(`====================================\n`);
  }

  cleanupCache() {
    const now = Date.now();
    const maxAge = 60000; // 1 minute

    // Clean up old entries from deduplication cache
    for (const [key, timestamp] of this.messageCache.entries()) {
      if (now - timestamp > maxAge) {
        this.messageCache.delete(key);
      }
    }

    // Keep cache size reasonable
    if (this.messageCache.size > this.config.deduplicationWindow * 2) {
      const entries = Array.from(this.messageCache.entries());
      entries.sort((a, b) => b[1] - a[1]); // Sort by timestamp, newest first

      // Keep only the newest entries
      this.messageCache.clear();
      for (let i = 0; i < this.config.deduplicationWindow; i++) {
        if (entries[i]) {
          this.messageCache.set(entries[i][0], entries[i][1]);
        }
      }
    }
  }

  // Event emitter interface
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
  }

  emit(event, data) {
    const handlers = this.eventHandlers.get(event) || [];
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in ${event} handler:`, error);
      }
    }
  }

  async close() {
    console.log("Shutting down multi-connection stream...");

    // Clear intervals
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);

    // Close all connections
    for (const connection of this.connections) {
      try {
        connection.stream.destroy();
      } catch (error) {
        console.error(`Error closing connection ${connection.id}:`, error);
      }
    }

    this.connections = [];
    this.messageCache.clear();
    this.orderingBuffer.clear();
  }
}

// Usage example
async function main() {
  const multiStream = new MultiThreadLaserStream({
    connections: 4, // Use 4 parallel connections
    deduplicationWindow: 5000,
    orderingBuffer: 500,
  });

  // Set up event handlers
  multiStream.on("data", (data) => {
    // Process each unique message here
    // console.log('Received message:', data);
  });

  multiStream.on("error", ({ connectionId, error }) => {
    console.error(`Connection ${connectionId} failed:`, error.message);
  });

  // Initialize and start
  await multiStream.initialize();

  // Graceful shutdown
  process.on("SIGINT", async () => {
    await multiStream.close();
    process.exit(0);
  });

  console.log("Multi-connection stream started! Press Ctrl+C to stop.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

module.exports = { MultiThreadLaserStream };

