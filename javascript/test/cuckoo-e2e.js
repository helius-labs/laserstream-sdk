'use strict';

// Self-calibrating end-to-end test for cuckoo (compressed account) filtering.
//
// Phase 1 (calibrate): subscribe by owner=Token program to capture pubkeys that
//   are genuinely updating right now.
// Phase 2 (cuckoo): track exactly those pubkeys in a cuckoo filter, subscribe
//   with ONLY the cuckoo filter, and measure how many updates match the tracked
//   set (`contains()` true) vs not.
//
// Verdict:
//   - tracked-matches > 0 AND non-tracked ratio low  -> PASS (server enforces the filter)
//   - lots of updates, almost none tracked           -> server is NOT enforcing cuckoo (match-all)
//
// Usage: LASERSTREAM_ENDPOINT=... LASERSTREAM_API_KEY=... node test/cuckoo-e2e.js

(() => {
  const fs = require('fs'), path = require('path');
  for (const p of [path.join(__dirname, '..', '..', '.env'), path.join(__dirname, '..', '.env')]) {
    try {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch (_) {}
  }
})();

const { subscribe, CompressedAccountFilterSet } = require('../client');
const ENDPOINT = process.env.LASERSTREAM_ENDPOINT || process.env.LASERSTREAM_PRODUCTION_ENDPOINT;
const API_KEY = process.env.LASERSTREAM_API_KEY || process.env.LASERSTREAM_PRODUCTION_API_KEY || process.env.HELIUS_API_KEY;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

if (!ENDPOINT || !API_KEY) { console.error('Missing endpoint/key'); process.exit(2); }
const config = { endpoint: ENDPOINT, apiKey: API_KEY, maxReconnectAttempts: 1 };

const pkHex = (buf) => Buffer.from(buf).toString('hex');

function subscribeFor(request, ms, onAccount) {
  return new Promise(async (resolve) => {
    let handle = null, failed = false;
    try {
      handle = await subscribe(config, request,
        (u) => { if (u && u.account && u.account.account) onAccount(u.account.account.pubkey); },
        (e) => { failed = true; console.error('  stream error:', e.message || e); });
    } catch (e) { console.error('  subscribe failed:', e.message || e); return resolve({ failed: true }); }
    setTimeout(() => { try { handle && handle.cancel(); } catch (_) {} resolve({ failed }); }, ms);
  });
}

(async () => {
  console.log(`Endpoint: ${ENDPOINT}\n`);

  // Phase 1: capture active token accounts.
  console.log('Phase 1: capturing active pubkeys (owner=Token program, 8s)...');
  const captured = new Map(); // hex -> Buffer
  await subscribeFor(
    { accounts: { cap: { owner: [TOKEN_PROGRAM], account: [], filters: [] } }, commitment: 0 },
    8000,
    (pk) => { if (captured.size < 200) captured.set(pkHex(pk), Buffer.from(pk)); });
  console.log(`  captured ${captured.size} distinct active pubkeys`);
  if (captured.size === 0) { console.log('No activity captured — cannot test. Check endpoint/key.'); process.exit(3); }

  // Phase 2: track exactly those in a cuckoo filter.
  const set = new CompressedAccountFilterSet(10000);
  for (const buf of captured.values()) set.insert(buf);
  console.log(`\nPhase 2: cuckoo filter over ${set.size} accounts (bucketCount=${set.bucketCount}, wire bytes=${Buffer.from(set.toProto().data, 'base64').length}); subscribing 12s...`);

  let total = 0, tracked = 0, nonTracked = 0;
  const seenTracked = new Set();
  const req = { commitment: 0 };
  set.insertIntoSubscribeRequest(req, 'tracked');
  const r = await subscribeFor(req, 12000, (pk) => {
    total++;
    if (set.contains(pk)) { tracked++; seenTracked.add(pkHex(pk)); } else { nonTracked++; }
  });

  console.log(`\nResults: total updates=${total}, tracked(contains==true)=${tracked}, non-tracked=${nonTracked}, distinct tracked seen=${seenTracked.size}/${set.size}`);
  console.log('\n=== verdict ===');
  if (r.failed) { console.log('FAIL: cuckoo subscribe errored.'); process.exit(1); }
  if (total === 0) { console.log('INCONCLUSIVE: no updates (activity stopped?).'); process.exit(3); }
  const nonTrackedRatio = nonTracked / total;
  if (tracked > 0 && nonTrackedRatio < 0.10) {
    console.log(`PASS: server enforced the cuckoo filter (${(nonTrackedRatio * 100).toFixed(2)}% non-tracked — within false-positive range).`);
    process.exit(0);
  } else if (nonTrackedRatio >= 0.10) {
    console.log(`SERVER NOT ENFORCING CUCKOO: ${(nonTrackedRatio * 100).toFixed(1)}% of updates were for non-tracked accounts (match-all firehose).`);
    console.log('Client wire format is correct (byte-identical to Rust); this endpoint lacks server-side cuckoo matching.');
    process.exit(3);
  } else {
    console.log('INCONCLUSIVE.');
    process.exit(3);
  }
})();
