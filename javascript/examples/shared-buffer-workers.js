const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("worker_threads");
const os = require("os");

// Constants for shared buffer management
const BUFFER_SIZE = 1000 * 1024 * 1024; // 100MB shared buffer
const HEADER_SIZE = 16; // 4 bytes each for: offset, size, type, worker_id
const MAX_MESSAGE_SIZE = 1 * 1024 * 1024; // 1MB max per message

// Worker thread code
if (!isMainThread) {
  const { CommitmentLevel } = require("@triton-one/yellowstone-grpc");
  const grpc = require("@triton-one/yellowstone-grpc");

  const workerId = workerData.id;
  const config = workerData.config;
  const sharedBuffer = workerData.sharedBuffer;
  const metadataBuffer = workerData.metadataBuffer;

  // Create views for the shared buffers
  const dataView = new Uint8Array(sharedBuffer);
  const metadataView = new Int32Array(metadataBuffer);

  // Worker's write position in the ring buffer
  let writeOffset = workerId * (BUFFER_SIZE / workerData.totalWorkers);
  const maxOffset = (workerId + 1) * (BUFFER_SIZE / workerData.totalWorkers);

  let messageCount = 0;
  let batchBuffer = [];
  let batchSize = 0;
  const BATCH_SIZE = 100; // Send metadata every 100 messages

  async function workerMain() {
    console.log(
      `Worker ${workerId}: Starting connection with buffer range ${writeOffset}-${maxOffset}`,
    );

    const client = new grpc.default(config.url, config.token, {
      "grpc.max_receive_message_length": 100 * 1024 * 1024, // 100MB
      "grpc-node.flow_control_window": 65 * 1024 * 1024, // 65MB
      "grpc.keepalive_time_ms": 30000,
      "grpc.max_concurrent_streams": 1000,
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
      {},
      // blocksMeta
      {},
      // commitment
      CommitmentLevel.PROCESSED,
      // accountsDataSlice
      [],
    );

    stream.on("data", (data) => {
      messageCount++;

      try {
        let encoded;
        let messageType = 0;

        if (data._isRaw) {
          // Use raw bytes directly - no decoding!
          encoded = data._rawBytes;
          messageType = data._messageType;
        } else {
          // Fallback to encoding (shouldn't happen with modified gRPC)
          encoded = grpc.SubscribeUpdate.encode(data).finish();
          // Extract message type from decoded object
          if (data.transaction) messageType = 1;
          else if (data.account) messageType = 2;
          else if (data.slot) messageType = 3;
          else if (data.block || data.blockMeta) messageType = 4;
        }

        const messageSize = encoded.length;

        // Check if we have space in our buffer section
        if (writeOffset + messageSize > maxOffset) {
          // Wrap around to start of our section
          writeOffset = workerId * (BUFFER_SIZE / workerData.totalWorkers);
        }

        // Write data to shared buffer
        dataView.set(encoded, writeOffset);

        // Add to batch
        batchBuffer.push({
          offset: writeOffset,
          size: messageSize,
          type: messageType,
          workerId: workerId,
        });

        writeOffset += messageSize;
        batchSize++;

        // Send batch when full
        if (batchSize >= BATCH_SIZE) {
          sendBatch();
        }
      } catch (error) {
        console.error(`Worker ${workerId}: Error processing message:`, error);
      }
    });

    stream.on("error", (err) => {
      sendBatch(); // Flush any pending messages
      parentPort.postMessage({
        type: "error",
        workerId,
        error: err.message,
      });
    });

    stream.on("end", () => {
      sendBatch(); // Flush any pending messages
      parentPort.postMessage({
        type: "end",
        workerId,
      });
    });
  }

  function sendBatch() {
    if (batchBuffer.length === 0) return;

    parentPort.postMessage({
      type: "batch",
      workerId,
      messages: batchBuffer,
      count: batchBuffer.length,
    });

    batchBuffer = [];
    batchSize = 0;
  }

  // Send stats periodically
  setInterval(() => {
    sendBatch(); // Flush any pending messages
    parentPort.postMessage({
      type: "stats",
      workerId,
      messageCount,
      writeOffset,
    });
  }, 5000);

  workerMain().catch((error) => {
    parentPort.postMessage({
      type: "error",
      workerId,
      error: error.message,
    });
  });
}

// Main thread code
class SharedBufferLaserStream {
  constructor(config = {}) {
    this.config = {
      workers: config.workers || Math.min(4, os.cpus().length),
      url: config.url || "http://localhost:9443",
      token: config.token || "4c3081a5-78cd-4433-af8b-f62ae6dc937c",
      ...config,
    };

    // Create shared buffers
    this.sharedBuffer = new SharedArrayBuffer(BUFFER_SIZE);
    this.metadataBuffer = new SharedArrayBuffer(1024 * 1024); // 1MB for metadata

    // Create views
    this.dataView = new Uint8Array(this.sharedBuffer);
    this.metadataView = new Int32Array(this.metadataBuffer);

    this.workers = [];
    this.stats = {
      total: { messages: 0, bytes: 0, batches: 0 },
      workers: new Map(),
    };
    this.startTime = Date.now();
    this.eventHandlers = new Map();
    this.isShuttingDown = false;

    // Deduplication cache (only store keys, not full data)
    this.messageCache = new Set();
  }

  async initialize() {
    console.log(
      `Creating ${this.config.workers} workers with ${BUFFER_SIZE / 1024 / 1024}MB shared buffer...`,
    );

    for (let i = 0; i < this.config.workers; i++) {
      await this.createWorker(i);
    }

    this.startPeriodicTasks();
    console.log("All workers initialized with shared buffer!");
  }

  async createWorker(id) {
    if (this.isShuttingDown) return;

    const worker = new Worker(__filename, {
      workerData: {
        id,
        config: {
          url: this.config.url,
          token: this.config.token,
        },
        sharedBuffer: this.sharedBuffer,
        metadataBuffer: this.metadataBuffer,
        totalWorkers: this.config.workers,
      },
    });

    const workerInfo = {
      id,
      worker,
      stats: { messages: 0, bytes: 0, batches: 0 },
    };

    this.workers.push(workerInfo);
    this.stats.workers.set(id, workerInfo.stats);

    worker.on("message", (msg) => this.handleWorkerMessage(msg));
    worker.on("error", (err) => this.handleWorkerError(id, err));
    worker.on("exit", (code) => this.handleWorkerExit(id, code));

    return workerInfo;
  }

  handleWorkerMessage(msg) {
    switch (msg.type) {
      case "batch":
        this.processBatch(msg);
        break;
      case "stats":
        this.updateWorkerStats(msg);
        break;
      case "error":
        console.error(`Worker ${msg.workerId} error:`, msg.error);
        this.emit("error", { workerId: msg.workerId, error: msg.error });
        break;
      case "end":
        console.log(`Worker ${msg.workerId} stream ended`);
        this.emit("end", { workerId: msg.workerId });
        break;
    }
  }

  processBatch(msg) {
    const { workerId, messages, count } = msg;
    const workerInfo = this.workers.find((w) => w.id === workerId);

    workerInfo.stats.batches++;
    this.stats.total.batches++;

    // Process messages from shared buffer
    let processedCount = 0;
    let totalBytes = 0;

    for (const msgInfo of messages) {
      const { offset, size, type } = msgInfo;

      // Create a unique key for deduplication (simplified)
      const messageKey = `${type}:${offset}:${size}`;

      if (this.messageCache.has(messageKey)) {
        continue; // Skip duplicate
      }

      this.messageCache.add(messageKey);

      // Read data from shared buffer if needed
      // For now, we just emit the metadata
      this.emit("data", {
        type,
        size,
        workerId,
        offset,
      });

      processedCount++;
      totalBytes += size;
    }

    // Update stats
    workerInfo.stats.messages += processedCount;
    workerInfo.stats.bytes += totalBytes;
    this.stats.total.messages += processedCount;
    this.stats.total.bytes += totalBytes;
  }

  updateWorkerStats(msg) {
    const workerInfo = this.workers.find((w) => w.id === msg.workerId);
    if (workerInfo) {
      workerInfo.stats.lastMessageCount = msg.messageCount;
      workerInfo.stats.lastWriteOffset = msg.writeOffset;
    }
  }

  handleWorkerError(workerId, error) {
    console.error(`Worker ${workerId} crashed:`, error);
    this.emit("workerError", { workerId, error });
  }

  handleWorkerExit(workerId, code) {
    if (this.isShuttingDown) return;

    if (code !== 0) {
      console.error(`Worker ${workerId} exited with code ${code}`);
    }
  }

  startPeriodicTasks() {
    this.statsInterval = setInterval(() => {
      this.reportStats();
    }, 5000);

    this.cleanupInterval = setInterval(() => {
      this.cleanupCache();
    }, 30000);
  }

  reportStats() {
    const now = Date.now();
    const elapsed = (now - this.startTime) / 1000;
    const { total } = this.stats;

    console.log(`\n=== Shared Buffer Performance ===`);
    console.log(`Workers: ${this.config.workers}`);
    console.log(`Total messages: ${total.messages}`);
    console.log(`Total batches: ${total.batches}`);
    console.log(`Total data: ${(total.bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Messages/sec: ${(total.messages / elapsed).toFixed(2)}`);
    console.log(`MB/sec: ${(total.bytes / elapsed / 1024 / 1024).toFixed(2)}`);
    console.log(
      `Avg batch size: ${(total.messages / (total.batches || 1)).toFixed(1)}`,
    );

    console.log(`\nPer-worker breakdown:`);
    for (const [id, stats] of this.stats.workers) {
      const msgPerSec = stats.messages / elapsed;
      console.log(
        `  Worker ${id}: ${stats.messages} msgs (${msgPerSec.toFixed(2)} msg/s), ${stats.batches} batches`,
      );
    }

    console.log(`Cache size: ${this.messageCache.size} messages`);
    console.log(`=================================\n`);
  }

  cleanupCache() {
    // Keep cache size under control
    if (this.messageCache.size > 50000) {
      this.messageCache.clear();
    }
  }

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
    this.isShuttingDown = true;
    console.log("Shutting down shared buffer workers...");

    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);

    // Terminate all workers
    const terminationPromises = this.workers.map(async (workerInfo) => {
      try {
        await workerInfo.worker.terminate();
      } catch (error) {
        console.error(`Error terminating worker ${workerInfo.id}:`, error);
      }
    });

    await Promise.all(terminationPromises);

    this.workers = [];
    this.messageCache.clear();
  }
}

