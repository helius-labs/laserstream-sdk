'use strict';

// Differential proof: replay each Rust-generated case (varied capacities, kick-heavy
// loads, interleaved removes, and table-full) through the JS port and assert the
// JS-built table is BYTE-IDENTICAL to Rust, with matching per-op return values, and
// (when the table never saturated) zero false negatives at both the Set and table level.
//
// Run: node test/cuckoo-differential.test.js

const assert = require('assert');
const { CompressedAccountFilterSet, TableFullError } = require('../cuckoo');
const { cases } = require('./fixtures/cuckoo-differential.json');

function bytesFromHex(h) {
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
  return b;
}

let totalOps = 0;
let totalTrackedChecked = 0;
let kickedCases = 0;

for (const c of cases) {
  const set = new CompressedAccountFilterSet(c.capacity);
  let sawTableFull = false;

  for (const [kind, keyHex, ret] of c.ops) {
    const bytes = bytesFromHex(keyHex);
    totalOps++;
    if (kind === 'i') {
      if (ret === 'tablefull') {
        assert.throws(() => set.insert(bytes), TableFullError,
          `${c.name}: expected TableFull on ${keyHex}`);
        sawTableFull = true;
        break; // Rust breaks here too; table left in the same partial state
      } else {
        const added = set.insert(bytes);
        assert.strictEqual(added, ret === 'true',
          `${c.name}: insert(${keyHex}) returned ${added}, expected ${ret}`);
      }
    } else {
      const removed = set.remove(bytes);
      assert.strictEqual(removed, ret === 'true',
        `${c.name}: remove(${keyHex}) returned ${removed}, expected ${ret}`);
    }
  }

  // (1) geometry
  assert.strictEqual(set.bucketCount, c.bucketCount, `${c.name}: bucketCount`);
  assert.strictEqual(sawTableFull, c.tableFull, `${c.name}: tableFull flag`);

  // (2) THE proof: byte-identical serialized table (covers the eviction path)
  assert.strictEqual(set.toBytes().toString('hex'), c.dataHex,
    `${c.name}: serialized table bytes differ from Rust`);

  // (3) tracked-set size parity
  assert.strictEqual(set.size, c.trackedHex.length, `${c.name}: tracked size`);

  // (4) no false negatives — only valid when the table never saturated
  if (!c.tableFull) {
    for (const keyHex of c.trackedHex) {
      const bytes = bytesFromHex(keyHex);
      assert.ok(set.contains(bytes), `${c.name}: Set false negative ${keyHex}`);
      assert.ok(set._filterContains(bytes), `${c.name}: TABLE false negative ${keyHex}`);
      totalTrackedChecked++;
    }
  } else {
    kickedCases++;
  }

  const ins = c.ops.filter((o) => o[0] === 'i' && o[2] === 'true').length;
  console.log(`  ✓ ${c.name.padEnd(20)} buckets=${String(c.bucketCount).padStart(5)} ops=${String(c.ops.length).padStart(5)} bytes-identical, returns match${c.tableFull ? ', table-full reproduced' : `, ${ins} keys 0-FN`}`);
}

console.log(`\nPASS: ${cases.length} cases, ${totalOps} ops replayed byte-identical to Rust; ` +
  `${totalTrackedChecked} tracked keys with 0 false negatives; ${kickedCases} table-full state(s) reproduced.`);
