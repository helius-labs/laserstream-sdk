const protobuf = require('protobufjs');
const path = require('path');

let root = null;
let SubscribeUpdate = null;

// Initialize protobuf types
async function initProtobuf() {
  if (root) return; // Already initialized
  
  try {
    // Load the protobuf schema
    root = await protobuf.load([
      path.join(__dirname, 'proto', 'geyser.proto'),
      path.join(__dirname, 'proto', 'solana-storage.proto')
    ]);
    
    // Get the SubscribeUpdate message type
    SubscribeUpdate = root.lookupType('geyser.SubscribeUpdate');
    
  } catch (error) {
    throw error;
  }
}

// Decode protobuf bytes to JavaScript object
function decodeSubscribeUpdate(bytes) {
  if (!SubscribeUpdate) {
    throw new Error('Protobuf not initialized. Call initProtobuf() first.');
  }
  
  try {
    // Decode the protobuf bytes
    const message = SubscribeUpdate.decode(bytes);
    
    // Convert to plain JavaScript object with proper handling
    const obj = SubscribeUpdate.toObject(message, {
      longs: String,           // Convert uint64 to string (like Yellowstone)
      enums: Number,           // Keep enums as numbers
      bytes: Buffer,           // Keep bytes as Buffer (exactly like Yellowstone)
      defaults: true,         // Include default values
      arrays: true,            // Always include arrays
      objects: true,           // Always include objects
      oneofs: false             // Do not include oneof virtual fields
    });
    
    // Remove protobuf-oneof helper fields if present
    delete obj.updateOneof;
    delete obj.update;
    
    // Post-process the object to match Yellowstone interface exactly
    return processYellowstoneUpdate(obj);
    
  } catch (error) {
    throw error;
  }
}

// Process the decoded object to match Yellowstone interface exactly
function processYellowstoneUpdate(obj) {
  // Convert createdAt timestamp to Date object (matching Yellowstone)
  if (obj.createdAt) {
    const timestamp = obj.createdAt;
    const millis = parseInt(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000);
    obj.createdAt = new Date(millis);
  }
  
  // Initialize all update type fields to undefined (matching Yellowstone)
  const updateFields = [
    'account', 'slot', 'transaction', 'transactionStatus', 
    'block', 'blockMeta', 'entry', 'ping', 'pong'
  ];
  
  updateFields.forEach(field => {
    if (!(field in obj)) {
      obj[field] = undefined;
    }
  });
  
  // Process specific update types
  if (obj.account) {
    obj.account = processAccountUpdate(obj.account);
  }
  
  if (obj.slot) {
    obj.slot = processSlotUpdate(obj.slot);
  }
  
  if (obj.transaction) {
    obj.transaction = processTransactionUpdate(obj.transaction);
  }
  
  if (obj.transactionStatus) {
    obj.transactionStatus = processTransactionStatusUpdate(obj.transactionStatus);
  }
  
  if (obj.block) {
    obj.block = processBlockUpdate(obj.block);
  }
  
  if (obj.blockMeta) {
    obj.blockMeta = processBlockMetaUpdate(obj.blockMeta);
  }
  
  if (obj.entry) {
    obj.entry = processEntryUpdate(obj.entry);
  }
  
  // Ensure consistent field ordering like Yellowstone
  const orderedObj = {
    filters: obj.filters,
    account: obj.account,
    slot: obj.slot,
    transaction: obj.transaction,
    transactionStatus: obj.transactionStatus,
    block: obj.block,
    blockMeta: obj.blockMeta,
    entry: obj.entry,
    ping: obj.ping,
    pong: obj.pong,
    createdAt: obj.createdAt,
  };
  
  return orderedObj;
}

// Process account update to match Yellowstone format
function processAccountUpdate(account) {
  // protobufjs with bytes: Buffer already returns Buffer objects
  // No conversion needed - they already match Yellowstone format
  return account;
}

// Process slot update to match Yellowstone format
function processSlotUpdate(slot) {
  // Ensure parent is either string or undefined (not null)
  if (slot.parent === null) {
    slot.parent = undefined;
  }
  
  // Ensure deadError is either string or undefined (not null)
  if (slot.deadError === null) {
    slot.deadError = undefined;
  }
  
  return slot;
}

// Process transaction update to match Yellowstone format
function processTransactionUpdate(transaction) {
  // protobufjs with bytes: Buffer already returns Buffer objects
  // No conversion needed - they already match Yellowstone format
  return transaction;
}

// Process transaction status update to match Yellowstone format
function processTransactionStatusUpdate(transactionStatus) {
  // protobufjs with bytes: Buffer already returns Buffer objects
  // Only need to handle null -> undefined conversion
  if (transactionStatus.err === null) {
    transactionStatus.err = undefined;
  }
  
  return transactionStatus;
}

// Process block update to match Yellowstone format
function processBlockUpdate(block) {
  // protobufjs with bytes: Buffer already returns Buffer objects
  // No conversion needed - they already match Yellowstone format
  return block;
}

// Process block meta update to match Yellowstone format
function processBlockMetaUpdate(blockMeta) {
  // BlockMeta is similar to Block but without transactions/accounts/entries arrays
  return blockMeta;
}

// Process entry update to match Yellowstone format
function processEntryUpdate(entry) {
  // protobufjs with bytes: Buffer already returns Buffer objects
  // No conversion needed - they already match Yellowstone format
  return entry;
}

// Export functions
module.exports = {
  initProtobuf,
  decodeSubscribeUpdate
}; 