const assert = require('node:assert/strict');
const protobuf = require('protobufjs');
const { initProtobuf, decodeSubscribeUpdate } = require('../proto-decoder');
const { AccountTransactionIndex: Index, getAccountTransactionIndex, setAccountTransactionIndex,
  encodeAccountTransactionIndex, decodeAccountTransactionIndex } = require('../account-index');

// Independent field-32 raw vectors, not encoded by the tested schema.
const vectors = [
  ['', '0'], ['800200', '0'], ['80022a', '42'],
  ['8002ffffffffffffffffff01', '18446744073709551615'],
  ['8002feffffffffffffffff01', '18446744073709551614'],
];
const oldFields = '0a010110071a0102200128083201033809420104';

(async () => {
  await initProtobuf();
  const root = await protobuf.load([`${__dirname}/../proto/geyser.proto`, `${__dirname}/../proto/solana-storage.proto`]);
  const current = root.lookupType('geyser.SubscribeUpdate');
  // Actual historical account schema, preserving every other message/field.
  const legacyRoot = protobuf.Root.fromJSON(root.toJSON());
  const legacyInfo = legacyRoot.lookupType('geyser.SubscribeUpdateAccountInfo');
  legacyInfo.remove(legacyInfo.fields.transactionIndex);
  const legacy = legacyRoot.lookupType('geyser.SubscribeUpdate');
  for (const [hex, expected] of vectors) {
    const info = Buffer.from(oldFields + hex, 'hex');
    for (const block of [false, true]) {
      const nested = Buffer.concat([Buffer.from([block ? 0x5a : 0x0a, info.length]), info]);
      const wire = Buffer.concat([Buffer.from([block ? 0x2a : 0x12, nested.length]), nested]);
      const update = decodeSubscribeUpdate(wire);
      const account = block ? update.block.accounts[0] : update.account.account;
      assert.equal(account.transactionIndex, expected);
      const typed = getAccountTransactionIndex(account);
      assert.deepEqual(typed, expected === '18446744073709551615' ? Index.NoTransaction : Index.Transaction(expected));
      assert.equal(encodeAccountTransactionIndex(JSON.parse(JSON.stringify(typed))), expected);
      assert.deepEqual(decodeAccountTransactionIndex(expected), typed);
      setAccountTransactionIndex(account, typed);
      const roundtrip = decodeSubscribeUpdate(current.encode(current.fromObject(update)).finish());
      assert.deepEqual(block ? roundtrip.block.accounts[0] : roundtrip.account.account, account);
      const oldDecoded = legacy.decode(wire);
      const oldAccount = block ? oldDecoded.block.accounts[0] : oldDecoded.account.account;
      assert.equal(legacyInfo.encode(oldAccount).finish().toString('hex'), oldFields);
      const oldRoundtrip = legacy.decode(current.encode(current.fromObject(update)).finish());
      const options = {defaults: true, longs: String, bytes: String};
      assert.deepEqual(legacy.toObject(oldRoundtrip, options), legacy.toObject(oldDecoded, options));
    }
  }
  assert.deepEqual(getAccountTransactionIndex({}), Index.Transaction('0'));
  for (const invalid of [42, -1, null, '01', '-1', '1.5', '18446744073709551616', '']) {
    assert.throws(() => decodeAccountTransactionIndex(invalid));
    assert.throws(() => Index.Transaction(invalid));
  }
  assert.throws(() => Index.Transaction('18446744073709551615'));
  assert.throws(() => encodeAccountTransactionIndex({ kind: 'Transaction', index: '18446744073709551615' }));
  const account = { transactionIndex: '42' };
  assert.throws(() => setAccountTransactionIndex(account, {kind: 'Transaction', index: 42}));
  assert.equal(account.transactionIndex, '42');
  // Preserve decoder defaults for unrelated fields, and scalar zero for absence.
  const defaults = decodeSubscribeUpdate(Buffer.from('12020a00', 'hex')).account.account;
  assert.equal(defaults.writeVersion, '0');
  assert.equal(defaults.lamports, '0');
  assert.equal(defaults.executable, false);
  assert.deepEqual(defaults.data, Buffer.alloc(0));
  assert.equal(defaults.transactionIndex, '0');
  console.log('account-index: 10 direct/block scalar32 vectors, old-schema compatibility, typed/JSON roundtrips and rejection controls passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
