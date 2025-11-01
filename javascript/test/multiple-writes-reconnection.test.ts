import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';

const credentials = require('../test-config');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Test for multiple writes before reconnection
 *
 * This test verifies that when multiple write() calls are made rapidly,
 * after reconnection, only the LAST write() is used (not the first, not merged).
 *
 * Sequence:
 * 1. Initial: USDC filter
 * 2. Write 1: USDT filter (replaces USDC)
 * 3. Write 2: SOL filter (replaces USDT)
 * 4. Write 3: Back to USDC filter (replaces SOL)
 * 5. Disconnect/Reconnect
 * 6. Verify: Only USDC filter is active (from write 3)
 */
async function testMultipleWritesReconnection() {

  const config: LaserstreamConfig = {
    apiKey: credentials.laserstream.apiKey,
    endpoint: credentials.laserstream.endpoint,
    replay: true,
  };

  const seenFilters = new Set<string>();
  let reconnected = false;
  let reconnectTime = 0;
  const filtersAfterReconnect = new Set<string>();
  let lastWriteCompletedTime = 0;

  const stream = await subscribe(
    config,
    {
      transactions: {
        "initial-usdc": {
          vote: false,
          failed: false,
          accountInclude: [USDC_MINT],
          accountExclude: [],
          accountRequired: []
        }
      },
      commitment: CommitmentLevel.PROCESSED,
      accounts: {},
      slots: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
    },
    async (update: SubscribeUpdate) => {
      if (update.transaction) {
        const filters = update.filters || [];
        filters.forEach(f => {
          seenFilters.add(f);

          // Track filters seen after reconnection occurred
          if (reconnected && Date.now() - reconnectTime > 2000) {
            filtersAfterReconnect.add(f);
          }
        });
      }
    },
    (error) => {
      if (error.message.includes('Connection error') && error.message.includes('attempt 1')) {
        if (!reconnected) {
          reconnected = true;
          reconnectTime = Date.now();
        }
      }
    }
  );

  await new Promise(resolve => setTimeout(resolve, 3000));

  await stream.write({
    transactions: {
      "write1-usdt": {
        vote: false,
        failed: false,
        accountInclude: [USDT_MINT],
        accountExclude: [],
        accountRequired: []
      }
    },
    commitment: CommitmentLevel.PROCESSED,
    accounts: {},
    slots: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  });
  await new Promise(resolve => setTimeout(resolve, 500));

  await stream.write({
    transactions: {
      "write2-sol": {
        vote: false,
        failed: false,
        accountInclude: [SOL_MINT],
        accountExclude: [],
        accountRequired: []
      }
    },
    commitment: CommitmentLevel.PROCESSED,
    accounts: {},
    slots: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  });
  await new Promise(resolve => setTimeout(resolve, 500));

  await stream.write({
    transactions: {
      "write3-usdc": {
        vote: false,
        failed: false,
        accountInclude: [USDC_MINT],
        accountExclude: [],
        accountRequired: []
      }
    },
    commitment: CommitmentLevel.PROCESSED,
    accounts: {},
    slots: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  });
  lastWriteCompletedTime = Date.now();

  await new Promise(resolve => setTimeout(resolve, 60000));

  stream.cancel();

  const initialUsdcAfterReconnect = filtersAfterReconnect.has('initial-usdc');
  const write1UsdtAfterReconnect = filtersAfterReconnect.has('write1-usdt');
  const write2SolAfterReconnect = filtersAfterReconnect.has('write2-sol');
  const write3UsdcAfterReconnect = filtersAfterReconnect.has('write3-usdc');

  if (reconnected) {
    if (initialUsdcAfterReconnect) {
      throw new Error('initial-usdc filter active after reconnect');
    }

    if (write1UsdtAfterReconnect) {
      throw new Error('write1-usdt filter active after reconnect');
    }

    if (write2SolAfterReconnect) {
      throw new Error('write2-sol filter active after reconnect');
    }

    if (!write3UsdcAfterReconnect) {
      throw new Error('write3-usdc not active after reconnect');
    }
  } else {
    console.log('Warning: No reconnection occurred. Chaos proxy may not be running.');
  }

  console.log('Test passed');
}

testMultipleWritesReconnection().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
