const readline = require('node:readline');
const sdk = require(process.env.MINT_JS_SDK || 'helius-laserstream');
const bs58 = require('bs58');
let handle;
const emit = value => console.log(JSON.stringify(value));
const key = bytes => bs58.encode(Buffer.from(bytes));
function update(u) {
  if (u.transaction) {
    const t = u.transaction.transaction;
    const meta = t.meta;
    emit({type: 'transaction', filters: u.filters, slot: u.transaction.slot,
      signature: key(t.signature), vote: t.isVote, failed: !!meta?.err,
      keys: [...(t.transaction?.message?.accountKeys || []),
        ...(meta?.loadedWritableAddresses || []), ...(meta?.loadedReadonlyAddresses || [])].map(key),
      pre: meta?.preTokenBalances || [], post: meta?.postTokenBalances || []});
  } else if (u.transactionStatus) {
    emit({type: 'status', filters: u.filters, slot: u.transactionStatus.slot,
      signature: key(u.transactionStatus.signature), vote: u.transactionStatus.isVote,
      failed: !!u.transactionStatus.err});
  } else if (u.slot) {
    emit({type: 'slot', filters: u.filters, slot: u.slot.slot});
  }
}
const input = readline.createInterface({input: process.stdin});
(async () => {
  for await (const line of input) {
    const c = JSON.parse(line);
    try {
      if (c.action === 'subscribe') {
        handle = await sdk.subscribe({endpoint: process.env.MINT_ENDPOINT,
          apiKey: process.env.MINT_API_KEY || 'local-test', replay: c.replay ?? true,
          maxReconnectAttempts: 3}, c.request, update,
          e => emit({type: 'error', message: e.message}));
      } else if (c.action === 'write') {
        await handle.write(c.request);
      } else if (c.action === 'stop') {
        handle?.cancel();
        sdk.shutdownAllStreams();
        process.exit(0);
      }
      emit({type: 'ack', id: c.id});
    } catch (e) { emit({type: 'commandError', id: c.id, message: e.message}); }
  }
})().catch(e => { emit({type: 'fatal', message: e.message}); process.exit(1); });
