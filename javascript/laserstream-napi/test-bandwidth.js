const { helloWorld, LaserStreamClient } = require("./laserstream-napi.node");
const { Connection, clusterApiUrl } = require("@solana/web3.js");
const protobuf = require("protobufjs");

let messageCount = 0;
let totalBytes = 0;
let startTime = 0;
let messageStats = {
  account: 0,
  slot: 0,
  transaction: 0,
  block: 0,
  ping: 0,
  other: 0,
};

// Load protobuf definitions
let SubscribeUpdate = null;

async function loadProto() {
  const root = await protobuf.load("proto/geyser.proto");
  SubscribeUpdate = root.lookupType("geyser.SubscribeUpdate");
}

async function getLatestSlot() {
  const rpcUrl =
    process.env.SOLANA_RPC_URL ||
    "https://mainnet.helius-rpc.com?api-key=76307907-092e-49da-b626-819c63fca112";
  const connection = new Connection(rpcUrl);

  try {
    const slot = await connection.getSlot();
    console.log(`🎯 Latest Solana slot: ${slot}`);
    return slot;
  } catch (error) {
    console.error("Failed to fetch latest slot:", error.message);
    return null;
  }
}

async function runBandwidthTest() {
  console.log("🚀 NAPI + Tonic Real Bandwidth Testing");
  console.log("=".repeat(50));

  console.log("\n📋 Loading protobuf definitions...");
  await loadProto();

  console.log("\n🔍 Fetching latest Solana slot...");
  const slot = await getLatestSlot();

  const endpoint = process.env.ENDPOINT || "http://dev-morgan:9443";
  const token = process.env.TOKEN || "76307907-092e-49da-b626-819c63fca112";

  const client = new LaserStreamClient(endpoint, token);

  const testDurationSeconds = 10;

  // Test 3: Real bandwidth test with subscribe
  console.log("\n✅ Test 3: Real Subscribe Bandwidth Test");
  console.log(`Starting subscription for ${testDurationSeconds} seconds...`);

  messageCount = 0;
  totalBytes = 0;
  startTime = Date.now();

  try {
    // Subscribe to account updates with slot filter if available
    const subscribeRequest = {
      accounts: {},
      // transactions: {},
      from_slot: slot - 450,
    };

    const stream = await client.subscribe(subscribeRequest, onMessage);

    console.log("Stream started, collecting data...");

    // Let it run for 10 seconds
    await new Promise((resolve) =>
      setTimeout(resolve, testDurationSeconds * 1000),
    );

    // Stop the stream
    stream.cancel();

    // Calculate metrics
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    const messagesPerSec = messageCount / duration;
    const bytesPerSec = totalBytes / duration;
    const mbps = (bytesPerSec * 8) / (1024 * 1024);

    console.log("\n📊 Real Bandwidth Results:");
    console.log(`Duration:       ${duration.toFixed(2)}s`);
    console.log(`Messages:       ${messageCount.toLocaleString()}`);
    console.log(`Data:           ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Messages/sec:   ${messagesPerSec.toFixed(0)}`);
    console.log(`MB/sec:         ${(bytesPerSec / 1024 / 1024).toFixed(2)}`);
    console.log(`Bandwidth:      ${mbps.toFixed(2)} Mbps`);

    console.log("\n📋 Message Type Breakdown:");
    console.log(`Account updates: ${messageStats.account.toLocaleString()}`);
    console.log(`Slot updates:    ${messageStats.slot.toLocaleString()}`);
    console.log(
      `Transactions:    ${messageStats.transaction.toLocaleString()}`,
    );
    console.log(`Blocks:          ${messageStats.block.toLocaleString()}`);
    console.log(`Pings:           ${messageStats.ping.toLocaleString()}`);
    console.log(`Other:           ${messageStats.other.toLocaleString()}`);

    // Performance assessment
    console.log("\n🏆 Performance Assessment:");
    if (mbps > 1000) {
      console.log("🟢 EXCELLENT: >1 Gbps throughput capability");
    } else if (mbps > 100) {
      console.log("🟡 GOOD: >100 Mbps throughput capability");
    } else if (mbps > 10) {
      console.log("🟠 OK: >10 Mbps throughput capability");
    } else {
      console.log("🔴 LOW: <10 Mbps throughput");
    }

    // Show stream metrics if available
    try {
      const streamMetrics = stream.getMetrics();
      console.log("\n📈 Stream Metrics:");
      console.log(`Batches processed: ${streamMetrics.batchesProcessed}`);
      console.log(`Avg batch size: ${streamMetrics.avgBatchSize.toFixed(1)}`);
      console.log(`Avg latency: ${streamMetrics.avgLatencyMs.toFixed(2)}ms`);
    } catch (e) {
      console.log("Stream metrics not available");
    }

    // Show global metrics if available
    try {
      const globalMetrics = client.getMetrics();
      console.log("\n🌍 Global Metrics:");
      console.log(`Active streams: ${globalMetrics.activeStreams}`);
      console.log(`Total messages: ${globalMetrics.totalMessages}`);
    } catch (e) {
      console.log("Global metrics not available");
    }
  } catch (error) {
    console.error("Bandwidth test failed:", error);
  }

  console.log("\n✨ Bandwidth Test Complete!");
}

function onMessage(buffer) {
  messageCount++;
  totalBytes += buffer.length;

  // Parse the protobuf message
  try {
    const message = SubscribeUpdate.decode(buffer);

    if (message.account) {
      messageStats.account++;
    } else if (message.slot) {
      messageStats.slot++;
    } else if (message.transaction) {
      messageStats.transaction++;
    } else if (message.block) {
      messageStats.block++;
    } else if (message.ping) {
      messageStats.ping++;
    } else {
      messageStats.other++;
    }
  } catch (error) {
    messageStats.other++;
    console.error(`\n❌ Failed to parse message: ${error.message}`);
  }

  // Log progress every 1000 messages
  if (messageCount % 1000 === 0) {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = messageCount / elapsed;
    process.stdout.write(
      `\r📊 Messages: ${messageCount.toLocaleString()}, Rate: ${rate.toFixed(0)}/sec`,
    );
  }
}

runBandwidthTest().catch(console.error);
