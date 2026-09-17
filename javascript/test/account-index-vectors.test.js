const assert = require('node:assert/strict');
const { initProtobuf, decodeSubscribeUpdate } = require('../proto-decoder');

// Independent wire vectors: tag 9 (varint), not encoded using the tested schema.
const vectors = [
  ['', undefined],
  ['4800', '0'],
  ['482a', '42'],
  ['48ffffffffffffffffff01', '18446744073709551615'],
];

(async () => {
  await initProtobuf();
  for (const [hex, expected] of vectors) {
    const info = Buffer.from(hex, 'hex');
    for (const block of [false, true]) {
      const nested = Buffer.concat([Buffer.from([block ? 0x5a : 0x0a, info.length]), info]);
      const wire = Buffer.concat([Buffer.from([block ? 0x2a : 0x12, nested.length]), nested]);
      const update = decodeSubscribeUpdate(wire);
      const account = block ? update.block.accounts[0] : update.account.account;
      assert.equal(account.transactionIndex, expected);
      assert.equal(Object.hasOwn(account, 'transactionIndex'), expected !== undefined);
      assert.equal(account.writeVersion, '0'); // Existing defaults are unchanged.
    }
  }
  console.log('account-index: 8 shipped decoder vectors passed (account/block, absent/zero/42/max-u64)');
})().catch(error => { console.error(error); process.exitCode = 1; });
