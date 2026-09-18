const assert = require('node:assert/strict');
const { initProtobuf, decodeSubscribeUpdate } = require('../proto-decoder');
const { getAccountIndex } = require('../account-index');

(async () => {
  await initProtobuf();
  for (const { hex, expected } of [
    { hex: '', expected: { kind: 'Transaction', index: 0 } },
    { hex: '800200', expected: { kind: 'Transaction', index: 0 } },
    { hex: '80022a', expected: { kind: 'Transaction', index: 42 } },
    { hex: '8002ffffffffffffffffff01', expected: { kind: 'NoTransaction' } },
  ]) {
    const info = Buffer.from(hex, 'hex');
    for (const block of [false, true]) {
      const nested = Buffer.concat([Buffer.from([block ? 0x5a : 0x0a, info.length]), info]);
      const wire = Buffer.concat([Buffer.from([block ? 0x2a : 0x12, nested.length]), nested]);
      const update = decodeSubscribeUpdate(wire);
      assert.deepEqual(getAccountIndex(block ? update.block.accounts[0] : update.account.account), expected);
    }
  }
  for (const value of ['-1', '1.5', '9007199254740992']) {
    assert.throws(() => getAccountIndex({ transactionIndex: value }), RangeError);
  }
  assert.deepEqual(getAccountIndex({}), { kind: 'Transaction', index: 0 });
  assert.deepEqual(getAccountIndex({ transactionIndex: '9007199254740991' }), { kind: 'Transaction', index: Number.MAX_SAFE_INTEGER });
  console.log('account index: direct/nested legacy, transaction zero/nonzero, NoTransaction, numeric guards passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
