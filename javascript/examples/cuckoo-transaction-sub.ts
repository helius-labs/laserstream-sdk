import {
  subscribe,
  CommitmentLevel,
  CompressedAccountFilterSet,
  SubscribeUpdate,
  LaserstreamConfig,
} from '../client';

async function main() {
  const config: LaserstreamConfig = {
    apiKey: 'your-api-key',
    endpoint: 'your-endpoint',
  };

  // The accounts you want transactions to mention (accountInclude).
  const addresses = [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'So11111111111111111111111111111111111111112',  // wSOL
  ];

  // Compact cuckoo filter instead of a full accountInclude list (size for your peak set).
  const tracked = new CompressedAccountFilterSet(1_000_000);
  for (const address of addresses) {
    tracked.insert(address);
  }

  // Attach the filter to a transaction subscription (no explicit accountInclude needed).
  const request: any = { transactions: {}, commitment: CommitmentLevel.PROCESSED };
  request.transactions['tracked-transactions'] = tracked.toTransactionFilter();

  const stream = await subscribe(
    config,
    request,
    async (update: SubscribeUpdate) => {
      // <1% false positives; re-check with tracked.contains(pubkey) if you need exactness.
      console.log('transaction update:', update.transaction);
    },
    (error: Error) => {
      console.error('Stream error:', error);
    }
  );

  process.on('SIGINT', () => {
    stream.cancel();
    process.exit(0);
  });
}

main().catch(console.error);
