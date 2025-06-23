const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

// Proto definition extracted from yellowstone-grpc
const PROTO_CONTENT = `
syntax = "proto3";

package geyser;

message SubscribeRequest {
  map<string, SubscribeRequestFilterAccounts> accounts = 1;
  map<string, SubscribeRequestFilterSlots> slots = 2;
  map<string, SubscribeRequestFilterTransactions> transactions = 3;
  map<string, SubscribeRequestFilterTransactions> transactions_status = 4;
  map<string, SubscribeRequestFilterEntry> entry = 5;
  map<string, SubscribeRequestFilterBlocks> blocks = 6;
  map<string, SubscribeRequestFilterBlocksMeta> blocks_meta = 7;
  optional CommitmentLevel commitment = 8;
  repeated SubscribeRequestAccountsDataSlice accounts_data_slice = 9;
  optional SubscribeRequestPing ping = 10;
}

message SubscribeRequestFilterAccounts {
  repeated string account = 1;
  repeated string owner = 2;
  repeated SubscribeRequestFilterAccountsFilter filters = 3;
}

message SubscribeRequestFilterAccountsFilter {
  oneof filter {
    SubscribeRequestFilterAccountsFilterMemcmp memcmp = 1;
    SubscribeRequestFilterAccountsFilterLamports lamports = 2;
  }
}

message SubscribeRequestFilterAccountsFilterMemcmp {
  uint64 offset = 1;
  oneof data {
    bytes bytes = 2;
    string base58 = 3;
    string base64 = 4;
  }
}

message SubscribeRequestFilterAccountsFilterLamports {
  uint64 min = 1;
  uint64 max = 2;
}

message SubscribeRequestFilterSlots {
  bool filter_by_commitment = 1;
}

message SubscribeRequestFilterTransactions {
  optional bool vote = 1;
  optional bool failed = 2;
  optional string signature = 3;
  repeated string account_include = 4;
  repeated string account_exclude = 5;
  repeated string account_required = 6;
}

message SubscribeRequestFilterEntry {}

message SubscribeRequestFilterBlocks {
  repeated string account_include = 1;
  bool include_transactions = 2;
  bool include_accounts = 3;
  bool include_entries = 4;
}

message SubscribeRequestFilterBlocksMeta {}

message SubscribeRequestAccountsDataSlice {
  uint64 offset = 1;
  uint64 length = 2;
}

message SubscribeRequestPing {
  int32 id = 1;
}

message SubscribeUpdate {
  repeated SubscribeUpdateFilter filters = 1;
  oneof update_oneof {
    SubscribeUpdateAccount account = 2;
    SubscribeUpdateSlot slot = 3;
    SubscribeUpdateTransaction transaction = 4;
    SubscribeUpdateTransactionInfo transaction_info = 5;
    SubscribeUpdateBlock block = 6;
    SubscribeUpdatePing ping = 7;
    SubscribeUpdatePong pong = 8;
    SubscribeUpdateBlockMeta block_meta = 9;
    SubscribeUpdateEntry entry = 10;
  }
}

message SubscribeUpdateFilter {
  string filter = 1;
}

message SubscribeUpdateAccount {
  SubscribeUpdateAccountInfo account = 1;
  uint64 slot = 2;
  bool is_startup = 3;
}

message SubscribeUpdateAccountInfo {
  bytes pubkey = 1;
  uint64 lamports = 2;
  bytes owner = 3;
  bool executable = 4;
  uint64 rent_epoch = 5;
  bytes data = 6;
  uint64 write_version = 7;
  optional bytes txn_signature = 8;
}

message SubscribeUpdateSlot {
  uint64 slot = 1;
  optional uint64 parent = 2;
  SlotStatus status = 3;
}

message SubscribeUpdateTransaction {
  SubscribeUpdateTransactionInfo transaction = 1;
  uint64 slot = 2;
}

message SubscribeUpdateTransactionInfo {
  bytes signature = 1;
  bool is_vote = 2;
  bytes transaction = 3;
  bytes meta = 4;
  uint64 index = 5;
}

message SubscribeUpdateTransactionStatus {
  uint64 slot = 1;
  bytes signature = 2;
  bool is_vote = 3;
  uint64 index = 4;
  TransactionErrorCode err = 5;
}

message SubscribeUpdateBlock {
  uint64 slot = 1;
  string blockhash = 2;
  ConfirmedBlock rewards = 3;
  UnixTimestamp block_time = 4;
  optional CommitmentLevel block_height = 5;
  uint64 parent_slot = 6;
  string parent_blockhash = 7;
  uint64 executed_transaction_count = 8;
  repeated SubscribeUpdateEntry entries = 9;
  optional uint64 updated_account_count = 10;
  repeated SubscribeUpdateAccountInfo accounts = 11;
  uint64 entries_count = 12;
  repeated SubscribeUpdateTransactionInfo transactions = 13;
}

message SubscribeUpdateBlockMeta {
  uint64 slot = 1;
  string blockhash = 2;
  ConfirmedBlock rewards = 3;
  UnixTimestamp block_time = 4;
  optional CommitmentLevel block_height = 5;
  uint64 parent_slot = 6;
  string parent_blockhash = 7;
  uint64 executed_transaction_count = 8;
  uint64 entries_count = 9;
}

message SubscribeUpdateEntry {
  uint64 slot = 1;
  uint64 index = 2;
  uint64 num_hashes = 3;
  bytes hash = 4;
  uint64 executed_transaction_count = 5;
  uint64 starting_transaction_index = 6;
}

message SubscribeUpdatePing {}
message SubscribeUpdatePong {}

enum CommitmentLevel {
  PROCESSED = 0;
  CONFIRMED = 1;
  FINALIZED = 2;
}

enum SlotStatus {
  PROCESSED = 0;
  CONFIRMED = 1;
  FINALIZED = 2;
}

service Geyser {
  rpc Subscribe(stream SubscribeRequest) returns (stream SubscribeUpdate);
}
`;

