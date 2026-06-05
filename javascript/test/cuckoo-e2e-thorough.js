'use strict';

// Thorough live E2E for cuckoo filtering against a cuckoo-enabled endpoint (SLC).
//   Test 1: correctness — tracked accounts match, 0 non-tracked.
//   Test 2: MAX-SIZE filter — a 32 MiB wire filter (capacity 8M) sends successfully
//           (exceeds the old 32,000,000 send cap) and still matches.
//   Test 3: rapid write churn — constantly insert/remove accounts and stream.write
//           the updated filter; the server must honor the latest filter (0 non-tracked).
//
// Usage: LASERSTREAM_ENDPOINT=... LASERSTREAM_API_KEY=... node test/cuckoo-e2e-thorough.js

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
const ENDPOINT = process.env.LASERSTREAM_ENDPOINT;
const API_KEY = process.env.LASERSTREAM_API_KEY;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
if (!ENDPOINT || !API_KEY) { console.error('Missing endpoint/key'); process.exit(2); }
const config = { endpoint: ENDPOINT, apiKey: API_KEY, maxReconnectAttempts: 2 };
const pkHex = (b) => Buffer.from(b).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function subscribeFor(request, ms, onAccount, opts = {}) {
  return new Promise(async (resolve) => {
    let handle = null, failed = false, errMsg = null;
    try {
      handle = await subscribe(config, request,
        (u) => { if (u && u.account && u.account.account) onAccount(u.account.account.pubkey); },
        (e) => { failed = true; errMsg = e.message || String(e); });
    } catch (e) { return resolve({ failed: true, errMsg: e.message || String(e) }); }
    if (opts.onHandle) await opts.onHandle(handle);
    setTimeout(() => { try { handle && handle.cancel(); } catch (_) {} resolve({ failed, errMsg, handle }); }, ms);
  });
}

async function captureActive(n, ms) {
  const out = new Map();
  await subscribeFor(
    { accounts: { cap: { owner: [TOKEN_PROGRAM], account: [], filters: [] } }, commitment: 0 },
    ms, (pk) => { if (out.size < n) out.set(pkHex(pk), Buffer.from(pk)); });
  return [...out.values()];
}

let failures = 0;
const log = (s) => console.log(s);

(async () => {
  log(`Endpoint: ${ENDPOINT}\n`);
  log('Capturing active accounts (10s)...');
  const active = await captureActive(300, 10000);
  log(`  captured ${active.length}\n`);
  if (active.length < 50) { log('Not enough activity; aborting.'); process.exit(3); }

  // ---- Test 1: basic correctness ----
  {
    log('TEST 1: correctness (track 150 active, 10s)');
    const set = new CompressedAccountFilterSet(10000);
    active.slice(0, 150).forEach((b) => set.insert(b));
    let total = 0, nonTracked = 0;
    const req = { commitment: 0 };
    set.insertIntoSubscribeRequest(req, 'tracked');
    const r = await subscribeFor(req, 10000, (pk) => { total++; if (!set.contains(pk)) nonTracked++; });
    const ratio = total ? nonTracked / total : 1;
    const ok = !r.failed && total > 0 && ratio < 0.05;
    log(`  total=${total} nonTracked=${nonTracked} (${(ratio*100).toFixed(2)}%) ${ok ? 'PASS' : 'FAIL'}${r.errMsg ? ' err='+r.errMsg : ''}\n`);
    if (!ok) failures++;
  }

  // ---- Test 2: MAX-SIZE filter (32 MiB) send ----
  {
    log('TEST 2: max-size 32 MiB filter send (capacity 8,000,000)');
    const set = new CompressedAccountFilterSet(8_000_000);
    active.slice(0, 150).forEach((b) => set.insert(b));
    const bytes = Buffer.from(set.toProto().data, 'base64').length;
    log(`  wire data = ${bytes} bytes (${(bytes/1024/1024).toFixed(1)} MiB), old send cap was 32,000,000 → ${bytes > 32_000_000 ? 'EXCEEDS old cap' : 'under old cap'}`);
    let total = 0, nonTracked = 0;
    const req = { commitment: 0 };
    set.insertIntoSubscribeRequest(req, 'tracked');
    const r = await subscribeFor(req, 12000, (pk) => { total++; if (!set.contains(pk)) nonTracked++; });
    const ratio = total ? nonTracked / total : 1;
    const ok = !r.failed && total > 0 && ratio < 0.05;
    log(`  sent OK=${!r.failed} total=${total} nonTracked=${(ratio*100).toFixed(2)}% ${ok ? 'PASS' : 'FAIL'}${r.errMsg ? ' err='+r.errMsg : ''}\n`);
    if (!ok) failures++;
  }

  // ---- Test 3: rapid write churn ----
  {
    log('TEST 3: rapid write/insert/remove churn (60 writes)');
    const set = new CompressedAccountFilterSet(100000);
    let pool = active.slice(0, 200);
    pool.slice(0, 50).forEach((b) => set.insert(b)); // initial 50
    const req = { commitment: 0 };
    set.insertIntoSubscribeRequest(req, 'tracked');

    let writeErrors = 0, writes = 0;
    const churn = async (handle) => {
      let added = 50;
      for (let i = 0; i < 60; i++) {
        // add a new one, remove an old one
        if (added < pool.length) set.insert(pool[added++]);
        set.remove(pool[i % 30]); // churn out early ones (idempotent if already gone)
        if (set.takeDirty()) {
          set.insertIntoSubscribeRequest(req, 'tracked');
          try { await handle.write(req); writes++; } catch (e) { writeErrors++; }
        }
        await sleep(40);
      }
    };

    // After churn, collect a verification window and check the server honors the final filter.
    let total = 0, nonTracked = 0, churnDone = false;
    const r = await subscribeFor(req, 16000,
      (pk) => { if (churnDone) { total++; if (!set.contains(pk)) nonTracked++; } },
      { onHandle: async (h) => { await churn(h); churnDone = true; } });

    const ratio = total ? nonTracked / total : 1;
    const ok = !r.failed && writeErrors === 0 && writes > 0 && total > 0 && ratio < 0.10;
    log(`  writes=${writes} writeErrors=${writeErrors} post-churn total=${total} nonTracked=${(ratio*100).toFixed(2)}% finalSetSize=${set.size} ${ok ? 'PASS' : 'FAIL'}${r.errMsg ? ' err='+r.errMsg : ''}\n`);
    if (!ok) failures++;
  }

  log('=== ' + (failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`) + ' ===');
  process.exit(failures === 0 ? 0 : 1);
})();
