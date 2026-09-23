#!/usr/bin/env node
'use strict';
// node test/replay-transport.js [--manifest capture-plan.json] [--out evidence-dir]
// Or: --capture response.grpc [--replay-capture worker2.grpc] [--prefix N]
// The raw capture mode checks the complete semantic multiset, including native
// multiplicity, after an initial prefix and two whole-bank transport replays.
// Capture-plan format (paths relative to the plan):
// {name, fromSlot:"95", replay:true, connections:[
//   {capture:"worker-a/updates.jsonl", indices:[0,1], expected:[0,1], fromSlot:"95"},
//   {capture:"worker-b/updates.jsonl", indices:[0,1,2], expected:[2], fromSlot:"69"}
// ]}
// indices and expected index ORIGINAL capture rows, not the selected array.
// Each row must contain rawProtobufBase64 from the native capture tool. Bytes are
// forwarded unchanged; no bank ID/write version normalization is done by this server.
// Expectations are supplied by the caller, NEVER inferred by running SDK dedup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http2 = require('node:http2');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const rootDir = path.resolve(__dirname, '..');
const protobuf = require(path.join(rootDir, 'javascript/node_modules/protobufjs'));
const { initProtobuf, decodeSubscribeUpdate } = require(path.join(rootDir, 'javascript/proto-decoder'));
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) options[args[i]] = args[i + 1];
const output = path.resolve(options['--out'] || 'replay-transport-evidence');
const json = value => JSON.parse(JSON.stringify(value));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let Update, Request;
const encode = value => Buffer.from(Update.encode(Update.fromObject(value)).finish());
const wire = bytes => { const header = Buffer.alloc(5); header.writeUInt32BE(bytes.length, 1); return Buffer.concat([header, bytes]); };

