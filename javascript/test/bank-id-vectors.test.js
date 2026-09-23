const assert = require('node:assert/strict');
const { initProtobuf, decodeSubscribeUpdate } = require('../proto-decoder');

(async () => {
  await initProtobuf();
  const fields = [['account', 2, 4, true], ['slot', 3, 5, true], ['transaction', 4, 3],
    ['transactionStatus', 10, 6], ['block', 5, 14], ['blockMeta', 7, 10], ['entry', 8, 7]];
  for (const [kind, envelope, tag, optional] of fields) {
    for (const [hex, value] of [['', undefined], ['00', '0'], ['01', '1'], ['ffffffffffffffffff01', '18446744073709551615']]) {
      const payload = hex ? Buffer.concat([Buffer.from([tag << 3]), Buffer.from(hex, 'hex')]) : Buffer.alloc(0);
      const wire = Buffer.concat([Buffer.from([(envelope << 3) | 2, payload.length]), payload]);
      const actual = decodeSubscribeUpdate(wire)[kind];
      assert.equal(actual.bankId, value === undefined && !optional ? '0' : value, kind);
      if (optional) assert.equal(Object.hasOwn(actual, 'bankId'), value !== undefined, kind + ' presence');
    }
  }
  console.log('bank IDs: all seven exact Triton fields; absent/zero/one/max-u64 vectors passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
