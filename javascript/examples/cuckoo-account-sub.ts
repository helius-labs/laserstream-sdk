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
    endpoint: 'your-endpoint', // must be a cuckoo-enabled LaserStream endpoint
  };

  // The accounts you want to track.
  const addresses = [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'So11111111111111111111111111111111111111112',  // wSOL
  ];

  // Build a compact cuckoo filter instead of sending the full pubkey list.
  // Size capacity for your peak tracked-set size.
  const tracked = new CompressedAccountFilterSet(1_000_000);
  for (const address of addresses) {
    tracked.insert(address);
  }

  // Attach the filter to the request (no explicit account list needed).
  const request: any = { accounts: {}, commitment: CommitmentLevel.PROCESSED };
  tracked.insertIntoSubscribeRequest(request, 'tracked-accounts');

  const stream = await subscribe(
    config,
    request,
    async (update: SubscribeUpdate) => {
      const pubkey = update.account?.account?.pubkey;
      // Re-check locally to drop the server's rare false positives.
      if (pubkey && tracked.contains(pubkey)) {
        console.log('tracked account update:', update.account);
      }
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
