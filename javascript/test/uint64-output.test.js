const assert = require('assert');
const path = require('path');
const protobuf = require('protobufjs');
const { initProtobuf, decodeSubscribeUpdate } = require('../proto-decoder');

const MAX_UINT64 = '18446744073709551615';

async function main() {
  const root = await protobuf.load([
    path.join(__dirname, '..', 'proto', 'geyser.proto'),
    path.join(__dirname, '..', 'proto', 'solana-storage.proto'),
  ]);
  const SubscribeUpdate = root.lookupType('geyser.SubscribeUpdate');

  const wire = SubscribeUpdate.encode({
    filters: [],
    block: {
      slot: MAX_UINT64,
      blockHeight: { blockHeight: MAX_UINT64 },
    },
  }).finish();

  await initProtobuf();
  const update = decodeSubscribeUpdate(wire);

  assert.strictEqual(update.block.slot, MAX_UINT64);
  assert.strictEqual(update.block.blockHeight.blockHeight, MAX_UINT64);
  assert.strictEqual(typeof update.block.slot, 'string');
  assert.strictEqual(typeof update.block.blockHeight.blockHeight, 'string');
  console.log('uint64 output: max values remain exact decimal strings');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
