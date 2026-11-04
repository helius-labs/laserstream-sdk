const assert = require('assert');
const protobuf = require('protobufjs');
const path = require('path');
const { initProtobuf, decodeSubscribeUpdate } = require('../proto-decoder');
const { BlockFooterSignatureKind } = require('../client');

async function main() {
  const root = await protobuf.load([
    path.join(__dirname, '..', 'proto', 'geyser.proto'),
    path.join(__dirname, '..', 'proto', 'solana-storage.proto'),
  ]);

  const footerFilter = root.lookupType('geyser.SubscribeRequestFilterBlockFooter');
  const filterWire = footerFilter.encode({ includeCertificates: true }).finish();
  assert.deepStrictEqual(Buffer.from(filterWire), Buffer.from([0x08, 0x01]));

  const blockId = Buffer.alloc(32, 0xbb);
  const aggregate = (fill, id) => ({
    signatureKind: BlockFooterSignatureKind.COMPRESSED_BLS12_381_G2,
    signature: Buffer.alloc(96, fill),
    blockId: id,
    signerBitmap: Buffer.from([1, 3, 0, 0b101]),
  });
  const updateType = root.lookupType('geyser.SubscribeUpdate');
  const wire = updateType.encode({
    filters: ['footer'],
    blockFooter: {
      slot: 42,
      bankId: 7,
      bankHash: Buffer.alloc(32, 0xaa),
      blockProducerTimeNanos: 123,
      blockUserAgent: Buffer.from('agave/4.3'),
      blockFinalCert: { slot: 40, finalAggregate: aggregate(0x11, Buffer.alloc(0)), notarAggregate: aggregate(0x12, blockId) },
      skipRewardCert: { slot: 39, aggregate: aggregate(0x13, Buffer.alloc(0)) },
      notarRewardCert: { slot: 41, aggregate: aggregate(0x14, blockId) },
    },
  }).finish();

  await initProtobuf();
  const footer = decodeSubscribeUpdate(wire).blockFooter;
  assert.strictEqual(footer.slot, '42');
  assert.strictEqual(footer.blockFinalCert.slot, '40');
  assert.strictEqual(footer.blockFinalCert.finalAggregate.signatureKind, BlockFooterSignatureKind.COMPRESSED_BLS12_381_G2);
  assert.deepStrictEqual(footer.blockFinalCert.finalAggregate.signature, Buffer.alloc(96, 0x11));
  assert.strictEqual(footer.blockFinalCert.finalAggregate.blockId.length, 0);
  assert.deepStrictEqual(footer.blockFinalCert.notarAggregate.blockId, blockId);
  assert.deepStrictEqual(footer.blockFinalCert.notarAggregate.signerBitmap, Buffer.from([1, 3, 0, 0b101]));
  assert.strictEqual(footer.skipRewardCert.slot, '39');
  assert.deepStrictEqual(footer.skipRewardCert.aggregate.signature, Buffer.alloc(96, 0x13));
  assert.strictEqual(footer.notarRewardCert.slot, '41');
  assert.deepStrictEqual(footer.notarRewardCert.aggregate.blockId, blockId);

  const metadataOnly = decodeSubscribeUpdate(updateType.encode({ blockFooter: { slot: 43 } }).finish()).blockFooter;
  assert.strictEqual(metadataOnly.slot, '43');
  assert.strictEqual(metadataOnly.blockFinalCert, null);
  assert.strictEqual(metadataOnly.skipRewardCert, null);
  assert.strictEqual(metadataOnly.notarRewardCert, null);

  console.log('footer-certificates: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