// Write proto to temp file
const fs = require('fs');
const os = require('os');
const protoPath = path.join(os.tmpdir(), 'geyser.proto');
fs.writeFileSync(protoPath, PROTO_CONTENT);

// Load proto with native bindings optimization
const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  // Native optimizations
  bytesAsBase64: false, // Keep as Buffer for better performance
  arrays: true,
});

const geyserProto = grpc.loadPackageDefinition(packageDefinition).geyser;

class NativeGrpcClient {
  constructor(endpoint, token, options = {}) {
    const url = new URL(endpoint);
    const address = `${url.hostname}:${url.port || 80}`;
    
    // Create credentials
    let creds;
    if (url.protocol === 'https:') {
      creds = grpc.credentials.createSsl();
    } else {
      creds = grpc.credentials.createInsecure();
    }
    
    // Add token metadata
    if (token) {
      const metadataUpdater = (params, callback) => {
        const metadata = new grpc.Metadata();
        metadata.add('x-token', token);
        callback(null, metadata);
      };
      creds = grpc.credentials.combineChannelCredentials(
        creds,
        grpc.credentials.createFromMetadataGenerator(metadataUpdater)
      );
    }
    
    // Channel options optimized for performance
    const channelOptions = {
      'grpc.max_receive_message_length': 100 * 1024 * 1024, // 100MB
      'grpc.max_send_message_length': 10 * 1024 * 1024, // 10MB
      'grpc.keepalive_time_ms': 30000,
      'grpc.keepalive_timeout_ms': 10000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.http2.max_pings_without_data': 0,
      'grpc.http2.min_time_between_pings_ms': 10000,
      'grpc.http2.max_concurrent_streams': 1000,
      // Performance optimizations
      'grpc.use_local_subchannel_pool': 1,
      'grpc.max_connection_age_ms': 300000, // 5 minutes
      'grpc.max_connection_idle_ms': 300000,
      'grpc-node.max_session_memory': 512 * 1024 * 1024, // 512MB
      ...options
    };
    
    this.client = new geyserProto.Geyser(address, creds, channelOptions);
  }
  
  async subscribeWithRawBytes(request) {
    return new Promise((resolve, reject) => {
      const call = this.client.Subscribe();
      
      // Write the subscription request
      call.write(request);
      
      // Return the stream wrapped with raw bytes support
      const wrappedStream = new grpc.EventEmitter();
      
      call.on('data', (data) => {
        // For native grpc, we can potentially access raw bytes
        // but grpc-js doesn't expose them directly
        // Instead, emit with minimal overhead
        wrappedStream.emit('data', {
          _isRaw: false, // Can't get raw bytes from grpc-js
          data: data,
          _messageType: this.detectMessageType(data)
        });
      });
      
      call.on('error', (err) => wrappedStream.emit('error', err));
      call.on('end', () => wrappedStream.emit('end'));
      
      resolve(wrappedStream);
    });
  }
  
  detectMessageType(data) {
    if (data.update_oneof === 'account') return 2;
    if (data.update_oneof === 'slot') return 3;
    if (data.update_oneof === 'transaction') return 1;
    if (data.update_oneof === 'block' || data.update_oneof === 'block_meta') return 4;
    return 0;
  }
}

// Example usage
async function main() {
  const client = new NativeGrpcClient(
    'http://localhost:9443',
    '4c3081a5-78cd-4433-af8b-f62ae6dc937c'
  );
  
  const stream = await client.subscribeWithRawBytes({
    accounts: {},
    slots: {},
    transactions: {
      "all": {
        account_include: [],
        account_exclude: [],
        account_required: []
      }
    },
    transactions_status: {},
    entry: {},
    blocks: {},
    blocks_meta: {},
    commitment: 0, // PROCESSED
    accounts_data_slice: []
  });
  
  let messageCount = 0;
  let totalBytes = 0;
  const startTime = Date.now();
  
  stream.on('data', (msg) => {
    messageCount++;
    // Estimate size based on message content
    totalBytes += JSON.stringify(msg.data).length;
    
    if (messageCount % 10000 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`Messages: ${messageCount}`);
      console.log(`Throughput: ${(messageCount / elapsed).toFixed(2)} msg/s`);
      console.log(`Data rate: ${(totalBytes / elapsed / 1024 / 1024).toFixed(2)} MB/s`);
    }
  });
  
  stream.on('error', (err) => {
    console.error('Stream error:', err);
  });
  
  console.log('Native gRPC client started...');
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { NativeGrpcClient };