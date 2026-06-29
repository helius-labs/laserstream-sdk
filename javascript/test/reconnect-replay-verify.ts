import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';
const cfg = require('../test-config');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Observes reconnect (data gap), replay (processed slot rewind ~31) and that a
// write() persists across reconnects — the stock tests can't see reconnects
// since the SDK only surfaces errors after max attempts. Needs the chaos proxy.
const RUN_MS = Number(process.env.RUN_MS ?? 90_000);   // run window after the write()
const REPLAY = process.env.REPLAY !== 'false';

async function main() {
  const config: LaserstreamConfig = { apiKey: cfg.laserstream.apiKey, endpoint: cfg.laserstream.endpoint, replay: REPLAY };
  const slotsMap = { slots: { filterByCommitment: true, interslotUpdates: false } };
  const req = (mint: string, id: string) => ({
    transactions: { [id]: { vote: false, failed: false, accountInclude: [mint], accountExclude: [], accountRequired: [] } },
    slots: slotsMap, commitment: CommitmentLevel.PROCESSED,
    accounts: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [],
  });

  let maxSlot = 0, last = Date.now(), writeAt = 0, gaps = 0, rewinds = 0, inGap = false, firstGapAfterWrite = 0;
  const txAt: { t: number; f: string[] }[] = [];

  const stream = await subscribe(config, req(USDC, 'usdc'), async (u: SubscribeUpdate) => {
    const now = Date.now();
    if (now - last > 4000) {
      gaps++; inGap = true;
      if (writeAt && now - writeAt > 8000 && !firstGapAfterWrite) firstGapAfterWrite = now;
      console.log(`[gap] reconnect window #${gaps}`);
    }
    last = now;
    const s = (u as any).slot ? Number((u as any).slot.slot) : 0;
    if (s) {
      if (maxSlot && s < maxSlot - 1 && inGap) { rewinds++; console.log(`[replay] rewind ${maxSlot}->${s} (Δ${maxSlot - s})`); inGap = false; }
      if (s > maxSlot) maxSlot = s;
    }
    if (u.transaction) txAt.push({ t: now, f: u.filters || [] });
  }, () => {});

  // write only once data is flowing (live connection) so it isn't lost mid-disconnect;
  // a later reconnect then exercises persistence
  for (let i = 0; i < 80 && txAt.length === 0; i++) await new Promise(r => setTimeout(r, 250));
  await new Promise(r => setTimeout(r, 2000));
  console.log('[write] USDC -> USDT');
  await stream.write(req(USDT, 'usdt'));
  writeAt = Date.now();

  await new Promise(r => setTimeout(r, RUN_MS));
  stream.cancel();

  const set = (pred: (t: number) => boolean) => new Set(txAt.filter(e => pred(e.t)).flatMap(e => e.f));
  const before = set(t => t < writeAt);
  const after = set(t => t > writeAt + 8000);
  const afterRecon = firstGapAfterWrite ? set(t => t > firstGapAfterWrite + 2000) : new Set<string>();

  const checks: [string, boolean][] = [
    ['USDC before write', before.has('usdc')],
    ['write replaced USDC->USDT', !after.has('usdc') && after.has('usdt')],
    ['reconnect observed', gaps > 0],
    [REPLAY ? 'replay rewind after reconnect' : 'no rewind (replay off)', REPLAY ? rewinds > 0 : rewinds === 0],
  ];
  if (firstGapAfterWrite) checks.push(['write persisted after reconnect', afterRecon.has('usdt') && !afterRecon.has('usdc')]);

  console.log(`\nreplay=${REPLAY} reconnects=${gaps} rewinds=${rewinds} maxSlot=${maxSlot}`);
  let ok = true;
  for (const [n, p] of checks) { console.log(`  ${p ? 'PASS' : 'FAIL'}  ${n}`); ok = ok && p; }
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(2); });
