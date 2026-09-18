// Actual public client -> NAPI -> tonic -> local HTTP/2 gRPC wire -> JS callback.
// No live endpoint, credentials, publishing or deployment is involved.
const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { once } = require('node:events');
const client = require('../client');

(async () => {
  for (const name of ['AccountTransactionIndex', 'setAccountTransactionIndex', 'encodeAccountTransactionIndex']) {
    assert.equal(name in client, false, `unexpected public export: ${name}`);
  }
  const suffixes = ['', '800200', '80022a', '8002ffffffffffffffffff01', '8002feffffffffffffffff01'];
  const expected = ['0', '0', '42', '18446744073709551615', '18446744073709551614'];
  const sessions = new Set();
  const server = http2.createServer();
  server.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)); });
  server.on('stream', (stream, headers) => {
    assert.equal(headers[':path'], '/geyser.Geyser/Subscribe');
    stream.on('error', () => {}); // Cancellation is expected during test cleanup.
    stream.once('data', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
      for (const hex of suffixes) {
        const info = Buffer.from(hex, 'hex');
        for (const block of [false, true]) {
          const inner = Buffer.concat([Buffer.from([block ? 0x5a : 0x0a, info.length]), info]);
          const wire = Buffer.concat([Buffer.from([block ? 0x2a : 0x12, inner.length]), inner]);
          const frame = Buffer.alloc(5);
          frame.writeUInt32BE(wire.length, 1);
          stream.write(Buffer.concat([frame, wire]));
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let handle, timer;
  try {
    let delivered = 0;
    let resolve, reject;
    const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
    timer = setTimeout(() => reject(new Error(`only ${delivered}/10 callbacks`)), 15000);
    handle = await client.subscribe({ endpoint: `http://127.0.0.1:${server.address().port}`, apiKey: '', replay: false }, {}, update => {
      try {
        const account = update.account ? update.account.account : update.block.accounts[0];
        const typed = client.getAccountTransactionIndex(account);
        const value = expected[Math.floor(delivered / 2)];
        assert.deepEqual(typed, value === '18446744073709551615'
          ? { kind: 'NoTransaction' } : { kind: 'Transaction', index: value });
        assert.deepEqual(client.decodeAccountTransactionIndex(value), typed);
        assert.equal(account.transactionIndex, value);
        assert.equal(account.writeVersion, '0');
        if (++delivered === 10) resolve();
      } catch (error) { reject(error); }
    }, reject);
    await finished;
    assert.equal(delivered, 10);
    console.log('account-index: 10 actual native public subscribe callbacks passed');
  } finally {
    clearTimeout(timer);
    if (handle) handle.cancel();
    client.shutdownAllStreams();
    for (const session of sessions) session.destroy();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
