import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';

const credentials = require('../test-config');

/**
 * Test for DataSliceOverlap bug fix
 *
 * This test verifies that calling write() multiple times with accountsDataSlice
 * does NOT cause duplication, which would lead to "DataSliceOverlap" errors
 * during reconnection.
 *
 * Before fix: accountsDataSlice would extend/accumulate: [slice, slice, slice, slice]
 * After fix: accountsDataSlice replaces: [slice]
 */
async function testDataSliceOverlapBugFix() {

  const config: LaserstreamConfig = {
    apiKey: credentials.laserstream.apiKey,
    endpoint: credentials.laserstream.endpoint,
    replay: true,
  };

  let reconnectionAttempts = 0;
  let dataSliceOverlapError = false;
  let reconnectionSucceeded = false;
  let firstReconnectDetected = false;

  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  const stream = await subscribe(
    config,
    {
      accounts: {
        "usdc-accounts": {
          account: [],
          owner: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
          filters: [
            { datasize: 165 },
            { memcmp: { offset: 0, base58: USDC_MINT } }
          ]
        }
      },
      commitment: CommitmentLevel.PROCESSED,
      slots: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [
        {
          offset: 0,
          length: 165
        }
      ]
    },
    async (update: SubscribeUpdate) => {
      // Track that we're receiving data after reconnection
      if (firstReconnectDetected && reconnectionAttempts > 0) {
        reconnectionSucceeded = true;
      }
    },
    (error) => {
      if (error.message.includes('DataSliceOverlap')) {
        dataSliceOverlapError = true;
      }

      if (error.message.includes('Connection error')) {
        if (error.message.includes('attempt 1')) {
          firstReconnectDetected = true;
        }
        const match = error.message.match(/attempt (\d+)/);
        if (match) {
          reconnectionAttempts = Math.max(reconnectionAttempts, parseInt(match[1]));
        }
      }
    }
  );

  await new Promise(resolve => setTimeout(resolve, 3000));

  for (let i = 1; i <= 3; i++) {
    await stream.write({
      accounts: {
        "usdc-accounts": {
          account: [],
          owner: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
          filters: [
            { datasize: 165 },
            { memcmp: { offset: 0, base58: USDC_MINT } }
          ]
        }
      },
      commitment: CommitmentLevel.PROCESSED,
      slots: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [
        {
          offset: 0,
          length: 165
        }
      ]
    });
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  await new Promise(resolve => setTimeout(resolve, 60000));

  stream.cancel();

  if (dataSliceOverlapError) {
    throw new Error('DataSliceOverlap error occurred');
  }

  if (reconnectionAttempts > 0 && !reconnectionSucceeded) {
    throw new Error('Reconnection attempted but did not succeed');
  }

  if (reconnectionAttempts === 0) {
    console.log('Warning: No reconnection triggered. Chaos proxy may not be running.');
  }

  console.log('Test passed');
}

testDataSliceOverlapBugFix().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
