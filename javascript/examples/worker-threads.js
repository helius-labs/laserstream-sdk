const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("worker_threads");
const path = require("path");
const os = require("os");

// Worker thread code
if (!isMainThread) {
  const { CommitmentLevel } = require("@triton-one/yellowstone-grpc");
  const grpc = require("@triton-one/yellowstone-grpc");

  const workerId = workerData.id;
  const config = workerData.config;

  let messageCount = 0;
  let bytesProcessed = 0;
  let lastStatsTime = Date.now();

  let stream = null;

  // Handle shutdown message from main thread
  parentPort.on("message", (msg) => {
    if (msg.type === "shutdown") {
      console.log(`Worker ${workerId}: Received shutdown signal`);
      if (stream) {
        stream.destroy();
      }
      process.exit(0);
    }
  });

  async function workerMain() {
    console.log(`Worker ${workerId}: Starting connection...`);

    const client = new grpc.default(config.url, config.token, {
      "grpc.max_receive_message_length": 100 * 1024 * 1024, // 100MB
      "grpc-node.flow_control_window": 65 * 1024 * 1024, // 65MB
      "grpc.keepalive_time_ms": 30000,
      "grpc.max_concurrent_streams": 1000,
      "grpc-node.max_session_memory": 512 * 1024 * 1024, // 512MB per worker
    });

    stream = await client.subscribeOnce(
      // accounts
      {
        allAccounts: {
          account: ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"],
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
        // blocks: {
        //   includeAccounts: false,
        //   includeEntries: false,
        //   includeTransactions: false,
        //   accountInclude: [],
        // },
      },
      // blocksMeta
      {},
      // commitment
      CommitmentLevel.PROCESSED,
      // accountsDataSlice
      [],
    );

    stream.on("data", (data) => {
      messageCount++;

      // Extract key fields for deduplication in main thread
      let messageKey;
      let messageType;
      let slot = null;
      let estimatedSize = 0;

      if (data.transaction && data.transaction.signature) {
        messageKey = data.transaction.signature;
        messageType = "transaction";
        // Estimate: signature (88) + meta (500-2000) + instructions (500-5000)
        estimatedSize =
          2000 + (data.transaction.instructions?.length || 1) * 500;
      } else if (data.account && data.account.pubkey) {
        messageKey = `${data.account.pubkey}:${data.account.lamports}`;
        messageType = "account";
        // Estimate: pubkey (44) + account data size + metadata (~200)
        estimatedSize = 250 + (data.account.data?.length || 0);
      } else if (data.slot) {
        messageKey = `${data.slot.slot}:${data.slot.parent}`;
        messageType = "slot";
        slot = data.slot.slot;
        // Slots are small: slot number + parent + metadata
        estimatedSize = 100;
      } else if (data.block) {
        messageKey = `${data.block.slot}:${data.block.blockhash}`;
        messageType = "block";
        slot = data.block.slot;
        // Blocks can be large: header + transactions count * avg size
        estimatedSize = 500 + (data.block.transactions?.length || 0) * 1000;
      } else if (data.blockMeta) {
        messageKey = `${data.blockMeta.slot}:${data.blockMeta.blockhash}`;
        messageType = "blockMeta";
        slot = data.blockMeta.slot;
        // Block meta is medium sized
        estimatedSize = 1000;
      } else {
        messageKey = `${workerId}:${messageCount}`;
        messageType = "unknown";
        estimatedSize = 500; // Default estimate
      }

      bytesProcessed += estimatedSize;

      // Send only essential data to main thread - DO NOT send the full data object
      parentPort.postMessage({
        type: "message",
        workerId,
        messageKey,
        messageType,
        slot,
        size: estimatedSize,
      });

      // Send stats every 1000 messages
      if (messageCount % 1000 === 0) {
        const now = Date.now();
        const timeDiff = (now - lastStatsTime) / 1000;
        parentPort.postMessage({
          type: "stats",
          workerId,
          messageCount,
          bytesProcessed,
          messagesPerSecond: 1000 / timeDiff,
        });
        lastStatsTime = now;
      }
    });

    stream.on("error", (err) => {
      parentPort.postMessage({
        type: "error",
        workerId,
        error: err.message,
      });
    });

    stream.on("end", () => {
      parentPort.postMessage({
        type: "end",
        workerId,
      });
    });
  }

  workerMain().catch((error) => {
    parentPort.postMessage({
      type: "error",
      workerId,
      error: error.message,
    });
  });
}

// Main thread code
class WorkerThreadLaserStream {
  constructor(config = {}) {
    this.config = {
      workers: config.workers || os.cpus().length,
      deduplicationWindow: config.deduplicationWindow || 5000, // Reduced default
      orderingBuffer: config.orderingBuffer || 500, // Reduced default
      url: config.url || "http://localhost:9443",
      token: config.token || "4c3081a5-78cd-4433-af8b-f62ae6dc937c",
      ...config,
    };

    this.workers = [];
    this.messageCache = new Map(); // For deduplication
    this.orderingBuffer = new Map(); // For ordering by slot
    this.lastEmittedSlot = 0;
    this.stats = {
      total: { messages: 0, bytes: 0, duplicates: 0 },
      workers: new Map(),
    };
    this.startTime = Date.now();
    this.eventHandlers = new Map();
    this.isShuttingDown = false;
    this.workerRestartAttempts = new Map();
  }

  async initialize() {
    console.log(`Creating ${this.config.workers} worker threads...`);

    for (let i = 0; i < this.config.workers; i++) {
      await this.createWorker(i);
    }

    // Start periodic cleanup and stats
    this.startPeriodicTasks();
    console.log("All workers initialized!");
  }

  async createWorker(id) {
    if (this.isShuttingDown) {
      return;
    }

    const worker = new Worker(__filename, {
      workerData: {
        id,
        config: {
          url: this.config.url,
          token: this.config.token,
        },
      },
    });

    const workerInfo = {
      id,
      worker,
      stats: { messages: 0, bytes: 0, duplicates: 0 },
    };

    this.workers.push(workerInfo);
    this.stats.workers.set(id, workerInfo.stats);

    // Handle messages from worker
    worker.on("message", (msg) => this.handleWorkerMessage(msg));
    worker.on("error", (err) => this.handleWorkerError(id, err));
    worker.on("exit", (code) => this.handleWorkerExit(id, code));

    return workerInfo;
  }

  handleWorkerMessage(msg) {
    switch (msg.type) {
      case "message":
        this.processMessage(msg);
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

  processMessage(msg) {
    const { workerId, messageKey, messageType, slot, size } = msg;
    const workerInfo = this.workers.find((w) => w.id === workerId);

    // Update worker stats
    workerInfo.stats.messages++;
    workerInfo.stats.bytes += size;

    // Check for duplicates
    if (this.messageCache.has(messageKey)) {
      workerInfo.stats.duplicates++;
      this.stats.total.duplicates++;
      return;
    }

    // Add to deduplication cache
    this.messageCache.set(messageKey, Date.now());

    // Handle ordering for slot-based messages
    if (slot !== null && this.config.orderingBuffer > 0) {
      this.addToOrderingBuffer({ messageKey, messageType, slot }, size, slot);
      this.processOrderedMessages();
    } else {
      // Emit immediately for non-ordered messages
      this.emitMessage({ messageKey, messageType }, size);
    }
  }

  updateWorkerStats(msg) {
    const workerInfo = this.workers.find((w) => w.id === msg.workerId);
    if (workerInfo) {
      workerInfo.stats.messagesPerSecond = msg.messagesPerSecond;
      // Reset restart attempts on successful operation
      if (this.workerRestartAttempts.has(msg.workerId)) {
        this.workerRestartAttempts.set(msg.workerId, 0);
      }
    }
  }

  addToOrderingBuffer(data, size, slot) {
    if (!this.orderingBuffer.has(slot)) {
      this.orderingBuffer.set(slot, []);
    }
    this.orderingBuffer.get(slot).push({ data, size });

    // Hard limit on ordering buffer size to prevent unbounded growth
    if (this.orderingBuffer.size > this.config.orderingBuffer * 2) {
      // Remove oldest slots
      const sortedSlots = Array.from(this.orderingBuffer.keys()).sort(
        (a, b) => a - b,
      );
      const slotsToRemove = sortedSlots.slice(
        0,
        sortedSlots.length - this.config.orderingBuffer,
      );
      for (const oldSlot of slotsToRemove) {
        this.orderingBuffer.delete(oldSlot);
      }
    }
  }

  processOrderedMessages() {
    const sortedSlots = Array.from(this.orderingBuffer.keys()).sort(
      (a, b) => a - b,
    );

    for (const slot of sortedSlots) {
      if (slot <= this.lastEmittedSlot) {
        this.orderingBuffer.delete(slot);
        continue;
      }

      if (slot === this.lastEmittedSlot + 1 || this.lastEmittedSlot === 0) {
        const messages = this.orderingBuffer.get(slot);
        for (const { data, size } of messages) {
          this.emitMessage(data, size);
        }
        this.orderingBuffer.delete(slot);
        this.lastEmittedSlot = slot;
      } else {
        break;
      }
    }

    // Clean up old buffered messages
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
    this.stats.total.messages++;
    this.stats.total.bytes += size;
    // Include size in the emitted data
    this.emit("data", { ...data, size });
  }

  handleWorkerError(workerId, error) {
    console.error(`Worker ${workerId} crashed:`, error);
    this.emit("workerError", { workerId, error });

    if (this.isShuttingDown) {
      return;
    }

    // Check restart attempts
    const attempts = this.workerRestartAttempts.get(workerId) || 0;
    if (attempts >= 3) {
      console.error(
        `Worker ${workerId} has failed too many times, not restarting`,
      );
      return;
    }

    // Restart worker after delay
    setTimeout(() => {
      if (!this.isShuttingDown) {
        console.log(
          `Restarting worker ${workerId} (attempt ${attempts + 1}/3)...`,
        );
        this.restartWorker(workerId);
      }
    }, 5000);
  }

  handleWorkerExit(workerId, code) {
    if (this.isShuttingDown) {
      // Don't restart workers during shutdown
      return;
    }

    if (code !== 0) {
      console.error(`Worker ${workerId} exited with code ${code}`);

      // Check restart attempts
      const attempts = this.workerRestartAttempts.get(workerId) || 0;
      if (attempts >= 3) {
        console.error(
          `Worker ${workerId} has failed too many times, not restarting`,
        );
        return;
      }

      // Add delay before restart to prevent rapid restart loops
      setTimeout(() => {
        if (!this.isShuttingDown) {
          console.log(
            `Restarting worker ${workerId} (attempt ${attempts + 1}/3)...`,
          );
          this.restartWorker(workerId);
        }
      }, 5000);
    }
  }

  async restartWorker(workerId) {
    if (this.isShuttingDown) {
      return;
    }

    const index = this.workers.findIndex((w) => w.id === workerId);
    if (index !== -1) {
      // Remove old worker
      this.workers.splice(index, 1);

      // Increment restart attempts
      const attempts = this.workerRestartAttempts.get(workerId) || 0;
      this.workerRestartAttempts.set(workerId, attempts + 1);

      // Create new worker
      await this.createWorker(workerId);
    }
  }

  startPeriodicTasks() {
    // Stats reporting
    this.statsInterval = setInterval(() => {
      this.reportStats();
    }, 5000);

    // Cache cleanup - more frequent to prevent memory buildup
    this.cleanupInterval = setInterval(() => {
      this.cleanupCache();
    }, 10000); // Every 10 seconds instead of 30
  }

  reportStats() {
    const now = Date.now();
    const elapsed = (now - this.startTime) / 1000;
    const { total } = this.stats;

    console.log(`\n=== Worker Thread Performance ===`);
    console.log(`Workers: ${this.config.workers}`);
    console.log(
      `Total messages: ${total.messages} (${total.duplicates} duplicates filtered)`,
    );
    console.log(`Total data: ${this.formatBytes(total.bytes)}`);
    console.log(`Messages/sec: ${(total.messages / elapsed).toFixed(2)}`);
    console.log(`MB/sec: ${(total.bytes / elapsed / 1024 / 1024).toFixed(2)}`);

    console.log(`\nPer-worker breakdown:`);
    for (const [id, stats] of this.stats.workers) {
      const msgPerSec = stats.messagesPerSecond || stats.messages / elapsed;
      console.log(
        `  Worker ${id}: ${stats.messages} msgs (${msgPerSec.toFixed(2)} msg/s, ${stats.duplicates} dups)`,
      );
    }

    console.log(`Cache size: ${this.messageCache.size} messages`);
    console.log(`Ordering buffer: ${this.orderingBuffer.size} slots`);
    console.log(`=================================\n`);
  }

  cleanupCache() {
    const now = Date.now();
    const maxAge = 30000; // 30 seconds - more aggressive cleanup
    const maxCacheSize = Math.min(this.config.deduplicationWindow, 5000); // Hard limit at 5000

    // First pass: remove old entries
    for (const [key, timestamp] of this.messageCache.entries()) {
      if (now - timestamp > maxAge) {
        this.messageCache.delete(key);
      }
    }

    // Second pass: enforce hard size limit
    if (this.messageCache.size > maxCacheSize) {
      const entries = Array.from(this.messageCache.entries());
      entries.sort((a, b) => b[1] - a[1]); // Sort by timestamp, newest first

      this.messageCache.clear();
      // Keep only the most recent entries up to maxCacheSize
      for (let i = 0; i < maxCacheSize && i < entries.length; i++) {
        this.messageCache.set(entries[i][0], entries[i][1]);
      }
    }

    // Also cleanup ordering buffer if it's getting too large
    if (this.orderingBuffer.size > this.config.orderingBuffer) {
      const sortedSlots = Array.from(this.orderingBuffer.keys()).sort(
        (a, b) => a - b,
      );
      const slotsToKeep = this.config.orderingBuffer / 2; // Keep only half when cleaning
      const slotsToRemove = sortedSlots.slice(
        0,
        sortedSlots.length - slotsToKeep,
      );

      for (const slot of slotsToRemove) {
        this.orderingBuffer.delete(slot);
      }
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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
    console.log("Shutting down worker threads...");

    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);

    // Terminate all workers gracefully
    const terminationPromises = this.workers.map(async (workerInfo) => {
      try {
        // Skip if worker is already dead
        if (workerInfo.worker.threadId === -1) {
          return;
        }

        // Send shutdown message to worker
        workerInfo.worker.postMessage({ type: "shutdown" });

        // Give worker 2 seconds to clean up
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            resolve();
          }, 2000);

          // Check if already exited
          if (workerInfo.worker.threadId === -1) {
            clearTimeout(timeout);
            resolve();
            return;
          }

          workerInfo.worker.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        // Force terminate if still running
        if (workerInfo.worker.threadId !== -1) {
          await workerInfo.worker.terminate();
        }
      } catch (error) {
        console.error(`Error terminating worker ${workerInfo.id}:`, error);
      }
    });

    await Promise.all(terminationPromises);

    this.workers = [];
    this.messageCache.clear();
    this.orderingBuffer.clear();
  }
}

// Usage example
async function main() {
  // Check if another instance is already running
  const fs = require("fs");
  const lockFile = "/tmp/laserstream-worker-threads.lock";

  try {
    // Try to create lock file exclusively
    const fd = fs.openSync(lockFile, "wx");
    fs.writeSync(fd, process.pid.toString());
    fs.closeSync(fd);

    // Clean up lock file on exit
    const cleanup = () => {
      try {
        fs.unlinkSync(lockFile);
      } catch (e) {}
    };
    process.on("exit", cleanup);
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  } catch (err) {
    if (err.code === "EEXIST") {
      console.error("Another instance is already running!");
      process.exit(1);
    }
    throw err;
  }

  const workerStream = new WorkerThreadLaserStream({
    workers: Math.min(Infinity, os.cpus().length), // Max 4 workers to avoid overwhelming the system
    deduplicationWindow: 5000,
    orderingBuffer: 500,
  });

  // Stats for main thread consumption
  let mainThreadStats = {
    totalMessages: 0,
    totalBytes: 0,
    startTime: Date.now(),
    lastReportTime: Date.now(),
    lastMessageCount: 0,
  };

  // Set up event handlers
  workerStream.on("data", (data) => {
    // Process each unique message here
    mainThreadStats.totalMessages++;
    mainThreadStats.totalBytes += data.size || 500; // Use estimated size

    // Report every 10000 messages
    if (mainThreadStats.totalMessages % 10000 === 0) {
      const now = Date.now();
      const totalElapsed = (now - mainThreadStats.startTime) / 1000;
      const intervalElapsed = (now - mainThreadStats.lastReportTime) / 1000;
      const intervalMessages =
        mainThreadStats.totalMessages - mainThreadStats.lastMessageCount;

      console.log(`\n=== Main Thread Consumption Stats ===`);
      console.log(`Total consumed: ${mainThreadStats.totalMessages} messages`);
      console.log(
        `Total throughput: ${(mainThreadStats.totalMessages / totalElapsed).toFixed(2)} msg/s`,
      );
      console.log(
        `Interval throughput: ${(intervalMessages / intervalElapsed).toFixed(2)} msg/s`,
      );
      console.log(
        `Data rate: ${(mainThreadStats.totalBytes / totalElapsed / 1024 / 1024).toFixed(2)} MB/s`,
      );
      console.log(`=====================================\n`);

      mainThreadStats.lastReportTime = now;
      mainThreadStats.lastMessageCount = mainThreadStats.totalMessages;
    }
  });

  workerStream.on("error", ({ workerId, error }) => {
    console.error(`Worker ${workerId} stream error:`, error);
  });

  workerStream.on("workerError", ({ workerId, error }) => {
    console.error(`Worker ${workerId} crashed:`, error);
  });

  // Initialize and start
  await workerStream.initialize();

  // Graceful shutdown
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log("\n\nReceived SIGINT, shutting down gracefully...");

    // Print final stats
    const totalElapsed = (Date.now() - mainThreadStats.startTime) / 1000;
    console.log(`\n=== Final Main Thread Stats ===`);
    console.log(`Total consumed: ${mainThreadStats.totalMessages} messages`);
    console.log(
      `Average throughput: ${(mainThreadStats.totalMessages / totalElapsed).toFixed(2)} msg/s`,
    );
    console.log(
      `Total data: ${(mainThreadStats.totalBytes / 1024 / 1024).toFixed(2)} MB`,
    );
    console.log(
      `Average data rate: ${(mainThreadStats.totalBytes / totalElapsed / 1024 / 1024).toFixed(2)} MB/s`,
    );
    console.log(`===============================\n`);

    try {
      await workerStream.close();
      console.log("Shutdown complete.");
      process.exit(0);
    } catch (error) {
      console.error("Error during shutdown:", error);
      process.exit(1);
    }
  };

  // Remove existing listeners first to avoid duplicates
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("Worker thread stream started! Press Ctrl+C to stop.");
}

if (require.main === module && isMainThread) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

module.exports = { WorkerThreadLaserStream };
