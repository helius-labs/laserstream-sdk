'use strict';

/**
 * Cuckoo (compressed account) filter builder for LaserStream.
 *
 * Clients tracking large pubkey sets can send a compact probabilistic filter
 * (~3 bytes/account) instead of an explicit pubkey list (32 bytes/account).
 * No false negatives; <1% false positives — re-check locally with `contains`.
 *
 * This is a byte-for-byte port of the Rust `CompressedAccountFilterSet`
 * (laserstream-core-proto `cuckoo` module). The wire contract — SipHash-2-4
 * hashing, fingerprint/index derivation, partial-key cuckoo insertion, and the
 * little-endian u16 serialization — MUST match the Rust implementation exactly,
 * or the server silently drops tracked accounts. Validated against Rust-generated
 * test vectors (see test/fixtures/cuckoo-vectors.json).
 */

// ---- Wire constants (must match laserstream-core-proto cuckoo/constants.rs) ----
const ENTRIES_PER_BUCKET = 4;
const FINGERPRINT_BITS = 16;
const LOAD_FACTOR = 0.95;
const MAX_KICKS = 500;
// ASCII "yllwstn!". proto3 defaults an unset u64 to 0, which would silently break
// matching — the seed is ALWAYS serialized so this default can never leak as 0.
const DEFAULT_HASH_SEED = 0x796c6c7773746e21n;
const HASH_ALGORITHM_SIP_HASH = 0;

const MASK64 = 0xffffffffffffffffn;

// ---- SipHash-2-4 (matches the `siphasher` crate's SipHasher24) ----

function rotl(x, b) {
  return ((x << b) | (x >> (64n - b))) & MASK64;
}

function sipround(v) {
  let [v0, v1, v2, v3] = v;
  v0 = (v0 + v1) & MASK64; v1 = rotl(v1, 13n); v1 ^= v0; v0 = rotl(v0, 32n);
  v2 = (v2 + v3) & MASK64; v3 = rotl(v3, 16n); v3 ^= v2;
  v0 = (v0 + v3) & MASK64; v3 = rotl(v3, 21n); v3 ^= v0;
  v2 = (v2 + v1) & MASK64; v1 = rotl(v1, 17n); v1 ^= v2; v2 = rotl(v2, 32n);
  v[0] = v0; v[1] = v1; v[2] = v2; v[3] = v3;
}

/**
 * SipHash-2-4 over `data` (Uint8Array) with 64-bit keys k0, k1 (BigInt).
 * Returns the 64-bit digest as a BigInt.
 */
function siphash24(k0, k1, data) {
  const v = [
    k0 ^ 0x736f6d6570736575n,
    k1 ^ 0x646f72616e646f6dn,
    k0 ^ 0x6c7967656e657261n,
    k1 ^ 0x7465646279746573n,
  ];

  const len = data.length;
  const end = len - (len % 8);

  for (let i = 0; i < end; i += 8) {
    let m = 0n;
    for (let j = 0; j < 8; j++) m |= BigInt(data[i + j]) << BigInt(8 * j);
    v[3] ^= m;
    sipround(v); // c = 2
    sipround(v);
    v[0] ^= m;
  }

  // Final block: trailing bytes plus the input length in the top byte.
  let b = BigInt(len & 0xff) << 56n;
  for (let j = 0; j < len % 8; j++) b |= BigInt(data[end + j]) << BigInt(8 * j);
  v[3] ^= b;
  sipround(v); // c = 2
  sipround(v);
  v[0] ^= b;

  v[2] ^= 0xffn;
  sipround(v); // d = 4
  sipround(v);
  sipround(v);
  sipround(v);

  return (v[0] ^ v[1] ^ v[2] ^ v[3]) & MASK64;
}

// ---- helpers ----

function nextPowerOfTwo(n) {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = (() => {
  const m = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) m[BASE58_ALPHABET[i]] = i;
  return m;
})();

