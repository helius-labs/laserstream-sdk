// Intra-slot updates against an in-process mock gRPC server that answers every Subscribe with OUT_OF_RANGE. Run: npm run test:intra-slot
const assert = require('assert');
const http2 = require('http2');
const { subscribe } = require('../client');

const SLOT_TOO_OLD = 'Requested slot 95 is older than the oldest available slot 100. Please request a more recent slot.';

async function startServer() {
  const server = http2.createServer();
  server.subscribes = [];
  let signalSubscribe;
  server.firstSubscribe = new Promise((resolve) => { signalSubscribe = resolve; });
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
    server.subscribes.push({
      intraSlotUpdates: headers['x-intra-slot-updates'],
      disableArchive: headers['x-disable-geyser-archive'],
    });
    signalSubscribe();
    stream.respond(
      { ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '11', 'grpc-message': encodeURIComponent(SLOT_TOO_OLD) },
      { endStream: true },
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

function request() {
  return { accounts: { accounts: {} }, fromSlot: 95 };
}

async function intraSlotSubscriptionSendsTheHeaderAndStopsAtOutOfRange() {
  const server = await startServer();
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  let signalError;
  const firstError = new Promise((resolve) => { signalError = resolve; });
  const handle = await subscribe({ endpoint, apiKey: '', intraSlotUpdates: true }, request(), () => {}, signalError);

  // The error callback fires only when the stream gives up, so no retry follows it.
  const error = await firstError;

  assert.match(error.message, /older than the oldest available slot/);
  assert.deepStrictEqual(server.subscribes, [{ intraSlotUpdates: 'true', disableArchive: undefined }]);
  handle.cancel();
  server.shutdown();
}

async function defaultSubscriptionSendsNoIntraSlotHeader() {
  const server = await startServer();
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const handle = await subscribe({ endpoint, apiKey: '' }, request(), () => {}, (e) => assert.fail(e));

  await server.firstSubscribe;

  assert.deepStrictEqual(server.subscribes[0], { intraSlotUpdates: undefined, disableArchive: undefined });
  handle.cancel();
  server.shutdown();
}

async function main() {
  // Backstop only: a stream that never signals would otherwise hang the job.
  setTimeout(() => {
    console.error('intra-slot-updates: no signal after 30s');
    process.exit(1);
  }, 30_000).unref();

  await intraSlotSubscriptionSendsTheHeaderAndStopsAtOutOfRange();
  await defaultSubscriptionSendsNoIntraSlotHeader();
  console.log('intra-slot-updates: all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
