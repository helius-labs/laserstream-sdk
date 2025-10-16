import { subscribe, CommitmentLevel, SubscribeUpdate, LaserstreamConfig } from '../client';

const credentials = require('../test-config');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

async function testSubscriptionModificationPersistence() {
  const config: LaserstreamConfig = {
    apiKey: credentials.laserstream.apiKey,
    endpoint: credentials.laserstream.endpoint,
    replay: true,
  };

  const seenFilters = new Set<string>();
  let reconnected = false;
  let reconnectTime = 0;
  const filtersAfterReconnect = new Set<string>();

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
          // Track filters seen after reconnection occurred
          if (reconnected && Date.now() - reconnectTime > 1000) {
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

  // Wait for initial data
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Add USDT filter
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

  // Wait for modification to take effect and potential reconnection
  await new Promise(resolve => setTimeout(resolve, 60000));

  stream.cancel();

  // Verify results
  const hasUSBC = seenFilters.has('usdc-filter');
  const hasUSDT = seenFilters.has('usdt-filter');
  const usdtAfterReconnect = filtersAfterReconnect.has('usdt-filter');

  console.log(`USDC filter present: ${hasUSBC}`);
  console.log(`USDT filter present: ${hasUSDT}`);
  console.log(`Reconnection occurred: ${reconnected}`);
  console.log(`USDT seen after reconnect: ${usdtAfterReconnect}`);

  if (!hasUSBC || !hasUSDT) {
    throw new Error('Test failed: Not all filters received data');
  }

  if (reconnected && !usdtAfterReconnect) {
    throw new Error('Test failed: USDT filter lost after reconnection');
  }

  console.log('✅ Test passed: Subscription modifications persist across reconnections');
}

testSubscriptionModificationPersistence().catch(err => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
