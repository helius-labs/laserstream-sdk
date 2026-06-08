'use strict';

// Cross-language conformance test: the JS cuckoo port MUST reproduce the
// Rust-generated fixtures byte-for-byte, or the server silently drops accounts.
//
// Run: node test/cuckoo-vectors.test.js

const assert = require('assert');
const {
  CompressedAccountFilterSet,
  DEFAULT_HASH_SEED,
} = require('../cuckoo');
const vectors = require('./fixtures/cuckoo-vectors.json');

// Must match the Rust generator: pk(i)[j] = (i*31 + j*7) & 0xff
function pubkey(i) {
  const b = new Uint8Array(32);
  for (let j = 0; j < 32; j++) b[j] = (i * 31 + j * 7) & 0xff;
  return b;
}

function hex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('cuckoo cross-language vectors:');

check('default hash seed matches Rust DEFAULT_HASH_SEED', () => {
  assert.strictEqual(DEFAULT_HASH_SEED.toString(), vectors.hashSeed);
});

// Build the filter exactly as the Rust generator did (same ordered inserts).
const set = new CompressedAccountFilterSet(vectors.capacity);
for (let i = 0; i < vectors.insertCount; i++) {
  set.insert(pubkey(i));
}

check('bucketCount matches', () => {
  assert.strictEqual(set.bucketCount, vectors.bucketCount);
});

check('serialized seed matches', () => {
  assert.strictEqual(set.hashSeed.toString(), vectors.hashSeed);
});

check('serialized data is byte-identical to Rust', () => {
  const jsHex = set.toBytes().toString('hex');
  assert.strictEqual(jsHex.length, vectors.dataHex.length, 'data length differs');
  assert.strictEqual(jsHex, vectors.dataHex, 'data bytes differ');
});

check('toProto() geometry + base64 data match', () => {
  const p = set.toProto();
  assert.strictEqual(p.bucketCount, vectors.bucketCount);
  assert.strictEqual(p.entriesPerBucket, vectors.entriesPerBucket);
  assert.strictEqual(p.fingerprintBits, vectors.fingerprintBits);
  assert.strictEqual(p.hashAlgorithm, vectors.hashAlgorithm);
  assert.strictEqual(p.hashSeed, vectors.hashSeed);
  assert.strictEqual(Buffer.from(p.data, 'base64').toString('hex'), vectors.dataHex);
});

check('per-probe (fingerprint, i1, i2) match Rust', () => {
  for (const probe of vectors.probes) {
    const bytes = pubkey(probe.index);
    // hex check guards the pubkey formula itself
    assert.strictEqual(hex(bytes), probe.pubkeyHex,
      `pubkey(${probe.index}) bytes differ`);
    const h = set._hashBytes(bytes);
    const fp = set._fingerprint(h);
    const i1 = set._index(h);
    const i2 = i1 ^ set._index(set._hashFingerprint(fp));
    assert.strictEqual(fp, probe.fingerprint, `fingerprint mismatch idx ${probe.index}`);
    assert.strictEqual(i1, probe.i1, `i1 mismatch idx ${probe.index}`);
    assert.strictEqual(i2, probe.i2, `i2 mismatch idx ${probe.index}`);
  }
});

check('membership: 0 false negatives for inserted keys', () => {
  for (let i = 0; i < vectors.insertCount; i++) {
    assert.ok(set.contains(pubkey(i)), `inserted key ${i} not found`);
  }
});

check('membership: held-out keys are absent (exact Set)', () => {
  // The inserted formula has byte[1]-byte[0] === 7 (mod 256); use 97 here so
  // these keys can never coincide with an inserted one.
  const heldOut = (i) => {
    const b = new Uint8Array(32);
    for (let j = 0; j < 32; j++) b[j] = (i * 131 + j * 97 + 13) & 0xff;
    return b;
  };
  for (let i = 0; i < 5000; i++) {
    assert.ok(!set.contains(heldOut(i)), `held-out key ${i} wrongly present`);
  }
});

check('validation (§1.7): data.len == bucketCount*4*2 and power-of-two', () => {
  const p = set.toProto();
  const dataLen = Buffer.from(p.data, 'base64').length;
  assert.strictEqual(dataLen, p.bucketCount * 4 * 2);
  assert.ok((p.bucketCount & (p.bucketCount - 1)) === 0 && p.bucketCount !== 0);
  assert.strictEqual(p.entriesPerBucket, 4);
  assert.strictEqual(p.fingerprintBits, 16);
  assert.strictEqual(p.hashAlgorithm, 0);
  assert.ok(dataLen <= 32 * 1024 * 1024);
});

check('remove round-trips (Set + dirty flag)', () => {
  const s = new CompressedAccountFilterSet(100);
  assert.strictEqual(s.insert(pubkey(1)), true);
  assert.strictEqual(s.insert(pubkey(1)), false); // idempotent
  assert.ok(s.contains(pubkey(1)));
  assert.ok(s.takeDirty());
  assert.ok(!s.takeDirty()); // cleared
  assert.strictEqual(s.remove(pubkey(1)), true);
  assert.strictEqual(s.remove(pubkey(1)), false);
  assert.ok(!s.contains(pubkey(1)));
  assert.ok(s.takeDirty());
});

check('base58 input parity with raw-bytes input', () => {
  // base58 of pubkey(7) computed independently
  const bs58 = require('bs58');
  const b = pubkey(7);
  const s1 = new CompressedAccountFilterSet(100);
  const s2 = new CompressedAccountFilterSet(100);
  s1.insert(b);
  s2.insert(bs58.default ? bs58.default.encode(b) : bs58.encode(b));
  assert.strictEqual(s1.toBytes().toString('hex'), s2.toBytes().toString('hex'));
});

console.log(`\n${passed} checks passed.`);