function syntheticPlans() {
  const max = '18446744073709551615';
  const account = (pubkey, signature) => ({ pubkey: Buffer.alloc(32, pubkey), owner: Buffer.alloc(32, 8), lamports: '42', data: Buffer.from([1, 2]), writeVersion: '11', ...(signature === undefined ? {} : { txnSignature: Buffer.alloc(64, Number(signature)) }) });
  const event = (kind, value, bankId = '7') => ({ filters: ['all'], [kind]: { slot: '100', bankId, ...value }, createdAt: { seconds: '1', nanos: 0 } });
  const native = event('account', { account: account(1) });
  const owned = event('account', { account: account(2, '42') });
  const prefix = [native, native, owned,
    event('transaction', { transaction: { signature: Buffer.alloc(64, 5), index: '42' } }),
    event('transactionStatus', { signature: Buffer.alloc(64, 5), index: '42' }),
    event('entry', { index: '3', hash: Buffer.alloc(32, 6), executedTransactionCount: '1', startingTransactionIndex: '42' }),
    event('slot', { parent: '99', status: 0 }),
    event('account', { account: account(9) }, '0'), event('slot', { parent: '99', status: 0 }, '0')];
  const suffix = [native,
    event('account', { account: account(2, '43') }), // same pubkey, different transaction
    event('account', { account: account(3, '42') }), // same transaction, different pubkey
    event('blockMeta', { blockhash: 'bank-a' }),
    event('block', { blockhash: 'bank-a', accounts: [account(1), account(2, '42')], entries: [{ slot: '100', bankId: '7', index: '3' }] })];
  function rewrite(updates, version, bank) {
    return updates.map(update => {
      const v = json(update), kind = Object.keys(v).find(k => !['filters', 'createdAt'].includes(k));
      // Restore Buffer objects after cloning, using the actual schema.
      const u = Update.toObject(Update.decode(encode(update)), { longs: String, bytes: Buffer });
      const p = u[kind];
      if (bank !== undefined) p.bankId = bank;
      if (p.account) p.account.writeVersion = version;
      if (p.accounts) { p.accounts.reverse(); for (const a of p.accounts) a.writeVersion = version; }
      if (p.entries && bank !== undefined) for (const e of p.entries) e.bankId = bank;
      u.createdAt = { seconds: version, nanos: 1 };
      return u;
    });
  }
  const full = [...prefix, ...suffix];
  const fullReplay = rewrite(full, '900');
  const b = rewrite(full.filter(u => !['0'].includes(Object.values(u).find(v => v && v.bankId !== undefined)?.bankId)), '1000', '8');
  const c = rewrite(b, '2000', max);
  const legacy = rewrite([prefix[0], ...prefix.slice(3, 7), ...suffix.slice(3)], '3000').map(u => {
    for (const p of Object.values(u)) if (p && typeof p === 'object') delete p.bankId;
    return u;
  });
  // Native account replay is deliberately pass-through, including a mid-bank
  // initial subscription. Expectations come from sent frames, not SDK dedup.
  const connection = (updates, expected, fromSlot, status = 0) => ({
    updates: updates.map(encode),
    expected: [...new Set([...expected, ...updates.flatMap((u, i) => isNativeAccount(u) ? [i] : [])])].sort((a, b) => a - b),
    fromSlot, status
  });
  const all = updates => updates.map((_, i) => i);
  if (options['--case'] === 'native-midbank') {
    // Live starts at B; full replay sends A then B. Native replay remains
    // pass-through, so B, A and B must all reach the application unchanged.
    return [{ name: 'native-midbank-pass-through', provenance: 'synthetic native replay contract regression', replay: true, fromSlot: null, connections: [
      connection(rewrite([native], '200'), [0], null),
      connection([...rewrite([native], '101'), ...rewrite([native], '102')], [0], '69')
    ] }];
  }
  if (options['--case'] === 'native-midbank-prefix' || options['--case'] === 'native-prefix-overlap') {
    // Identical wire histories, different source-owned operations (A and B).
    // Gap: live starts at B; replay emits unseen A, then disconnects before B.
    // Control: live emits A; replay emits that same A. Neither arrival order nor
    // the worker-local version/timestamp disambiguates these legal histories.
    const gap = options['--case'] === 'native-midbank-prefix';
    return [{ name: gap ? 'native-midbank-prefix-pass-through' : 'native-prefix-overlap-pass-through',
      provenance: 'synthetic indistinguishable histories; operation labels exist only in the oracle',
      replay: true, fromSlot: null, connections: [
        connection(rewrite([native], '200'), [0], null),
        connection(rewrite([native], '101'), gap ? [0] : [], '69', 14),
        connection([], [], '69')
      ] }];
  }
  return [{ name: 'partial-bank-worker-rewrite-alternating-banks', provenance: 'synthetic regression vectors (not native producer evidence)', replay: true, fromSlot: '95', connections: [
    connection([], [], '95'),
    connection(prefix, all(prefix), '95', 14),
    connection([], [], '69', 14),
    connection(fullReplay, suffix.map((_, i) => prefix.length + i), '69'),
    connection([...rewrite(full, '901'), ...b], b.map((_, i) => full.length + i), '69', 14),
    connection([...rewrite(b, '1001'), ...rewrite(full, '902'), ...c, ...legacy, ...legacy],
      [...c, ...legacy, ...legacy].map((_, i) => b.length + full.length + i), '69')
  ] }, { name: 'replay-disabled', provenance: 'synthetic regression vectors', replay: false, fromSlot: '95', connections: [
    connection(prefix, all(prefix), null), connection(rewrite(prefix, '77'), all(prefix), null)
  ] }];
}

function capturePlan(file) {
  const plan = JSON.parse(fs.readFileSync(file));
  const base = path.dirname(path.resolve(file));
  const captures = [];
  assert(plan.name && plan.connections.length >= 2, 'name and at least two connections required');
  plan.connections = plan.connections.map(c => {
    const filename = path.resolve(base, c.capture), data = fs.readFileSync(filename);
    captures.push({ path: filename, sha256: sha(data) });
    const rows = data.toString().trim().split('\n').map(line => JSON.parse(line));
    const ids = c.indices || rows.map((_, i) => i);
    assert(Array.isArray(c.expected), 'explicit expected row indices required');
    for (const i of [...ids, ...c.expected]) assert(Number.isInteger(i) && rows[i]?.rawProtobufBase64, 'missing capture row ' + i);
    assert(new Set(ids).size === ids.length, 'use separate connections rather than duplicating capture row indices');
    for (const i of c.expected) assert(ids.includes(i), 'expected row must have been sent');
    return { ...c, updates: ids.map(i => Buffer.from(rows[i].rawProtobufBase64, 'base64')), expected: c.expected.map(i => ids.indexOf(i)) };
  });
  return { ...plan, replay: plan.replay !== false, provenance: 'captured producer/worker bytes; caller-supplied expectation', captures };
}

