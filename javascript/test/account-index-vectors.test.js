const assert = require('node:assert/strict');
const { initProtobuf, decodeSubscribeUpdate } = require('../proto-decoder');
const { getAccountTransactionIndex } = require('../account-index');

(async () => {
  await initProtobuf();
  for (const [hex, expected] of [
    ['', { kind: 'Transaction', index: 0 }],
    ['800200', { kind: 'Transaction', index: 0 }],
    ['80022a', { kind: 'Transaction', index: 42 }],
    ['8002ffffffffffffffffff01', { kind: 'NoTransaction' }],
  ]) {
    const info = Buffer.from(hex, 'hex');
    for (const block of [false, true]) {
      const nested = Buffer.concat([Buffer.from([block ? 0x5a : 0x0a, info.length]), info]);
      const wire = Buffer.concat([Buffer.from([block ? 0x2a : 0x12, nested.length]), nested]);
      const update = decodeSubscribeUpdate(wire);
      assert.deepEqual(getAccountTransactionIndex(block ? update.block.accounts[0] : update.account.account), expected);
    }
  }
  assert.throws(() => getAccountTransactionIndex({ transactionIndex: '9007199254740992' }), RangeError);
  console.log('account index: omitted/zero/nonzero/NoTransaction and unsafe-number guard passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
