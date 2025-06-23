// Test both the native module and JavaScript wrapper
const { helloWorld } = require("./laserstream-napi.node");
const LaserStream = require("./index.js");

console.log("🦀 LaserStream NAPI Module Test");
console.log("Hello:", helloWorld());

console.log("\nTesting JavaScript wrapper...");
try {
  const client = new LaserStream(
    "http://dev-morgan:9443",
    "76307907-092e-49da-b626-819c63fca112",
  );
  console.log("✅ LaserStream wrapper created successfully");
  console.log("Metrics:", client.getMetrics());

  client.subscribe({ slots: {} }, console.log);
} catch (error) {
  console.error("❌ LaserStream wrapper creation failed:", error.message);
}

console.log("Basic tests completed.");
