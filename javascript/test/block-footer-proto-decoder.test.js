const assert = require('assert');
const path = require('path');
const protobuf = require('protobufjs');
const { initProtobuf, decodeSubscribeUpdate } = require('../proto-decoder');

async function main() {
  await initProtobuf();

  const root = await protobuf.load([
    path.join(__dirname, '..', 'proto', 'geyser.proto'),
    path.join(__dirname, '..', 'proto', 'solana-storage.proto'),
  ]);

  const SubscribeUpdate = root.lookupType('geyser.SubscribeUpdate');
  const encoded = SubscribeUpdate.encode({
    filters: ['footer-filter'],
    blockFooter: {
      slot: '42',
      bankId: '7',
      bankHash: Buffer.alloc(32, 1),
      blockProducerTimeNanos: '123',
      blockUserAgent: Buffer.from('agave'),
    },
  }).finish();

  const decoded = decodeSubscribeUpdate(encoded);
  assert.deepStrictEqual(decoded.filters, ['footer-filter']);
  assert.strictEqual(decoded.blockFooter.slot, '42');
  assert.strictEqual(decoded.blockFooter.bankId, '7');
  assert.strictEqual(Buffer.from(decoded.blockFooter.bankHash).length, 32);
  assert.strictEqual(Buffer.from(decoded.blockFooter.blockUserAgent).toString(), 'agave');
  assert.strictEqual(decoded.block, undefined);
  assert.strictEqual(decoded.transaction, undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
