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

  const bankIdCases = [
    {
      label: 'account',
      update: {
        account: {
          account: {
            pubkey: Buffer.alloc(32, 1),
            owner: Buffer.alloc(32, 2),
            data: Buffer.from([1, 2, 3]),
            writeVersion: '9',
          },
          slot: '42',
          bankId: '7',
        },
      },
      read: (message) => message.account.bankId,
    },
    {
      label: 'slot',
      update: {
        slot: {
          slot: '42',
          status: 0,
          bankId: '7',
        },
      },
      read: (message) => message.slot.bankId,
    },
    {
      label: 'transaction',
      update: {
        transaction: {
          slot: '42',
          bankId: '7',
          transaction: {
            signature: Buffer.alloc(64, 3),
            transaction: {},
            meta: {},
          },
        },
      },
      read: (message) => message.transaction.bankId,
    },
    {
      label: 'transactionStatus',
      update: {
        transactionStatus: {
          slot: '42',
          signature: Buffer.alloc(64, 4),
          bankId: '7',
        },
      },
      read: (message) => message.transactionStatus.bankId,
    },
    {
      label: 'block',
      update: {
        block: {
          slot: '42',
          blockhash: 'blockhash',
          parentSlot: '41',
          parentBlockhash: 'parent',
          bankId: '7',
        },
      },
      read: (message) => message.block.bankId,
    },
    {
      label: 'blockMeta',
      update: {
        blockMeta: {
          slot: '42',
          blockhash: 'blockhash',
          parentSlot: '41',
          parentBlockhash: 'parent',
          bankId: '7',
        },
      },
      read: (message) => message.blockMeta.bankId,
    },
    {
      label: 'entry',
      update: {
        entry: {
          slot: '42',
          index: '1',
          numHashes: '2',
          hash: Buffer.alloc(32, 5),
          executedTransactionCount: '3',
          startingTransactionIndex: '4',
          bankId: '7',
        },
      },
      read: (message) => message.entry.bankId,
    },
  ];

  for (const testCase of bankIdCases) {
    const bytes = SubscribeUpdate.encode({
      filters: ['bank-id'],
      ...testCase.update,
    }).finish();
    const decodedCase = decodeSubscribeUpdate(bytes);
    assert.strictEqual(
      testCase.read(decodedCase),
      '7',
      `${testCase.label} bankId should round-trip through the JS decoder`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