function base58Decode(str) {
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const val = BASE58_MAP[str[i]];
    if (val === undefined) throw new Error(`Invalid base58 character '${str[i]}'`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // leading zeros
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

/** Normalize a pubkey (base58 string | Uint8Array | Buffer | number[]) to 32 bytes. */
function toPubkeyBytes(pubkey) {
  let bytes;
  if (typeof pubkey === 'string') {
    bytes = base58Decode(pubkey);
  } else if (pubkey instanceof Uint8Array) {
    bytes = pubkey;
  } else if (Array.isArray(pubkey)) {
    bytes = Uint8Array.from(pubkey);
  } else if (pubkey && typeof pubkey.toBytes === 'function') {
    // e.g. @solana/web3.js PublicKey
    bytes = pubkey.toBytes();
  } else {
    throw new Error('pubkey must be a base58 string, Uint8Array, Buffer, or number[]');
  }
  if (bytes.length !== 32) {
    throw new Error(`pubkey must be 32 bytes, got ${bytes.length}`);
  }
  return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
}

function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** Thrown when the filter is saturated — rebuild with a larger capacity. */
class TableFullError extends Error {
  constructor() {
    super(`cuckoo table full after ${MAX_KICKS} kicks`);
    this.name = 'TableFullError';
  }
}

/**
 * Safe, tracked builder for a cuckoo account filter.
 *
 * Keeps an exact `Set` of pubkeys alongside the probabilistic fingerprint table:
 * `contains` reads the Set (exact, no false positives), and `remove` only touches
 * the table when the key genuinely exists (guards against fingerprint-collision
 * false negatives). The cuckoo table is used only on the wire.
 */
class CompressedAccountFilterSet {
  /**
   * @param {number} capacity max number of pubkeys to track (sizes the table).
   * @param {bigint} [hashSeed] override the wire hash seed (default "yllwstn!").
   */
  constructor(capacity, hashSeed = DEFAULT_HASH_SEED) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new Error('capacity must be a non-negative integer');
    }
    const bucketsNeeded = Math.ceil(capacity / (LOAD_FACTOR * ENTRIES_PER_BUCKET));
    this.bucketCount = Math.max(1, nextPowerOfTwo(bucketsNeeded));
    this.buckets = new Uint16Array(this.bucketCount * ENTRIES_PER_BUCKET); // 0 = empty slot
    this.items = new Set(); // hex pubkey strings — exact membership
    this.hashSeed = BigInt(hashSeed) & MASK64;
    this._k0 = this.hashSeed;
    this._k1 = rotl(this.hashSeed, 32n); // wire contract: k1 = seed.rotate_left(32)
    this.dirty = false;
  }

  _hashBytes(bytes) {
    // Rust hashes a pubkey as `[u8; 32]`, whose `Hash` impl writes an 8-byte
    // little-endian length prefix (usize) before the bytes. We must replicate
    // that exactly or the digest diverges.
    const buf = new Uint8Array(8 + bytes.length);
    let len = bytes.length;
    for (let j = 0; j < 8; j++) {
      buf[j] = len & 0xff;
      len = Math.floor(len / 256);
    }
    buf.set(bytes, 8);
    return siphash24(this._k0, this._k1, buf);
  }

  _hashFingerprint(fp) {
    // u16 hashed as its 2 little-endian bytes (Rust `write_u16` — a primitive,
    // so NO length prefix, unlike the array above).
    return siphash24(this._k0, this._k1, Uint8Array.of(fp & 0xff, (fp >> 8) & 0xff));
  }

  _fingerprint(h) {
    // upper 16 bits, forced non-zero (0 = empty slot).
    return Number((h >> 32n) & 0xffffn) || 1;
  }

  _index(x) {
    return Number(x & BigInt(this.bucketCount - 1));
  }

  _tryInsertToBucket(index, fp) {
    const base = index * ENTRIES_PER_BUCKET;
    for (let s = 0; s < ENTRIES_PER_BUCKET; s++) {
      if (this.buckets[base + s] === 0) {
        this.buckets[base + s] = fp;
        return true;
      }
    }
    return false;
  }

  _tryRemoveFromBucket(index, fp) {
    const base = index * ENTRIES_PER_BUCKET;
    for (let s = 0; s < ENTRIES_PER_BUCKET; s++) {
      if (this.buckets[base + s] === fp) {
        this.buckets[base + s] = 0;
        return true;
      }
    }
    return false;
  }

  // Partial-key cuckoo insertion — mirrors filter.rs `insert`.
  _filterInsert(bytes) {
    const h = this._hashBytes(bytes);
    let fp = this._fingerprint(h);
    const i1 = this._index(h);
    const i2 = i1 ^ this._index(this._hashFingerprint(fp));

    if (this._tryInsertToBucket(i1, fp)) return;
    if (this._tryInsertToBucket(i2, fp)) return;

    let i = i1;
    for (let n = 0; n < MAX_KICKS; n++) {
      const slot = (n + fp) % ENTRIES_PER_BUCKET;
      const base = i * ENTRIES_PER_BUCKET;
      const evicted = this.buckets[base + slot];
      this.buckets[base + slot] = fp;
      fp = evicted;

      i ^= this._index(this._hashFingerprint(fp));
      if (this._tryInsertToBucket(i, fp)) return;
    }
    throw new TableFullError();
  }

  // Table-level membership (mirrors filter.rs `contains`). Production uses the
  // exact Set via `contains()`; this exists to prove the wire table itself has
  // no false negatives. May report false positives (that's the point).
  _filterContains(bytes) {
    const h = this._hashBytes(bytes);
    const fp = this._fingerprint(h);
    const i1 = this._index(h);
    const i2 = i1 ^ this._index(this._hashFingerprint(fp));
    const b1 = i1 * ENTRIES_PER_BUCKET;
    const b2 = i2 * ENTRIES_PER_BUCKET;
    for (let s = 0; s < ENTRIES_PER_BUCKET; s++) {
      if (this.buckets[b1 + s] === fp || this.buckets[b2 + s] === fp) return true;
    }
    return false;
  }

  _filterRemove(bytes) {
    const h = this._hashBytes(bytes);
    const fp = this._fingerprint(h);
    const i1 = this._index(h);
    const i2 = i1 ^ this._index(this._hashFingerprint(fp));
    return this._tryRemoveFromBucket(i1, fp) || this._tryRemoveFromBucket(i2, fp);
  }

  /**
   * Insert a pubkey. Returns true if newly added, false if already present.
   * Throws {@link TableFullError} if the filter is saturated (state unchanged).
   * @param {string|Uint8Array|Buffer|number[]} pubkey
   */
  insert(pubkey) {
    const bytes = toPubkeyBytes(pubkey);
    const hex = toHex(bytes);
    if (this.items.has(hex)) return false;
    this._filterInsert(bytes); // may throw before we mutate items
    this.items.add(hex);
    this.dirty = true;
    return true;
  }

  /** Remove a pubkey; returns whether it was present. Safe (guarded by the Set). */
  remove(pubkey) {
    const bytes = toPubkeyBytes(pubkey);
    const hex = toHex(bytes);
    if (!this.items.has(hex)) return false;
    this.items.delete(hex);
    this._filterRemove(bytes);
    this.dirty = true;
    return true;
  }

  /** Exact membership (from the Set, no false positives). */
  contains(pubkey) {
    return this.items.has(toHex(toPubkeyBytes(pubkey)));
  }

  get size() {
    return this.items.size;
  }

  isEmpty() {
    return this.items.size === 0;
  }

  /** True if mutated since the last takeDirty()/insertIntoSubscribeRequest(). */
  isDirty() {
    return this.dirty;
  }

  /** Returns the dirty flag and clears it. true → rebuild and re-send. */
  takeDirty() {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  /** Iterate tracked pubkeys as hex strings (arbitrary order). */
  keys() {
    return this.items.values();
  }

  /**
   * Serialize to the wire `CuckooFilter` shape consumed by the native layer.
   * `data` is base64 (LE u16 fingerprints, row-major); `hashSeed` is a decimal
   * string (u64 exceeds JS safe-integer range).
   */
  toProto() {
    const data = Buffer.allocUnsafe(this.buckets.length * 2);
    for (let i = 0; i < this.buckets.length; i++) {
      data.writeUInt16LE(this.buckets[i], i * 2);
    }
    return {
      data: data.toString('base64'),
      bucketCount: this.bucketCount,
      entriesPerBucket: ENTRIES_PER_BUCKET,
      fingerprintBits: FINGERPRINT_BITS,
      hashSeed: this.hashSeed.toString(),
      hashAlgorithm: HASH_ALGORITHM_SIP_HASH,
    };
  }

  /** Raw serialized filter bytes (LE u16 fingerprints), for tests/inspection. */
  toBytes() {
    const data = Buffer.allocUnsafe(this.buckets.length * 2);
    for (let i = 0; i < this.buckets.length; i++) {
      data.writeUInt16LE(this.buckets[i], i * 2);
    }
    return data;
  }

  /** An account filter carrying only this cuckoo filter (no account/owner list). */
  toAccountFilter() {
    return {
      account: [],
      owner: [],
      filters: [],
      cuckooAccountsFilter: this.toProto(),
    };
  }

  /** A transaction filter carrying only this cuckoo filter (no accountInclude list). */
  toTransactionFilter() {
    return {
      accountInclude: [],
      accountExclude: [],
      accountRequired: [],
      cuckooAccountInclude: this.toProto(),
    };
  }

  /**
   * Insert this filter into `request.accounts[name]` (replacing any existing
   * entry, preserving others) and clear the dirty flag. Re-send the request on
   * the SAME stream via `stream.write(request)` after mutations.
   */
  insertIntoSubscribeRequest(request, name) {
    if (!request.accounts) request.accounts = {};
    request.accounts[name] = this.toAccountFilter();
    this.dirty = false;
    return request;
  }
}

module.exports = {
  CompressedAccountFilterSet,
  TableFullError,
  DEFAULT_HASH_SEED,
  ENTRIES_PER_BUCKET,
  FINGERPRINT_BITS,
};
