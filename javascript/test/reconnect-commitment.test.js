// A write() that changes commitment must also change the fork-safety rewind on the
// next reconnect: PROCESSED rewinds 31 slots, CONFIRMED resumes at the tracked slot.
// Both directions are covered, because a stale level gets one of them wrong.
// In-process mock gRPC server. Run: npm run test:reconnect-commitment [down|up]
const assert = require('assert');
const http2 = require('http2');
const path = require('path');
const protobuf = require('protobufjs');
const { subscribe } = require('../client');

const TRACKED_SLOT = 1000;
const FORK_DEPTH_SAFETY_MARGIN = 31; // keep in sync with stream.rs
const CONFIRMED = 1;
const PROCESSED = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function grpcFrame(payload) {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

// Subscribes at one commitment, switches to the other with write(), cuts the
// connection, and returns the request the client resumes with.
async function exercise(types, startCommitment, writeCommitment) {
  const { SubscribeUpdate, SubscribeRequest } = types;

  // One decoded request list per gRPC stream, in connection order.
  const perConnection = [];
  const sockets = new Set();
  let signalWritten;
  const writeReachedServer = new Promise((resolve) => { signalWritten = resolve; });

  const server = http2.createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('stream', (stream) => {
    const requests = [];
    perConnection.push(requests);
    const index = perConnection.length; // 1-based connection number
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' });

    let buffered = Buffer.alloc(0);
    stream.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 5 && buffered.length >= 5 + buffered.readUInt32BE(1)) {
        const length = buffered.readUInt32BE(1);
        const payload = buffered.subarray(5, 5 + length);
        buffered = buffered.subarray(5 + length);
        requests.push(SubscribeRequest.decode(payload));

        // First connection: the second message is the write(). Once it is on the
        // wire, current_request already holds the new commitment, so cut the
        // connection and let the client resume.
        if (index === 1 && requests.length === 2) {
          signalWritten();
          setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 100);
        }
      }
    });

    // Give the first connection a slot so the client has something to track.
    if (index === 1) {
      const update = SubscribeUpdate.encode({ slot: { slot: TRACKED_SLOT, status: 1 } }).finish();
      stream.write(grpcFrame(update));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  let signalUpdate;
  const firstUpdate = new Promise((resolve) => { signalUpdate = resolve; });

  const handle = await subscribe(
    { endpoint, apiKey: '', replay: true },
    { accounts: { accounts: {} }, commitment: startCommitment },
    () => signalUpdate(),
    () => {},
  );

  try {
    await firstUpdate;
    await sleep(100); // let the client store the tracked slot

    await handle.write({ accounts: { accounts: {} }, commitment: writeCommitment });
    await writeReachedServer;

    const deadline = Date.now() + 20000;
    while (perConnection.length < 2 && Date.now() < deadline) await sleep(200);
    assert.ok(perConnection[1], 'client did not reconnect within 20s');
    const reconnect = perConnection[1][0];
    return { fromSlot: Number(reconnect.fromSlot), commitment: reconnect.commitment };
  } finally {
    handle.cancel();
    for (const socket of sockets) socket.destroy();
    server.close();
  }
}

const scenarios = {
  // CONFIRMED -> PROCESSED is the dangerous direction: the client has to start
  // rewinding, and a cached level leaves it resuming on the tracked slot where a
  // fork may have replaced the update.
  down: {
    startCommitment: CONFIRMED,
    writeCommitment: PROCESSED,
    expectedFromSlot: TRACKED_SLOT - FORK_DEPTH_SAFETY_MARGIN,
    why: `PROCESSED reconnect must rewind ${FORK_DEPTH_SAFETY_MARGIN} slots`,
  },
  // PROCESSED -> CONFIRMED has to stop rewinding. A cached level keeps the 31 slot
  // rewind, which replays slots the caller no longer asked for.
  up: {
    startCommitment: PROCESSED,
    writeCommitment: CONFIRMED,
    expectedFromSlot: TRACKED_SLOT,
    why: 'CONFIRMED reconnect must resume at the tracked slot, not rewind',
  },
};

async function main() {
  const only = process.argv[2];
  assert.ok(!only || scenarios[only], `unknown scenario ${only}, use down or up`);
  const selected = only ? [only] : Object.keys(scenarios);

  const root = await protobuf.load([
    path.join(__dirname, '..', 'proto', 'geyser.proto'),
    path.join(__dirname, '..', 'proto', 'solana-storage.proto'),
  ]);
  const types = {
    SubscribeUpdate: root.lookupType('geyser.SubscribeUpdate'),
    SubscribeRequest: root.lookupType('geyser.SubscribeRequest'),
  };

  for (const name of selected) {
    const scenario = scenarios[name];
    const result = await exercise(types, scenario.startCommitment, scenario.writeCommitment);

    assert.strictEqual(
      result.commitment,
      scenario.writeCommitment,
      'reconnect must request the commitment set by write(), not the one from subscribe()',
    );
    assert.strictEqual(
      result.fromSlot,
      scenario.expectedFromSlot,
      `${scenario.why} (expected ${scenario.expectedFromSlot}, got ${result.fromSlot})`,
    );
    console.log(
      `reconnect-commitment (${name}): resumed at ${result.fromSlot} with commitment ${result.commitment}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
