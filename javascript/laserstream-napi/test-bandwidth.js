const { helloWorld, LaserStreamClient } = require("./laserstream-napi.node");

let messageCount = 0;
let totalBytes = 0;
let startTime = 0;

async function runBandwidthTest() {
  console.log("🚀 NAPI + Tonic Real Bandwidth Testing");
  console.log("=".repeat(50));

  // Test 1: Basic functionality
  console.log("\n✅ Test 1: Basic NAPI Functions");
  console.log("Hello World:", helloWorld());

  // Test 2: Client initialization
  console.log("\n✅ Test 2: Client Initialization");
  const endpoint = process.env.ENDPOINT || "http://dev-morgan:9443";
  const token = process.env.TOKEN || "76307907-092e-49da-b626-819c63fca112";

  const client = new LaserStreamClient(endpoint, token);

  // Test 3: Real bandwidth test with subscribe
  console.log("\n✅ Test 3: Real Subscribe Bandwidth Test");
  console.log("Starting subscription for 10 seconds...");

  messageCount = 0;
  totalBytes = 0;
  startTime = Date.now();

  try {
    // Subscribe to account updates
    const stream = await client.subscribe(
      {
        accounts: {},
        // transactions: {},
      },
      onMessage,
    );

    console.log("Stream started, collecting data...");

    // Let it run for 10 seconds
    await new Promise((resolve) => setTimeout(resolve, 20000));

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

// const { helloWorld, LaserStreamClient } = require("./laserstream-napi.node");
//
// let messageCount = 0;
// let totalBytes = 0;
// let startTime = Date.now();
// let batchStartTime = Date.now();
// let batchMessageCount = 0;
// let batchBytes = 0;
// let activeStream = null;
//
// async function runBandwidthTest() {
//   console.log("🚀 NAPI + Tonic Continuous Bandwidth Testing");
//   console.log("=".repeat(50));
//
//   const endpoint = process.env.ENDPOINT || "http://dev-morgan:9443";
//   const token = process.env.TOKEN || "76307907-092e-49da-b626-819c63fca112";
//
//   const client = new LaserStreamClient(endpoint, token);
//   console.log("✅ Client initialized, starting continuous stream...");
//
//   try {
//     // Subscribe to account updates
//     const stream = await client.subscribe(
//       {
//         accounts: {}, // Subscribe to all account updates
//       },
//       onMessage,
//     );
//
//     console.log("📡 Stream started, collecting data continuously...");
//     console.log("Stream ID:", stream.id);
//     console.log("Press Ctrl+C to stop");
//
//     // Keep the stream handle alive
//     activeStream = stream;
//
//     // Set up graceful shutdown
//     process.on("SIGINT", () => {
//       console.log("\n\n🛑 Shutting down...");
//       if (global.activeStream) {
//         global.activeStream.cancel();
//       }
//       process.exit(0);
//     });
//
//     // Keep running until interrupted
//     await new Promise(() => {}); // Never resolves - runs forever
//   } catch (error) {
//     console.error("Bandwidth test failed:", error);
//   }
// }
//
// function onMessage(buffer) {
//   console.log(`📥 Received message of size ${buffer.length} bytes`);
//   console.log(activeStream);
//   messageCount++;
//   totalBytes += buffer.length;
//   batchMessageCount++;
//   batchBytes += buffer.length;
//
//   // Log progress every 5000 messages for real-time feedback
//   if (messageCount % 5000 === 0) {
//     printBatchStats();
//     const elapsed = (Date.now() - startTime) / 1000;
//     const rate = messageCount / elapsed;
//     process.stdout.write(
//       `\r📊 Messages: ${messageCount.toLocaleString()}, Rate: ${rate.toFixed(0)}/sec`,
//     );
//   }
// }
//
// function printBatchStats() {
//   const now = Date.now();
//   const batchDuration = (now - batchStartTime) / 1000;
//   const totalDuration = (now - startTime) / 1000;
//
//   // Batch stats
//   const batchRate = batchMessageCount / batchDuration;
//   const batchBytesPerSec = batchBytes / batchDuration;
//   const batchMbps = (batchBytesPerSec * 8) / (1024 * 1024);
//
//   // Total stats
//   const totalRate = messageCount / totalDuration;
//   const totalBytesPerSec = totalBytes / totalDuration;
//   const totalMbps = (totalBytesPerSec * 8) / (1024 * 1024);
//
//   console.log("\n" + "=".repeat(60));
//   console.log(`📊 BATCH STATS (last ${batchDuration.toFixed(1)}s):`);
//   console.log(
//     `  Messages:    ${batchMessageCount.toLocaleString()} (${batchRate.toFixed(0)}/sec)`,
//   );
//   console.log(
//     `  Data:        ${(batchBytes / 1024 / 1024).toFixed(2)} MB (${(batchBytesPerSec / 1024 / 1024).toFixed(2)} MB/sec)`,
//   );
//   console.log(`  Bandwidth:   ${batchMbps.toFixed(2)} Mbps`);
//
//   console.log(`\n🌍 TOTAL STATS (${totalDuration.toFixed(0)}s):`);
//   console.log(
//     `  Messages:    ${messageCount.toLocaleString()} (${totalRate.toFixed(0)}/sec avg)`,
//   );
//   console.log(
//     `  Data:        ${(totalBytes / 1024 / 1024).toFixed(2)} MB (${(totalBytesPerSec / 1024 / 1024).toFixed(2)} MB/sec avg)`,
//   );
//   console.log(`  Bandwidth:   ${totalMbps.toFixed(2)} Mbps avg`);
//
//   // Performance indicator
//   let indicator = "🔴 LOW";
//   if (batchMbps > 1000) indicator = "🟢 EXCELLENT";
//   else if (batchMbps > 100) indicator = "🟡 GOOD";
//   else if (batchMbps > 10) indicator = "🟠 OK";
//
//   console.log(`  Performance: ${indicator} (${batchMbps.toFixed(0)} Mbps)`);
//   console.log("=".repeat(60));
//
//   // Reset batch counters
//   batchStartTime = now;
//   batchMessageCount = 0;
//   batchBytes = 0;
// }
//
// runBandwidthTest().catch(console.error);