// Usage example
async function main() {
  const sharedStream = new SharedBufferLaserStream({
    workers: 32,
  });

  // Stats for main thread consumption
  let mainThreadStats = {
    totalMessages: 0,
    totalBytes: 0,
    startTime: Date.now(),
  };

  sharedStream.on("data", (data) => {
    mainThreadStats.totalMessages++;
    mainThreadStats.totalBytes += data.size || 0;

    // Report every 50k messages
    if (mainThreadStats.totalMessages % 50000 === 0) {
      const elapsed = (Date.now() - mainThreadStats.startTime) / 1000;
      console.log(`\n=== Main Thread Zero-Copy Stats ===`);
      console.log(`Consumed: ${mainThreadStats.totalMessages} messages`);
      console.log(
        `Throughput: ${(mainThreadStats.totalMessages / elapsed).toFixed(2)} msg/s`,
      );
      console.log(
        `Data rate: ${(mainThreadStats.totalBytes / elapsed / 1024 / 1024).toFixed(2)} MB/s`,
      );
      console.log(`===================================\n`);
    }
  });

  await sharedStream.initialize();

  // Graceful shutdown
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log("\n\nShutting down...");

    const elapsed = (Date.now() - mainThreadStats.startTime) / 1000;
    console.log(`\n=== Final Stats ===`);
    console.log(`Total messages: ${mainThreadStats.totalMessages}`);
    console.log(
      `Average throughput: ${(mainThreadStats.totalMessages / elapsed).toFixed(2)} msg/s`,
    );
    console.log(
      `Average data rate: ${(mainThreadStats.totalBytes / elapsed / 1024 / 1024).toFixed(2)} MB/s`,
    );
    console.log(`===================\n`);

    await sharedStream.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("Shared buffer stream started! Press Ctrl+C to stop.");
}

if (require.main === module && isMainThread) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

module.exports = { SharedBufferLaserStream };
