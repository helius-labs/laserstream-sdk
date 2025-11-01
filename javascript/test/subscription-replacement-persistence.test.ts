import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';

const credentials = require('../test-config');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/**
 * Test for subscription replacement behavior and persistence across reconnections
 *
 * This test verifies that:
 * 1. write() REPLACES the subscription (not merges)
 * 2. After write(), only the NEW subscription receives updates
 * 3. After reconnection, the LATEST write() is used (subscription persists)
 */
async function testSubscriptionReplacementPersistence() {

  const config: LaserstreamConfig = {
    apiKey: credentials.laserstream.apiKey,
    endpoint: credentials.laserstream.endpoint,
    replay: true,
  };

  const seenFilters = new Set<string>();
  let reconnected = false;
  let reconnectTime = 0;
  const filtersAfterReconnect = new Set<string>();
  const filtersAfterWrite = new Set<string>();
  let writeCompletedTime = 0;

  const stream = await subscribe(
    config,
    {
      transactions: {
        "usdc-filter": {
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

          // Track filters seen after write() completed
          if (writeCompletedTime > 0 && Date.now() - writeCompletedTime > 2000) {
            filtersAfterWrite.add(f);
          }

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

  await new Promise(resolve => setTimeout(resolve, 5000));

  await stream.write({
    transactions: {
      "usdt-filter": {
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
  writeCompletedTime = Date.now();

  await new Promise(resolve => setTimeout(resolve, 60000));

  stream.cancel();

  const hasUSDC = seenFilters.has('usdc-filter');
  const hasUSDT = seenFilters.has('usdt-filter');
  const usdcAfterWrite = filtersAfterWrite.has('usdc-filter');
  const usdtAfterWrite = filtersAfterWrite.has('usdt-filter');
  const usdcAfterReconnect = filtersAfterReconnect.has('usdc-filter');
  const usdtAfterReconnect = filtersAfterReconnect.has('usdt-filter');

  if (!hasUSDC) {
    throw new Error('USDC filter never received data initially');
  }

  if (!hasUSDT) {
    throw new Error('USDT filter never received data after write');
  }

  if (usdcAfterWrite) {
    throw new Error('USDC filter still receiving data after write');
  }

  if (!usdtAfterWrite) {
    throw new Error('USDT filter not receiving data after write');
  }

  if (reconnected) {
    if (usdcAfterReconnect) {
      throw new Error('USDC filter returned after reconnection');
    }

    if (!usdtAfterReconnect) {
      throw new Error('USDT filter lost after reconnection');
    }
  } else {
    console.log('Warning: No reconnection occurred. Chaos proxy may not be running.');
  }

  console.log('Test passed');
}

testSubscriptionReplacementPersistence().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
