import { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import * as grpc from "@triton-one/yellowstone-grpc";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

async function main(): Promise<void> {
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

  //   export interface SubscribeRequestFilterTransactions {
  //     vote?: boolean | undefined;
  //     failed?: boolean | undefined;
  //     signature?: string | undefined;
  //     accountInclude: string[];
  //     accountExclude: string[];
  //     accountRequired: string[];
  // }

  // Call subscribeOnce with all 9 required arguments
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

  console.log("Subscribed! Listening for account updates…");

  let updateCount: number = 0;
  let totalBytes = 0;
  let startTime = Date.now();
  let lastRateTime = Date.now();
  let lastUpdateCount = 0;

  // Emit rate every 5 seconds
  const rateInterval = setInterval(() => {
    const now = Date.now();
    const timeDiff = (now - lastRateTime) / 1000;
    const messagesDiff = updateCount - lastUpdateCount;
    const messagesPerSecond = messagesDiff / timeDiff;

    console.log(`Messages/sec: ${messagesPerSecond.toFixed(2)}`);

    lastRateTime = now;
    lastUpdateCount = updateCount;
  }, 5000);

  stream.on("data", (data: grpc.SubscribeUpdate) => {
    updateCount++;
    
    // Estimate size without re-encoding (much faster)
    // This is a rough estimate based on typical message sizes
    const estimatedSize = JSON.stringify(data).length;
    totalBytes += estimatedSize;

    if (updateCount % 10000 === 0) {
      console.log(`Total messages: ${updateCount}`);
      console.log(`Total bytes (estimated): ${formatBytes(totalBytes)}`);
      let timeTaken = (Date.now() - startTime) / 1000;
      console.log(`Time taken: ${timeTaken}s`);
      console.log(
        `Bytes per second: ${totalBytes / timeTaken / 1024 / 1024} MB/s`,
      );
      console.log(
        `Average messages per second: ${(updateCount / timeTaken).toFixed(2)}`,
      );
    }
  });

  stream.on("error", (err: Error) => {
    console.error("❌ Stream error:", err.message);
    clearInterval(rateInterval);
  });

  stream.on("end", () => {
    console.log("🔚 Stream ended");
    clearInterval(rateInterval);
  });
}

main().catch((error: Error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

