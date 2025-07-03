import { subscribe, CommitmentLevel, shutdownAllStreams, getActiveStreamCount, SubscribeUpdate } from '../client';
const cfg = require('../test-config');

/**
 * Simple integration test that verifies:
 * 1. The internal slot-tracker subscription added by Rust is NOT exposed to the JavaScript layer.
 * 2. Stream lifecycle helpers work – the stream is cancelled when we call `cancel()` and
 *    the global registry reports zero active streams afterwards.
 *
 * NOTE: This test assumes a local Laserstream instance is running.  The default
 *       endpoint is taken from `test-config.js` (`laserstream`).
 */
async function run(): Promise<void> {
  const laserCfg = {
    apiKey: cfg.laserstreamProduction.apiKey,
    endpoint: cfg.laserstreamProduction.endpoint,
  };

  const userSlotFilterId = 'user-slot-test';

  const request: any = {
    accounts: {},
    slots: {
      [userSlotFilterId]: {},
    },
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    commitment: CommitmentLevel.Processed,
    accountsDataSlice: [],
  };

  let leakedInternalFilter = false;
  let receivedSlotUpdate = false;

  const stream = await subscribe(
    laserCfg,
    request,
    (update: SubscribeUpdate) => {
      if (update.slot) {
        receivedSlotUpdate = true;
        const hasInternal = update.filters.some((f: string) => f.startsWith('__internal_slot_tracker'));
        if (hasInternal) {
          console.error('❌ Internal slot-tracker filter leaked to consumer:', update.filters);
          leakedInternalFilter = true;
        }
        if (!update.filters.includes(userSlotFilterId)) {
          console.error('❌ Slot update missing user filter id:', update.filters);
          leakedInternalFilter = true;
        }
      }
    },
    (err: any) => {
      console.error('Stream error:', err);
    },
  );

  console.log('✅ Stream started, waiting for slot updates (10 s)…');
  await new Promise((res) => setTimeout(res, 10_000));

  // Make sure we saw at least one slot update; otherwise the test environment is mis-configured.
  if (!receivedSlotUpdate) {
    console.error('❌ Did not receive any slot updates – check Laserstream endpoint in test-config.js');
    process.exit(1);
  }

  // Cancel and ensure cleanup
  stream.cancel();
  await shutdownAllStreams();

  if (getActiveStreamCount() !== 0) {
    console.error('❌ Stream registry not cleaned up – still', getActiveStreamCount(), 'active');
    process.exit(1);
  }

  if (leakedInternalFilter) {
    console.error('❌ Internal slot filter leak detected – test failed');
    process.exit(1);
  }

  console.log('🎉 Internal slot-filter test passed');
}

run().catch((e) => {
  console.error('Unhandled error in test:', e);
  process.exit(1);
}); 