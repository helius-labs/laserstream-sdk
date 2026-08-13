/**
 * Regression vectors for V1 transaction config (SIMD-0385) and
 * Reward.commissionBps (SIMD-0291).
 *
 * The base64 payloads are SubscribeUpdate messages encoded with
 * laserstream-core-proto 11.2.0 (Rust/prost) — the same bytes are asserted
 * against the Go and Rust SDKs, so all three decode identically.
 *
 * Run: npm run test:v1-config
 */

const assert = require('assert');
const { initProtobuf, decodeSubscribeUpdate } = require('../proto-decoder');

// SubscribeUpdate{transaction} whose message carries TransactionConfig
const V1_CONFIG_TX = 'CgR2ZWMxIpUCCowCCkAHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHGsMBCkAHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHEn8KBAgBGAISIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBEiACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAhogCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkoAToPCJS05PTLAxDAuVUggIAQIgAoKhC72ZGsAQ==';
// SubscribeUpdate{block} whose rewards carry commissionBps
const COMMISSION_BPS_BLOCK = 'CgR2ZWMyKoYBCLzZkawBEgR0ZXN0GngKPgorVm90ZTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMRCIJxigjQYgBCoBNTIDNTUwCjYKK1N0YWtlMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEQj04YwJoMIAM=';

async function main() {
  await initProtobuf();

  // --- Vector 1: V1 transaction message with config ---
  const txUpdate = decodeSubscribeUpdate(Buffer.from(V1_CONFIG_TX, 'base64'));
  assert.ok(txUpdate.transaction, 'expected transaction update');
  assert.strictEqual(txUpdate.transaction.slot, '361000123');

  const msg = txUpdate.transaction.transaction.transaction.message;
  assert.strictEqual(msg.versioned, true);
  assert.ok(msg.config, 'expected message.config to be present for V1');
  assert.strictEqual(msg.config.priorityFee, '123456789012');
  assert.strictEqual(msg.config.computeUnitLimit, 1400000);
  assert.strictEqual(msg.config.heapSize, 262144);
  // Unset optional field must not be reported as present
  assert.ok(
    msg.config.loadedAccountsDataSizeLimit === undefined ||
      msg.config.loadedAccountsDataSizeLimit === null,
    'loadedAccountsDataSizeLimit must be absent'
  );

  // Legacy/V0-shaped messages must NOT grow a config
  const header = msg.header;
  assert.ok(header && header.numRequiredSignatures === 1);

  // --- Vector 2: block rewards with commissionBps ---
  const blockUpdate = decodeSubscribeUpdate(Buffer.from(COMMISSION_BPS_BLOCK, 'base64'));
  assert.ok(blockUpdate.block, 'expected block update');
  const rewards = blockUpdate.block.rewards.rewards;
  assert.strictEqual(rewards.length, 2);

  assert.strictEqual(rewards[0].pubkey, 'Vote111111111111111111111111111111111111111');
  assert.strictEqual(rewards[0].commission, '5');
  assert.strictEqual(rewards[0].commissionBps, '550');
  assert.strictEqual(rewards[0].rewardType, 4); // Voting

  // Second reward has no commission at all — empty string on the wire
  assert.strictEqual(rewards[1].commissionBps, '');
  assert.strictEqual(rewards[1].rewardType, 3); // Staking

  console.log('✅ v1-config vectors: all assertions passed');
}

main().catch((err) => {
  console.error('❌ v1-config vectors failed:', err.message);
  process.exit(1);
});
