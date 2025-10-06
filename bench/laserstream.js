const { subscribe, CommitmentLevel } = require('../javascript/client');

async function main() {
  const config = {
    apiKey: '',
    endpoint: 'https://laserstream-mainnet-sgp.helius-rpc.com',
  };

  const request = {
    accounts: {},
    slots: {},
    transactions: {
      'all-transactions': {
        vote: false,
        failed: false,
        accountInclude: [],
        accountExclude: [],
        accountRequired: []
      }
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.PROCESSED,
  };

  const stream = await subscribe(
    config,
    request,
    async (update) => {
      console.log(update);
      console.log(JSON.stringify(update, null, 2));  
    },
    (error) => {
      console.error('Error:', error);
    }
  );

  process.on('SIGINT', () => {
    stream.cancel();
    process.exit(0);
  });
}

main().catch(console.error);
