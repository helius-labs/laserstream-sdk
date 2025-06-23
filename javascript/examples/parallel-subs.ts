import { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import * as grpc from "@triton-one/yellowstone-grpc";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

async function createSubscription(id: number) {
  const client = new grpc.default(
    "http://localhost:9443",
    "4c3081a5-78cd-4433-af8b-f62ae6dc937c",
    {
      "grpc.max_receive_message_length": 100 * 1024 * 1024, // 100MB
      "grpc-node.flow_control_window": 65 * 1024 * 1024, // 65MB
      "grpc.keepalive_time_ms": 30000,
      "grpc.max_concurrent_streams": 1000,
      "grpc-node.max_session_memory": 512 * 1024 * 1024, // 512MB
    },
  );

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

  return { id, stream, client };
}

async function main(): Promise<void> {
  const NUM_SUBSCRIPTIONS = 4; // Adjust based on CPU cores
  const subscriptions = [];

  console.log(`Creating ${NUM_SUBSCRIPTIONS} parallel subscriptions...`);

  // Create multiple subscriptions
  for (let i = 0; i < NUM_SUBSCRIPTIONS; i++) {
    subscriptions.push(await createSubscription(i));
  }

  console.log("All subscriptions created! Listening for updates…");

  // Shared counters
  let totalUpdateCount = 0;
  let totalBytes = 0;
  const startTime = Date.now();
  const subStats = new Map<number, { count: number; bytes: number }>();

  // Initialize stats for each subscription
  for (let i = 0; i < NUM_SUBSCRIPTIONS; i++) {
    subStats.set(i, { count: 0, bytes: 0 });
  }

  // Rate emission interval
  const rateInterval = setInterval(() => {
    const now = Date.now();
    const timeDiff = (now - startTime) / 1000;
    const messagesPerSecond = totalUpdateCount / timeDiff;
    const mbPerSecond = totalBytes / timeDiff / 1024 / 1024;

    console.log(`\n=== Performance Stats ===`);
    console.log(`Total messages/sec: ${messagesPerSecond.toFixed(2)}`);
    console.log(`Total MB/sec: ${mbPerSecond.toFixed(2)}`);
    console.log(`Total messages: ${totalUpdateCount}`);
    console.log(`Total data: ${formatBytes(totalBytes)}`);
    
    // Per-subscription stats
    console.log(`\nPer-subscription breakdown:`);
    for (const [id, stats] of subStats) {
      const subMsgPerSec = stats.count / timeDiff;
      console.log(`  Sub ${id}: ${stats.count} msgs (${subMsgPerSec.toFixed(2)} msg/s)`);
    }
    console.log(`========================\n`);
  }, 5000);

  // Set up handlers for each subscription
  for (const { id, stream } of subscriptions) {
    stream.on("data", (data: grpc.SubscribeUpdate) => {
      totalUpdateCount++;
      const stats = subStats.get(id)!;
      stats.count++;
      
      // Estimate size without re-encoding
      const estimatedSize = JSON.stringify(data).length;
      totalBytes += estimatedSize;
      stats.bytes += estimatedSize;
    });

    stream.on("error", (err: Error) => {
      console.error(`❌ Stream ${id} error:`, err.message);
    });

    stream.on("end", () => {
      console.log(`🔚 Stream ${id} ended`);
    });
  }

  // Cleanup on exit
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    clearInterval(rateInterval);
    process.exit(0);
  });
}

main().catch((error: Error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});