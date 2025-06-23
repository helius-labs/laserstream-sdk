// Native gRPC implementation
// Requires: npm install grpc @grpc/proto-loader

const grpc = require("grpc"); // Native C++ implementation
const protoLoader = require("@grpc/proto-loader");
const path = require("path");

// Load proto from proto folder
const PROTO_PATH = path.join(__dirname, "proto", "geyser.proto");

// Load proto with native grpc optimizations
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  // Native optimizations
  bytesAsBase64: true,
  arrays: true,
});

const geyserProto = grpc.loadPackageDefinition(packageDefinition).geyser;

// Load the proto for encoding
let SubscribeUpdateType = null;
let protoRoot = null;

// Since we're using grpc with proto-loader, we can access the message constructors
// from the loaded package definition to get encoding capabilities
let messageTypes = null;

// Extract message types from the loaded proto
function extractMessageTypes() {
  try {
    // The packageDefinition contains the proto descriptors
    // We can use these to understand the message structure
    messageTypes = packageDefinition.geyser;
  } catch (err) {
    console.error("Failed to extract message types:", err);
  }
}

extractMessageTypes();

// Calculate message size using protobuf encoding estimation
function calculateMessageSize(data) {
  // Use a more accurate estimation based on protobuf encoding rules
  let size = 0;
  
  // Protobuf encoding overhead for the message wrapper
  size += 10; // message tag and length prefix
  
  // Filters field (repeated string)
  if (data.filters && Array.isArray(data.filters)) {
    data.filters.forEach(filter => {
      size += 1; // field tag
      size += varIntSize(Buffer.byteLength(filter)); // length prefix
      size += Buffer.byteLength(filter); // string data
    });
  }
  
  // Oneof field - only one will be present
  if (data.account) {
    size += 1; // field tag for account (field 2)
    const accountSize = estimateAccountSize(data.account);
    size += varIntSize(accountSize); // length prefix
    size += accountSize;
  } else if (data.slot) {
    size += 1; // field tag for slot (field 3)
    size += varIntSize(20); // estimated slot message size
    size += 20;
  } else if (data.transaction) {
    size += 1; // field tag for transaction (field 4)
    const txSize = estimateTransactionSize(data.transaction);
    size += varIntSize(txSize);
    size += txSize;
  } else if (data.block) {
    size += 1; // field tag for block (field 5)
    const blockSize = Buffer.byteLength(JSON.stringify(data.block));
    size += varIntSize(blockSize);
    size += blockSize;
  } else if (data.blockMeta) {
    size += 1; // field tag for blockMeta (field 7)
    const metaSize = Buffer.byteLength(JSON.stringify(data.blockMeta));
    size += varIntSize(metaSize);
    size += metaSize;
  }
  
  // Timestamp field
  if (data.created_at) {
    size += 1; // field tag
    size += 12; // timestamp encoding
  }
  
  return size;
}

// Calculate variable-length integer size
function varIntSize(value) {
  if (value < 128) return 1;
  if (value < 16384) return 2;
  if (value < 2097152) return 3;
  if (value < 268435456) return 4;
  return 5;
}

// Estimate account message size
function estimateAccountSize(account) {
  let size = 0;
  if (account.account) {
    const acc = account.account;
    if (acc.data) {
      size += 1 + varIntSize(acc.data.length) + acc.data.length;
    }
    if (acc.owner) size += 1 + 32; // 32 bytes for pubkey
    if (acc.lamports) size += 1 + 8; // uint64
    if (acc.executable !== undefined) size += 2; // bool
    if (acc.rentEpoch) size += 1 + 8; // uint64
  }
  if (account.slot) size += 1 + 8; // uint64
  if (account.isStartup !== undefined) size += 2; // bool
  return size + 50; // padding for other fields
}

// Estimate transaction message size
function estimateTransactionSize(transaction) {
  let size = 0;
  if (transaction.transaction) {
    const tx = transaction.transaction;
    if (tx.signature) size += 1 + 64; // signature
    if (tx.transaction) {
      size += Buffer.byteLength(JSON.stringify(tx.transaction)) * 0.8; // protobuf is more efficient
    }
    if (tx.meta) {
      size += Buffer.byteLength(JSON.stringify(tx.meta)) * 0.8;
    }
  }
  if (transaction.slot) size += 1 + 8; // uint64
  return size + 100; // padding
}

