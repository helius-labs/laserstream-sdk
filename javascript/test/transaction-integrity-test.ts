import { subscribe, CommitmentLevel, LaserstreamConfig } from '../src';
import Client from '@triton-one/yellowstone-grpc';

import bs58 from 'bs58';

type Seen = { slotA?: string; slotB?: string };
const seen = new Map<string, Seen>();

async function main() {

  const PUMP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

  // Laserstream stream (under test)
  const config: LaserstreamConfig = {
    apiKey: '',
    endpoint: ''
  };


  const subscriptionRequest: any = {
    transactions: {
      client: {
        accountInclude: [PUMP],
        accountExclude: [],
        accountRequired: [],
        vote: false,
        failed: false
      }
    },
    commitment: CommitmentLevel.CONFIRMED,
    accounts: {},
    slots: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  // Yellowstone node for comparing with Laserstream
  const yellowstoneConfig = {
    endpoint: '',
    xToken: ''
  } as const;


  const gotLS = new Set<string>(); // laserstream signatures
  const gotYS = new Set<string>(); // yellowstone signatures

  // Store latest slot for each signature so we can give more context when reporting mismatches.
  const slotLS = new Map<string, string>();
  const slotYS = new Map<string, string>();
  let newLS = 0;
  let newYS = 0;
  let errLS = 0;
  let errYS = 0;

  // --- per-slot tracking to avoid premature mismatch logging ---
  const lsBySlot = new Map<number, Set<string>>();
  const ysBySlot = new Map<number, Set<string>>();
  let maxSlotLS = 0;
  let maxSlotYS = 0;
  const SLOT_LAG = 3000; // number of slots to wait before declaring a slot closed

  const INTEGRITY_CHECK_INTERVAL_MS = 30_000; // 30 seconds
  setInterval(async () => {
    const readySlot = Math.min(maxSlotLS, maxSlotYS) - SLOT_LAG; // wait additional slots for late txs

    const slotsToProcess = new Set<number>();
    for (const s of lsBySlot.keys()) if (s <= readySlot) slotsToProcess.add(s);
    for (const s of ysBySlot.keys()) if (s <= readySlot) slotsToProcess.add(s);

    let totalMissingLS = 0;
    let totalMissingYS = 0;

    for (const slot of slotsToProcess) {
      const setLS = lsBySlot.get(slot) ?? new Set<string>();
      const setYS = ysBySlot.get(slot) ?? new Set<string>();

      const missingLS = new Set<string>(); // present in YS but not LS
      const missingYS = new Set<string>(); // present in LS but not YS

      for (const sig of setYS) if (!setLS.has(sig)) missingLS.add(sig);
      for (const sig of setLS) if (!setYS.has(sig)) missingYS.add(sig);

      if (missingLS.size || missingYS.size) {
        console.error(`[INTEGRITY] transaction_mismatch slot=${slot}  missing Laserstream=${missingLS.size} missing Yellowstone=${missingYS.size}`);
        for (const sig of missingLS) console.error(`SIGNATURE MISSING IN LASERSTREAM ${sig}  (YS_slot=${slot})`);
        for (const sig of missingYS) console.error(`SIGNATURE MISSING IN YELLOWSTONE ${sig}  (LS_slot=${slot})`);
      }

      totalMissingLS += missingLS.size;
      totalMissingYS += missingYS.size;

      lsBySlot.delete(slot);
      ysBySlot.delete(slot);
    }

    const now = new Date().toISOString();
    console.log(`[${now}] laserstream+${newLS}  yellowstone+${newYS}  processedSlots:${slotsToProcess.size} missingLS:${totalMissingLS} missingYS:${totalMissingYS}  LS_errors:${errLS}  YS_errors:${errYS}`);

    // reset counters (keep global sets for history but clear new counters)
    newLS = 0;
    newYS = 0;
  }, INTEGRITY_CHECK_INTERVAL_MS);

  console.log('Starting transaction integrity test…');

  // Helper: narrow update to transaction variant – we work with `any` here to avoid heavy protobuf typings(idk how to do this better)
  function isTransactionUpdate(update: any): update is { transaction: any } {
    return typeof (update as any).transaction === 'object' && (update as any).transaction !== null;
  }

  // Helper: reliably extract a base-58 signature string from a transaction update
  function extractSigAndSlot(update: any): {sig: string | null; slot: string | null} {
    if (!isTransactionUpdate(update)) return {sig: null, slot: null} as any;

    const info: any | undefined = (update.transaction as any)?.transaction;

    if (!info) return {sig: null, slot: null} as any;

    const rawSig: Uint8Array | undefined = (info.signature ?? info.transaction?.signature) as Uint8Array | undefined;
    if (!rawSig) return {sig: null, slot: null} as any;

    const sigStr = bs58.encode(Buffer.from(rawSig));
    const slotStr = (update.transaction as any)?.slot ?? null;
    return {sig: sigStr, slot: slotStr};
  }

  const statusMap = new Map<string, {slotLS?: string; slotYS?: string}>();

  function maybePrint(sig: string) {
    const entry = statusMap.get(sig);
    if (entry && entry.slotLS && entry.slotYS) {
      console.log(`MATCH ${sig}  LS_slot=${entry.slotLS}  YS_slot=${entry.slotYS}`);
      statusMap.delete(sig);
    }
  }

  // ---------- helper to start a stream ----------
  const startLaserstreamStream = async (
    cfg: LaserstreamConfig,
    onSig: (sig: string) => void,
    label: string
  ) => {
    await subscribe(
      cfg,
      subscriptionRequest,
      (u) => {
        const {sig, slot} = extractSigAndSlot(u);
        if (!sig || !slot) return;
        onSig(sig);

        slotLS.set(sig, slot);

        const slotNum = Number(slot);
        if (!lsBySlot.has(slotNum)) lsBySlot.set(slotNum, new Set());
        lsBySlot.get(slotNum)!.add(sig);
        if (slotNum > maxSlotLS) maxSlotLS = slotNum;

        const entry: any = statusMap.get(sig) || {};
        entry.slotLS = slot ?? 'unknown';
        statusMap.set(sig, entry);
        maybePrint(sig);
      },
      (err) => {
        errLS += 1;
        console.error(`${label} error:`, err);
      }
    );
  };

  // Reference stream using raw Yellowstone gRPC client
  const startYellowstoneStream = async () => {
    const client = new Client(yellowstoneConfig.endpoint, yellowstoneConfig.xToken, {
      "grpc.max_receive_message_length": 64 * 1024 * 1024,
    });

    const stream = await client.subscribe();

    // send the request
    await new Promise<void>((resolve, reject) => {
      stream.write(subscriptionRequest, (err: Error | null | undefined) => {
        if (err == null) resolve();
        else reject(err);
      });
    });

    stream.on('data', (u: any) => {
      const {sig, slot} = extractSigAndSlot(u);
      if (!sig || !slot) return;
      gotYS.add(sig);
      newYS += 1;

      slotYS.set(sig, slot);

      const slotNum = Number(slot);
      if (!ysBySlot.has(slotNum)) ysBySlot.set(slotNum, new Set());
      ysBySlot.get(slotNum)!.add(sig);
      if (slotNum > maxSlotYS) maxSlotYS = slotNum;

      const entry: any = statusMap.get(sig) || {};
      entry.slotYS = slot ?? 'unknown';
      statusMap.set(sig, entry);
      maybePrint(sig);
    });

    stream.on('error', (e: Error) => { errYS += 1; console.error('YELLOWSTONE stream error:', e); });
    stream.on('end', () => { errYS += 1; console.error('YELLOWSTONE stream ended'); });
  };

  // Start both streams concurrently
  await Promise.all([
    startLaserstreamStream(config, (sig) => {
      gotLS.add(sig);
      newLS += 1;
    }, 'LASERSTREAM'),
    startYellowstoneStream(),
  ]);

  // Keep the script alive indefinitely so we can continue to receive updates.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Unhandled error in main:', err);
  process.exit(1);
});