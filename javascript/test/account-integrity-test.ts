import { subscribe, CommitmentLevel, LaserstreamConfig } from '../src';
import Client from '@triton-one/yellowstone-grpc';
import bs58 from 'bs58';

const ACCOUNTS = [
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // Pump AMM program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token program
];

const laserstreamCfg: LaserstreamConfig = {
  apiKey: '',
  endpoint: ''
};

//Yellowstone node for comparing with Laserstream
const yellowstoneCfg = {
  endpoint: '',
  xToken: ''
} as const;

const subscribeReq: any = {
  accounts: {
    tracked: {
      account: ACCOUNTS,
      owner: [],
      filters: [],
    },
  },
  accountsDataSlice: [],
  commitment: CommitmentLevel.CONFIRMED,
  slots: {},
  transactions: {},
  transactionsStatus: {},
  blocks: {},
  blocksMeta: {},
  entry: {},
};

// ---------- STATE ----------
interface Seen { slotLS?: string; slotYS?: string }
const state = new Map<string, Seen>();

// Store the LATEST full account update objects so that we can do a deep comparison every
// integrity-check interval.  Keyed by base-58 account pubkey.
const latestLaserstreamUpdate = new Map<string, any>();
const latestYellowstoneUpdate = new Map<string, any>();

let newLS = 0;
let newYS = 0;
let errLS = 0;
let errYS = 0;

// number of slots we allow Yellowstone to lag behind Laserstream before flagging a mismatch.
const SLOT_LAG = 3000;

function isAccountUpdate(u: any): u is { account: any } {
  return typeof u.account === 'object' && u.account !== null;
}

function extractKeyAndSlot(u: any): { key: string | null; slot: string | null } {
  if (!isAccountUpdate(u)) return { key: null, slot: null };
  const info = u.account.account;
  if (!info) return { key: null, slot: null };
  const keyBuf: Uint8Array | undefined = info.pubkey as Uint8Array | undefined;
  if (!keyBuf) return { key: null, slot: null };
  return { key: bs58.encode(Buffer.from(keyBuf)), slot: u.account.slot ?? null };
}

function maybePrint(key: string) {
  const rec = state.get(key);
  if (rec?.slotLS && rec?.slotYS) {
    console.log(`MATCH acct=${key}  LS_slot=${rec.slotLS}  YS_slot=${rec.slotYS}`);
    state.delete(key);
  }
}

// Helper: clone and normalise an account update so that volatile fields (e.g. write_version)
// do not cause false mismatches.
function normaliseAccountUpdate(u: any): any {
  if (!isAccountUpdate(u)) return u;
  const clone = JSON.parse(JSON.stringify(u));
  if (clone?.account?.account) {
    // Reset / delete the write_version so it doesn't affect equality checks.
    if (clone.account.account.write_version !== undefined) clone.account.account.write_version = 0;
    if (clone.account.account.writeVersion !== undefined) clone.account.account.writeVersion = 0;
  }
  return clone;
}

async function startLaserstream() {
  await subscribe(
    laserstreamCfg,
    subscribeReq,
    (u) => {
      const { key, slot } = extractKeyAndSlot(u);
      if (!key) return;
      const entry = state.get(key) || {};
      entry.slotLS = slot ?? 'unknown';
      state.set(key, entry);
      // keep the latest FULL update for later comparison
      latestLaserstreamUpdate.set(key, normaliseAccountUpdate(u));
      newLS += 1;
      maybePrint(key);
    },
    (err) => { errLS += 1; console.error('LASERSTREAM error:', err); },
  );
}

async function startYellowstone() {
  const client = new Client(yellowstoneCfg.endpoint, yellowstoneCfg.xToken, {
    'grpc.max_receive_message_length': 64 * 1024 * 1024,
  });
  const stream = await client.subscribe();
  await new Promise<void>((resolve, reject) => {
    stream.write(subscribeReq, (e: any) => (e ? reject(e) : resolve()));
  });
  stream.on('data', (u: any) => {
    const { key, slot } = extractKeyAndSlot(u);
    if (!key) return;
    const entry = state.get(key) || {};
    entry.slotYS = slot ?? 'unknown';
    state.set(key, entry);
    latestYellowstoneUpdate.set(key, normaliseAccountUpdate(u));
    newYS += 1;
    maybePrint(key);
  });
  stream.on('error', (e: Error) => { errYS += 1; console.error('YELLOWSTONE error:', e); });
  stream.on('end', () => { errYS += 1; console.error('YELLOWSTONE stream ended'); });
}

const INTERVAL = 30_000;
setInterval(() => {
  const now = new Date().toISOString();
  console.log(`[${now}] laserstream+${newLS}  yellowstone+${newYS}  LS_errors:${errLS}  YS_errors:${errYS}`);

  // --------- mismatch detection ----------
  const allKeys = new Set<string>([...latestLaserstreamUpdate.keys(), ...latestYellowstoneUpdate.keys()]);
  const missingPrimary: string[] = [];
  const missingReference: string[] = [];
  const mismatched: string[] = [];

  function slotNum(val: string | undefined): number | null {
    if (!val) return null;
    const n = Number(val);
    return isNaN(n) ? null : n;
  }

  for (const k of allKeys) {
    const a = latestLaserstreamUpdate.get(k);
    const b = latestYellowstoneUpdate.get(k);
    const slots = state.get(k) || {};
    const lsSlot = slotNum(slots.slotLS);
    const ysSlot = slotNum(slots.slotYS);

    if (!a) {
      // missing from Laserstream – should never happen in our test
      missingPrimary.push(k);
      continue;
    }

    if (!b) {
      // Yellowstone hasn't produced an update yet; give it SLOT_LAG slack
      if (lsSlot !== null && ysSlot !== null && lsSlot - ysSlot > SLOT_LAG) {
        missingReference.push(k);
      }
      continue;
    }

    // Compare only when both streams have an update for the SAME slot.
    if (lsSlot === null || ysSlot === null) continue;

    if (lsSlot !== ysSlot) {
      // wait until Yellowstone catches up exactly to the Laserstream slot before comparing
      continue;
    }

    if (JSON.stringify(a) !== JSON.stringify(b)) {
      mismatched.push(k);
    }
  }

  if (missingPrimary.length || missingReference.length || mismatched.length) {
    console.error(`[INTEGRITY] account_mismatch  missing Laserstream=${missingPrimary.length} missing Yellowstone=${missingReference.length} mismatched=${mismatched.length}`);
    if (missingPrimary.length) {
      for (const k of missingPrimary) console.error(`ACCOUNT MISSING IN LASERSTREAM ${k}`);
    }
    if (missingReference.length) {
      for (const k of missingReference) console.error(`ACCOUNT MISSING IN YELLOWSTONE ${k}`);
    }
    if (mismatched.length) {
      for (const k of mismatched) console.error(`ACCOUNT PAYLOAD MISMATCH ${k}`);
    }
  }

  // ---------- reset counters for next window ----------
  newLS = 0;
  newYS = 0;
}, INTERVAL);

(async () => {
  console.log('Starting account integrity test…');
  await Promise.all([startLaserstream(), startYellowstone()]);
  await new Promise(() => {});
})(); 