function framedCapturePlan(filename) {
  function readCapture(file) {
    const data = fs.readFileSync(file), updates = []; let offset = 0;
    while (offset < data.length) {
      assert(offset + 5 <= data.length, 'truncated gRPC frame header');
      assert.equal(data[offset], 0, 'capture must be uncompressed gRPC');
      const size = data.readUInt32BE(offset + 1); offset += 5;
      assert(offset + size <= data.length, 'truncated gRPC frame body');
      const bytes = data.subarray(offset, offset + size); offset += size;
      const u = decodeSubscribeUpdate(bytes);
      if (u.ping || u.pong) continue;
      assert(u.filters.length > 0, 'capture must contain customer-filtered updates, not internal ingest envelopes');
      assert(payloadSlot(u) !== null, 'unsupported capture update');
      updates.push(bytes);
    }
    assert(updates.length > 1, 'capture needs a bank with multiple updates');
    return { updates, source: { path: path.resolve(file), sha256: sha(data) } };
  }
  const original = readCapture(filename), replay = readCapture(options['--replay-capture'] || filename);
  const decoded = original.updates.map(decodeSubscribeUpdate);
  const beforeMeta = decoded.findIndex(u => u.blockMeta || u.block);
  const prefix = Number(options['--prefix'] || (beforeMeta > 0 ? beforeMeta : 1));
  assert(Number.isInteger(prefix) && prefix > 0 && prefix < original.updates.length, 'prefix must stop inside the bank');
  const slots = decoded.map(payloadSlot);
  const minimum = slots.reduce((a, b) => a < b ? a : b);
  const cursor = updates => {
    const max = updates.map(b => payloadSlot(decodeSubscribeUpdate(b))).reduce((a, b) => a > b ? a : b);
    return String(max > 31n ? max - 31n : 0n);
  };
  // Independent source comparison: don't derive an oracle by invoking SDK dedup.
  assert.deepEqual(semanticMultiset(original.updates.map(decodeSubscribeUpdate)), semanticMultiset(replay.updates.map(decodeSubscribeUpdate)),
    'independent captures must represent the same complete bank payload multiset');
  const fromSlot = options['--from-slot'] || String(minimum);
  assert(BigInt(fromSlot) <= minimum, 'initial from_slot must request the bank from its beginning');
  const connections = [
    { updates: original.updates.slice(0, prefix), expected: [], fromSlot, status: 14 },
    { updates: replay.updates, expected: [], fromSlot: cursor(original.updates.slice(0, prefix)) },
    { updates: original.updates, expected: [], fromSlot: cursor(replay.updates) }
  ];
  const semanticExpected = [
    ...decoded.filter(u => !isNativeAccount(u)),
    ...connections.flatMap(c => c.updates.map(decodeSubscribeUpdate).filter(isNativeAccount))
  ];
  return { name: 'native-framed-capture', replay: true, fromSlot,
    provenance: 'unmodified customer frames; bank-aware replay suppression with native account pass-through',
    captures: [original.source, replay.source], semanticExpected, connections
  };
}

function isNativeAccount(update) {
  return !!update.account && !update.account.account?.txnSignature?.length;
}

function payloadSlot(update) {
  for (const kind of ['account', 'slot', 'transaction', 'transactionStatus', 'block', 'blockMeta', 'entry']) {
    if (update[kind]) return BigInt(update[kind].slot);
  }
  return null;
}

