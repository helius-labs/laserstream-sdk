// A stream the server ends cleanly (grpc-status 0) must reconnect, like the Rust
// and Go SDKs. In-process mock gRPC server. Run: npm run test:stream-end
const assert = require('assert');
const http2 = require('http2');
const path = require('path');
const protobuf = require('protobufjs');
const { subscribe } = require('../client');

async function startServer() {
  const root = await protobuf.load([
    path.join(__dirname, '..', 'proto', 'geyser.proto'),
    path.join(__dirname, '..', 'proto', 'solana-storage.proto'),
  ]);
  const Update = root.lookupType('geyser.SubscribeUpdate');
  const msg = Buffer.from(Update.encode(Update.fromObject({
    filters: ['accounts'],
    account: { slot: 100 },
  })).finish());
  const frame = Buffer.alloc(5 + msg.length);
  frame.writeUInt32BE(msg.length, 1);
  msg.copy(frame, 5);

  const server = http2.createServer();
  server.subscribes = 0;
  let signalSecond;
  server.secondSubscribe = new Promise((resolve) => { signalSecond = resolve; });
  const sockets = new Set();
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  server.shutdown = () => {
    for (const sock of sockets) sock.destroy();
    server.close();
  };
  server.on('stream', (stream) => {
    server.subscribes += 1;
    if (server.subscribes === 2) signalSecond();
    // One update, then a clean end of the response stream.
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.end(frame);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

async function main() {
  // Backstop only: a stream that never signals would otherwise hang the job.
  setTimeout(() => {
    console.error('stream-end-reconnect: no signal after 30s');
    process.exit(1);
  }, 30_000).unref();

  const server = await startServer();
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const updates = [];
  const handle = await subscribe(
    { endpoint, apiKey: '' },
    { accounts: { accounts: {} } },
    (update) => updates.push(update),
    (e) => assert.fail(e),
  );

  // The reconnect delay is 5s, so a second Subscribe should arrive well within 15s.
  const reconnected = await Promise.race([
    server.secondSubscribe.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 15_000)),
  ]);

  assert.ok(updates.length >= 1, 'the update sent before the stream ended was delivered');
  assert.ok(reconnected, `expected a reconnect after the server ended the stream, got ${server.subscribes} Subscribe call(s)`);
  handle.cancel();
  server.shutdown();
  console.log('stream-end-reconnect: all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
