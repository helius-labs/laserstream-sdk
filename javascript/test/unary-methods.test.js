// Unary RPC round-trip test against an in-process mock gRPC server
// (node:http2 + protobufjs; no network or extra deps). Run: npm run test:unary
const assert = require('assert');
const http2 = require('http2');
const path = require('path');
const protobuf = require('protobufjs');
const { LaserstreamClient, CommitmentLevel } = require('../client');

// Encode the commitment into numeric results so the test can verify it was sent.
const c = (req) => (req.commitment == null ? 999 : 1000 + req.commitment);
const HANDLERS = {
  GetSlot: ['GetSlotRequest', 'GetSlotResponse', (r) => ({ slot: c(r) })],
  GetBlockHeight: ['GetBlockHeightRequest', 'GetBlockHeightResponse', () => ({ blockHeight: 900 })],
  GetLatestBlockhash: ['GetLatestBlockhashRequest', 'GetLatestBlockhashResponse',
    (r) => ({ slot: c(r), blockhash: 'hash', lastValidBlockHeight: '18446744073709551615' })],
  IsBlockhashValid: ['IsBlockhashValidRequest', 'IsBlockhashValidResponse',
    (r) => ({ slot: 5, valid: r.blockhash === 'hash' })],
  GetVersion: ['GetVersionRequest', 'GetVersionResponse',
    (_r, h) => ({ version: `${h['x-token'] || ''}|${h['x-sdk-name'] || ''}` })],
  // count < 0 => respond after |count| ms (for deadline tests)
  Ping: ['PingRequest', 'PongResponse', async (r) => {
    if (r.count < 0) await new Promise((res) => setTimeout(res, -r.count));
    return { count: r.count };
  }],
  SubscribeReplayInfo: ['SubscribeReplayInfoRequest', 'SubscribeReplayInfoResponse', () => ({ firstAvailable: 42 })],
};

async function startServer() {
  const root = await protobuf.load([
    path.join(__dirname, '..', 'proto', 'geyser.proto'),
    path.join(__dirname, '..', 'proto', 'solana-storage.proto'),
  ]);
  const server = http2.createServer();
  // Track raw sockets so shutdown can destroy them: on Node 20, server.close()
  // leaves existing connections open, and the client's keepalive pings then
  // keep the process running forever.
  const sockets = new Set();
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  server.shutdown = () => {
    for (const sock of sockets) sock.destroy();
    server.close();
  };
  server.on('stream', (stream, headers) => {
    const method = headers[':path'].split('/').pop();
    const chunks = [];
    stream.on('data', (d) => chunks.push(d));
    stream.on('end', async () => {
      const h = HANDLERS[method];
      if (!h) {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '12' }, { endStream: true });
        return;
      }
      const [reqT, resT, fn] = h;
      const body = Buffer.concat(chunks).subarray(5); // strip gRPC frame header
      const req = root.lookupType(`geyser.${reqT}`).toObject(root.lookupType(`geyser.${reqT}`).decode(body));
      const Res = root.lookupType(`geyser.${resT}`);
      const resObj = await fn(req, headers);
      if (stream.destroyed) return; // client gave up (deadline)
      const msg = Buffer.from(Res.encode(Res.fromObject(resObj)).finish());
      const frame = Buffer.alloc(5 + msg.length);
      frame.writeUInt32BE(msg.length, 1);
      msg.copy(frame, 5);
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(frame);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

async function main() {
  const server = await startServer();
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const client = new LaserstreamClient({ endpoint, apiKey: 'secret' });

  assert.deepStrictEqual(await client.getSlot(), { slot: '999' });
  assert.deepStrictEqual(await client.getSlot(CommitmentLevel.FINALIZED), { slot: '1002' });
  assert.deepStrictEqual(await client.getBlockHeight(), { blockHeight: '900' });
  const bh = await client.getLatestBlockhash(CommitmentLevel.CONFIRMED);
  // u64 max survives as a string (no precision loss)
  assert.deepStrictEqual(bh, { slot: '1001', blockhash: 'hash', lastValidBlockHeight: '18446744073709551615' });
  assert.deepStrictEqual(await client.isBlockhashValid('hash'), { slot: '5', valid: true });
  assert.strictEqual((await client.isBlockhashValid('nope')).valid, false);
  assert.deepStrictEqual(await client.getVersion(), { version: 'secret|laserstream-javascript' });
  assert.deepStrictEqual(await client.ping(7), { count: 7 });
  assert.deepStrictEqual(await client.ping(), { count: 1 });
  assert.deepStrictEqual(await client.subscribeReplayInfo(), { firstAvailable: '42' });

  // Concurrent calls share the connection.
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => client.ping(i)));
  assert.deepStrictEqual(many.map((p) => p.count), Array.from({ length: 20 }, (_, i) => i));

  // Connection failures reject (and don't poison the client for later calls).
  const bad = new LaserstreamClient({ endpoint: 'http://127.0.0.1:1' });
  await assert.rejects(bad.getSlot(), /Connection failed/);
  await assert.rejects(bad.getSlot(), /Connection failed/);

  assert.throws(() => new LaserstreamClient({}), /endpoint is required/);
  assert.throws(() => new LaserstreamClient({ endpoint, timeoutMs: 0 }), /timeoutMs/);

  // timeoutMs bounds each call; the client stays usable afterwards.
  const fast = new LaserstreamClient({ endpoint, timeoutMs: 200 });
  const t0 = Date.now();
  await assert.rejects(fast.ping(-2000), /timeout|deadline/i);
  assert.ok(Date.now() - t0 < 1500, 'timeoutMs was not applied');
  assert.deepStrictEqual(await fast.ping(3), { count: 3 });

  // timeoutMs wins over channel-option timeouts (grpc.client_idle_timeout_ms).
  const withOpts = new LaserstreamClient({
    endpoint, timeoutMs: 200, channelOptions: { 'grpc.client_idle_timeout_ms': 60000 },
  });
  await assert.rejects(withOpts.ping(-2000), /timeout|deadline/i);

  // close() drops the connection; the next call reconnects. In-flight calls finish.
  const inflight = client.ping(-100);
  client.close();
  assert.deepStrictEqual(await inflight, { count: -100 });
  client.close(); // idempotent
  assert.deepStrictEqual(await client.ping(5), { count: 5 });

  for (const c of [client, bad, fast, withOpts]) c.close();
  server.shutdown();
  console.log('unary-methods: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
