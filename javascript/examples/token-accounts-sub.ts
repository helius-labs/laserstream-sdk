// tokenAccounts (ATA) transaction filter.
//
// Subscribe to transactions touching a wallet *and* its Associated Token
// Accounts (ATAs) by setting `tokenAccounts` on a transaction filter alongside
// `accountInclude`. Modes (server wire values):
//
//   - "none"           — no expansion (default; same as omitting the field).
//   - "balanceChanged" — also match txs touching an ATA owned by an
//                        accountInclude wallet whose token balance changed.
//   - "all"            — match any tx touching an ATA owned by an
//                        accountInclude wallet.
//
// Run with: npm run example:token-accounts-sub
import {
  subscribe,
  CommitmentLevel,
  SubscribeUpdate,
  LaserstreamConfig,
} from '../client';
const credentials = require('../test-config');

async function runTokenAccountsSubscription() {
  const config: LaserstreamConfig = {
    apiKey: credentials.laserstreamProduction?.apiKey ?? 'your-api-key',
    endpoint: credentials.laserstreamProduction?.endpoint ?? 'your-endpoint',
  };

  // Example wallet to watch; replace with your own.
  const wallet = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';

  const request = {
    transactions: {
      'wallet-and-atas': {
        vote: false,
        failed: false,
        accountInclude: [wallet],
        accountExclude: [],
        accountRequired: [],
        // Expand the subscription to ATAs owned by the watched wallet whose
        // token balance changed in the transaction.
        tokenAccounts: 'balanceChanged',
      },
    },
    commitment: CommitmentLevel.PROCESSED,
    accounts: {},
    slots: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  const stream = await subscribe(
    config,
    request,
    async (update: SubscribeUpdate) => {
      console.log(JSON.stringify(update, null, 2));
    },
    (error) => {
      console.error('Stream error:', error);
    }
  );

  process.on('SIGINT', () => {
    stream.cancel();
    process.exit(0);
  });
}

runTokenAccountsSubscription().catch(console.error);