function semanticMultiset(updates) {
  return updates.map(update => {
    const u = json(update); delete u.createdAt; u.filters.sort();
    if (u.account?.account) u.account.account.writeVersion = '0';
    if (u.block) {
      for (const a of u.block.accounts) a.writeVersion = '0';
      u.block.accounts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return JSON.stringify(u);
  }).sort();
}

async function run(plan, language) {
  const label = plan.name + '-' + language;
  const dir = path.join(output, label); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sent.json'), JSON.stringify(plan.connections.map(c => ({
    fromSlot: c.fromSlot ?? null, status: c.status || 0, updates: c.updates.map(b => b.toString('base64'))
  })), null, 2));
  const expected = plan.semanticExpected ? json(plan.semanticExpected) : plan.connections.flatMap(c => c.expected.map(i => json(decodeSubscribeUpdate(c.updates[i]))));
  const delivered = [], requests = [], sessions = new Set(); let failure, finalSent = false;
  const server = http2.createServer();
  server.on('session', s => { sessions.add(s); s.on('error', () => {}); s.on('close', () => sessions.delete(s)); });
  server.on('stream', stream => {
    stream.on('error', () => {});
    let pending = Buffer.alloc(0), started = false;
    stream.on('data', chunk => {
      if (started) return;
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 5 || pending.length < 5 + pending.readUInt32BE(1)) return;
      started = true;
      try {
        assert.equal(pending[0], 0, 'request compression disabled');
        const request = Request.toObject(Request.decode(pending.subarray(5, 5 + pending.readUInt32BE(1))), { longs: String });
        const index = requests.length, c = plan.connections[index];
        requests.push(request); assert(c, 'unexpected extra reconnect');
        assert.equal(request.fromSlot ?? null, c.fromSlot ?? null, 'replay cursor connection ' + index);
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': String(c.status || 0), 'grpc-message': 'test-boundary' }));
        const internal = Object.keys(request.slots || {}).find(k => k.startsWith('__internal_slot_tracker_') || k.startsWith('internal-'));
        if (plan.replay) {
          assert(internal, 'real SDK internal subscription missing');
          // Must NOT move cursor or prune dedup based on a hidden live head.
          stream.write(wire(encode({ filters: [internal], slot: { slot: '9000', bankId: '91' } })));
        } else assert(!internal, 'disabled replay must not add internal tracker');
        for (const bytes of c.updates) stream.write(wire(bytes));
        if (index === plan.connections.length - 1) {
          finalSent = true;
          stream.write(wire(encode({ filters: ['__sdk_test_done'], account: { slot: '100' } })));
        } else stream.end();
      } catch (e) { failure = e; stream.close(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const commands = {
    rust: ['cargo', ['test', '--locked', '--test', 'replay_transport_consumer', '--no-default-features', '--', '--ignored', '--nocapture'], 'rust'],
    go: [process.env.GO || 'go', ['test', '-run', '^TestReplayTransportConsumer$', '-count=1', '-v', '.'], 'go'],
    js: [process.execPath, ['test/replay-transport-consumer.js'], 'javascript']
  };
  const [command, argv, cwd] = commands[language];
  const env = { ...process.env, SDK_REPLAY_ENDPOINT: 'http://127.0.0.1:' + server.address().port, SDK_REPLAY_ENABLED: String(plan.replay), SDK_REPLAY_FROM_SLOT: plan.fromSlot === null ? '' : plan.fromSlot || '95' };
  const child = spawn(command, argv, { cwd: path.join(rootDir, cwd), env });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const timer = setTimeout(() => { failure ||= Error('harness deadline'); child.kill('SIGKILL'); }, 120000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  } finally {
    clearTimeout(timer); for (const s of sessions) s.destroy(); server.close();
    fs.writeFileSync(path.join(dir, 'stdout.log'), stdout); fs.writeFileSync(path.join(dir, 'stderr.log'), stderr);
    fs.writeFileSync(path.join(dir, 'requests.json'), JSON.stringify(requests, null, 2));
  }
  if (failure) throw failure;
  assert.equal(code, 0, label + ' consumer failed: ' + stderr + stdout);
  assert(finalSent, 'consumer did not reach final connection');
  for (const line of stdout.split('\n').filter(l => l.startsWith('SDK_UPDATE '))) {
    const row = JSON.parse(line.slice(11));
    delivered.push(row.decoded || json(decodeSubscribeUpdate(Buffer.from(row.hex, 'hex'))));
  }
  fs.writeFileSync(path.join(dir, 'delivered.json'), JSON.stringify(delivered, null, 2));
  fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(expected, null, 2));
  if (plan.semanticExpected) {
    const sent = new Set(plan.connections.flatMap(c => c.updates.map(b => JSON.stringify(json(decodeSubscribeUpdate(b))))));
    for (const u of delivered) assert(sent.has(JSON.stringify(u)), 'SDK changed a delivered payload');
    assert.deepEqual(semanticMultiset(delivered), semanticMultiset(expected), label + ' semantic payload multiset/multiplicity');
  } else assert.deepEqual(delivered, expected, label + ' exact callback payload/order/multiplicity');
  const result = { name: plan.name, language, passed: true, provenance: plan.provenance, sourceCaveat: plan.sourceCaveat, captures: plan.captures, connections: requests.length, delivered: delivered.length, command: [command, ...argv] };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); return result;
}

async function main() {
  const root = await protobuf.load(path.join(rootDir, 'javascript/proto/geyser.proto'));
  Update = root.lookupType('geyser.SubscribeUpdate'); Request = root.lookupType('geyser.SubscribeRequest');
  await initProtobuf(); fs.mkdirSync(output, { recursive: true });
  const plans = options['--capture'] ? [framedCapturePlan(options['--capture'])] : options['--manifest'] ? [capturePlan(options['--manifest'])] : syntheticPlans();
  const results = [];
  for (const plan of plans) results.push(...await Promise.all((options['--languages'] || 'rust,js,go').split(',').map(language => run(plan, language))));
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
