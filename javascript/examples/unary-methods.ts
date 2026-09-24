import { LaserstreamClient, CommitmentLevel } from '../client';

async function main() {
  // Create once and reuse: every call shares one connection.
  const client = new LaserstreamClient({
    apiKey: process.env.HELIUS_API_KEY || 'your-api-key',
    endpoint: process.env.LASERSTREAM_ENDPOINT || 'your-endpoint',
    timeoutMs: 10_000, // per-call deadline (default 30000)
  });

  const { slot } = await client.getSlot(CommitmentLevel.CONFIRMED);
  console.log('slot (confirmed): ', slot);

  const { blockHeight } = await client.getBlockHeight();
  console.log('block height:     ', blockHeight);

  const bh = await client.getLatestBlockhash(CommitmentLevel.FINALIZED);
  console.log(`latest blockhash:  ${bh.blockhash} (slot ${bh.slot}, last valid height ${bh.lastValidBlockHeight})`);

  const { valid } = await client.isBlockhashValid(bh.blockhash);
  console.log('blockhash valid:  ', valid);

  console.log('version:          ', (await client.getVersion()).version);
  console.log('ping:             ', (await client.ping(1)).count);
  console.log('replay from slot: ', (await client.subscribeReplayInfo()).firstAvailable);

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
