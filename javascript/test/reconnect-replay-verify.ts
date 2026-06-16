import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';
const cfg = require('../test-config');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/*
 * Direct verification of JS reconnect + replay + write-persistence.
 * The stock JS tests detect reconnects via an error callback that never fires
 * (SDK only calls back after 240 attempts), so this harness observes behavior directly:
 *   - slot stream → detect replay rewind (slot goes backwards ~31 after a gap)
 *   - data gaps   → count reconnect windows
 *   - tx filters over time → confirm the last write() persists after a reconnect
 * Correlate with the SDK's stderr "RECONNECT:" lines (captured to a file by the runner).
 */
const RUN_MS = Number(process.env.RUN_MS ?? 110_000);
const WRITE_AT_MS = 10_000;
const REPLAY = process.env.REPLAY !== 'false';   // default true; set REPLAY=false to test replay-disabled

async function main() {
  console.log(`[config] replay=${REPLAY}`);
  const config: LaserstreamConfig = {
    apiKey: cfg.laserstream.apiKey,
    endpoint: cfg.laserstream.endpoint,
    replay: REPLAY,
  };

  let maxSlot = 0;
  let lastDataAt = Date.now();
  let writeAt = 0;
  const gaps: { at: number; sinceWriteMs: number }[] = [];      // reconnect windows (data resumed after >4s silence)
  const rewinds: { fromMax: number; to: number; afterGap: boolean }[] = [];
  const txFilterTimeline: { t: number; filters: string[] }[] = [];
  let inGap = false;

  const stream = await subscribe(
    config,
    {
      transactions: { 'usdc': { vote: false, failed: false, accountInclude: [USDC], accountExclude: [], accountRequired: [] } },
      slots: { 'slots': { filterByCommitment: true, interslotUpdates: false } },
      commitment: CommitmentLevel.PROCESSED,
      accounts: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [],
    },
    async (u: SubscribeUpdate) => {
      const now = Date.now();
      const sinceData = now - lastDataAt;
      if (sinceData > 4000 && lastDataAt > 0) {
        gaps.push({ at: now, sinceWriteMs: writeAt ? now - writeAt : -1 });
        inGap = true;
        console.log(`[gap] data resumed after ${(sinceData / 1000).toFixed(1)}s silence (reconnect window #${gaps.length})`);
      }
      lastDataAt = now;

      if ((u as any).slot) {
        const s = Number((u as any).slot.slot);
        if (s && maxSlot && s < maxSlot - 1) {
          rewinds.push({ fromMax: maxSlot, to: s, afterGap: inGap });
          console.log(`[replay] slot rewound ${maxSlot} -> ${s} (Δ${maxSlot - s})${inGap ? ' after reconnect' : ''}`);
          inGap = false;
        }
        if (s > maxSlot) maxSlot = s;
      }
      if (u.transaction) {
        const filters = u.filters || [];
        txFilterTimeline.push({ t: now, filters });
      }
    },
    (err) => { console.log(`[onError callback] ${err.message}`); }
  );

  await new Promise(r => setTimeout(r, WRITE_AT_MS));
  console.log('[write] replacing USDC filter with USDT...');
  await stream.write({
    transactions: { 'usdt': { vote: false, failed: false, accountInclude: [USDT], accountExclude: [], accountRequired: [] } },
    slots: { 'slots': { filterByCommitment: true, interslotUpdates: false } },
    commitment: CommitmentLevel.PROCESSED,
    accounts: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [],
  });
  writeAt = Date.now();

  await new Promise(r => setTimeout(r, RUN_MS - WRITE_AT_MS));
  stream.cancel();

  // ---- Analysis ----
  const POST_WRITE_GRACE = 8000;
  const beforeWrite = txFilterTimeline.filter(e => writeAt && e.t < writeAt);
  const afterWrite = txFilterTimeline.filter(e => writeAt && e.t > writeAt + POST_WRITE_GRACE);
  const flat = (arr: typeof txFilterTimeline) => new Set(arr.flatMap(e => e.filters));
  const fb = flat(beforeWrite), fa = flat(afterWrite);

  // Reconnects that happened AFTER the write (the persistence-relevant ones)
  const postWriteReconnects = gaps.filter(g => g.sinceWriteMs > POST_WRITE_GRACE).length;
  // tx filters seen only in windows that begin after a post-write reconnect
  const firstPostWriteGapAt = gaps.find(g => g.sinceWriteMs > POST_WRITE_GRACE)?.at ?? 0;
  const afterReconnect = firstPostWriteGapAt
    ? txFilterTimeline.filter(e => e.t > firstPostWriteGapAt + 2000)
    : [];
  const far = flat(afterReconnect);

  console.log('\n================ JS RECONNECT/REPLAY VERIFICATION ================');
  console.log(`run duration:                 ${RUN_MS / 1000}s`);
  console.log(`reconnect windows (gaps>4s):  ${gaps.length}  (post-write: ${postWriteReconnects})`);
  console.log(`replay rewinds observed:      ${rewinds.length}  (after a reconnect: ${rewinds.filter(r => r.afterGap).length})`);
  console.log(`max slot reached:             ${maxSlot}`);
  console.log(`tx filters BEFORE write:      [${[...fb].join(', ') || '(none)'}]`);
  console.log(`tx filters AFTER write+grace: [${[...fa].join(', ') || '(none)'}]`);
  console.log(`tx filters AFTER reconnect:   [${[...far].join(', ') || '(none)'}]`);

  // ---- Verdicts ----
  const checks: [string, boolean][] = [];
  checks.push(['USDC flowed before write', fb.has('usdc')]);
  checks.push(['write replaced USDC->USDT (no USDC after write+grace)', !fa.has('usdc') && fa.has('usdt')]);
  checks.push(['at least one reconnect window observed', gaps.length > 0]);
  if (REPLAY) {
    checks.push(['replay rewind observed after a reconnect', rewinds.some(r => r.afterGap)]);
  } else {
    checks.push(['replay DISABLED: no rewind after reconnect (resumes at live tip)', !rewinds.some(r => r.afterGap)]);
  }
  if (postWriteReconnects > 0) {
    checks.push(['write persisted after reconnect (USDT present, USDC absent)', far.has('usdt') && !far.has('usdc')]);
  } else {
    console.log('NOTE: no post-write reconnect occurred in this run; write-persistence-across-reconnect not exercised.');
  }

  console.log('---------------------------------------------------------------');
  let allPass = true;
  for (const [name, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) allPass = false; }
  console.log('===============================================================');
  console.log(allPass ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(allPass ? 0 : 1);
}

main().catch(e => { console.error('harness error:', e); process.exit(2); });