class NativeGrpcClient {
  constructor(endpoint, token, channelOptions = {}) {
    const url = new URL(endpoint);
    const address = `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;

    // Create credentials
    let creds;
    if (url.protocol === "https:") {
      creds = grpc.credentials.createSsl();
    } else {
      creds = grpc.credentials.createInsecure();
    }

    // Native grpc channel options for maximum performance
    const options = {
      "grpc.max_receive_message_length": 100 * 1024 * 1024, // 100MB
      "grpc.max_send_message_length": 10 * 1024 * 1024, // 10MB
      "grpc.keepalive_time_ms": 30000,
      "grpc.keepalive_timeout_ms": 10000,
      "grpc.keepalive_permit_without_calls": 1,
      "grpc.http2.max_concurrent_streams": 1000,
      // Native specific optimizations
      "grpc.max_connection_age_ms": -1, // No connection cycling
      "grpc.tcp_nodelay": 1, // Disable Nagle's algorithm for lower latency
      "grpc.so_reuseport": 1, // Allow port reuse
      "grpc.use_local_subchannel_pool": 1,
      "grpc.channel_ready_backoff_ms": 100,
      "grpc.http2.min_time_between_pings_ms": 10000,
      "grpc.http2.max_pings_without_data": 0,
      // Memory optimizations
      "grpc.resource_allocation_strategy": 2, // Optimize for throughput
      ...channelOptions,
    };

    // Create client
    this.client = new geyserProto.Geyser(address, creds, options);

    // Store metadata for requests
    this.metadata = new grpc.Metadata();
    if (token) {
      this.metadata.add("x-token", token);
    }
  }

  async subscribe(request) {
    // Create the bidirectional stream
    const call = this.client.Subscribe(this.metadata);

    // Send subscription request
    call.write(request);

    return call;
  }

  // Convenience method for yellowstone-grpc compatibility
  async subscribeOnce(
    accounts = {},
    slots = {},
    transactions = {},
    transactionsStatus = {},
    entry = {},
    blocks = {},
    blocksMeta = {},
    commitment = 0,
    accountsDataSlice = [],
  ) {
    const request = {
      accounts,
      slots,
      transactions,
      transactionsStatus,
      entry,
      blocks,
      blocksMeta,
      commitment,
      accountsDataSlice,
    };

    return this.subscribe(request);
  }
}

// Example usage
async function main() {
  console.log("Starting native gRPC client...\n");

  const client = new NativeGrpcClient(
    "http://localhost:9443",
    "4c3081a5-78cd-4433-af8b-f62ae6dc937c",
  );

  let request = [
    // accounts
    {
      all: {
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
      // all: {
      //   accountInclude: [],
      //   accountExclude: [],
      //   accountRequired: [],
      // },
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
    0, // PROCESSED
    // accountsDataSlice
    [],
  ];

  console.log("Subscribing to geyser stream with request:", request);

  const stream = await client.subscribeOnce(...request);

  let messageCount = 0;
  let totalBytes = 0;
  const startTime = Date.now();
  let lastReport = Date.now();
  let lastMessageCount = 0;

  stream.on("data", (data) => {
    messageCount++;

    let messageSize = 0;
    let messageType = "unknown";

    // Determine message type from parsed data
    if (data.account) {
      messageType = "account";
    } else if (data.transaction) {
      messageType = "transaction";
    } else if (data.slot) {
      messageType = "slot";
    } else if (data.block || data.blockMeta) {
      messageType = "block";
    }

    // Calculate approximate size of the protobuf message
    // Since we don't have raw bytes anymore, estimate based on the data content
    messageSize = calculateMessageSize(data);
    totalBytes += messageSize;

    // Report every 5 seconds
    const now = Date.now();
    if (now - lastReport >= 5000) {
      const totalElapsed = (now - startTime) / 1000;
      const intervalElapsed = (now - lastReport) / 1000;
      const intervalMessages = messageCount - lastMessageCount;

      console.log(`\n=== Native gRPC Performance ===`);
      console.log(`Total messages: ${messageCount}`);
      console.log(`Total data: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
      console.log(
        `Overall throughput: ${(messageCount / totalElapsed).toFixed(2)} msg/s`,
      );
      console.log(
        `Overall data rate: ${(totalBytes / totalElapsed / 1024 / 1024).toFixed(2)} MB/s`,
      );
      console.log(
        `Interval throughput: ${(intervalMessages / intervalElapsed).toFixed(2)} msg/s`,
      );
      console.log(`Last message: ${messageType} (${messageSize} bytes)`);
      console.log(`===============================`);

      lastReport = now;
      lastMessageCount = messageCount;
    }
  });

  stream.on("error", (err) => {
    console.error("Stream error:", err);
  });

  stream.on("end", () => {
    const elapsed = (Date.now() - startTime) / 1000;
    console.log("\n=== Final Stats ===");
    console.log(`Total messages: ${messageCount}`);
    console.log(`Total data: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(
      `Average throughput: ${(messageCount / elapsed).toFixed(2)} msg/s`,
    );
    console.log(
      `Average data rate: ${(totalBytes / elapsed / 1024 / 1024).toFixed(2)} MB/s`,
    );
    console.log("===================\n");
    console.log("Stream ended");
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    stream.cancel();
    process.exit(0);
  });
}

if (require.main === module) {
  // Check if native grpc is available
  try {
    require.resolve("grpc");
    main().catch(console.error);
  } catch (err) {
    console.error("ERROR: Native grpc package not installed!");
    console.error("Run: npm install grpc@1.24.11");
    console.error("\nNote: The native grpc package requires:");
    console.error("- Node.js >= 10.x");
    console.error("- Python 2.7 or 3.x");
    console.error("- A C++ compiler (gcc, clang, or MSVC)");
    console.error("- On macOS: Xcode Command Line Tools");
    process.exit(1);
  }
}

module.exports = { NativeGrpcClient };
