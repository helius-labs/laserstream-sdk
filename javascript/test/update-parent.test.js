const assert = require('assert');
const protobuf = require('protobufjs');
const path = require('path');
const { initProtobuf, decodeSubscribeUpdate } = require('../proto-decoder');

async function main() {
  const root = await protobuf.load([
    path.join(__dirname, '..', 'proto', 'geyser.proto'),
    path.join(__dirname, '..', 'proto', 'solana-storage.proto'),
  ]);

  const entryFilter = root.lookupType('geyser.SubscribeRequestFilterEntry');
  const filterWire = entryFilter.encode({ includeUpdateParent: true }).finish();
  assert.deepStrictEqual(Buffer.from(filterWire), Buffer.from([0x08, 0x01]));

  const parentBlockId = Buffer.alloc(32, 0xab);
  const updateType = root.lookupType('geyser.SubscribeUpdate');
  const wire = updateType.encode({
    entryUpdateParent: {
      slot: 42,
      clearedBankId: 7,
      parentSlot: 41,
      parentBlockId,
    },
  }).finish();
  assert.strictEqual(wire[0], 0x6a, 'entryUpdateParent must use field 13');

  await initProtobuf();
  const update = decodeSubscribeUpdate(wire);
  assert.strictEqual(update.entryUpdateParent.slot, '42');
  assert.strictEqual(update.entryUpdateParent.clearedBankId, '7');
  assert.strictEqual(update.entryUpdateParent.parentSlot, '41');
  assert.deepStrictEqual(update.entryUpdateParent.parentBlockId, parentBlockId);

  console.log('update-parent: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});