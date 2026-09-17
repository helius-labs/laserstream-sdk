import { decodeSubscribeUpdate, subscribe, SubscribeUpdateAccountInfo } from '../client';

const account: SubscribeUpdateAccountInfo = { transactionIndex: '18446744073709551615' };
const index: string | undefined = account.transactionIndex;
// @ts-expect-error uint64 must not silently lose precision through Number
account.transactionIndex = 42;

const update = decodeSubscribeUpdate(new Uint8Array());
const direct: string | undefined = update.account?.account?.transactionIndex;
const nested: string | undefined = update.block?.accounts?.[0]?.transactionIndex;
subscribe({ endpoint: 'http://localhost', apiKey: '' }, {}, update => {
  const index: string | undefined = update.account?.account?.transactionIndex;
  // @ts-expect-error callback field is typed, not any or Number
  const lossy: number = update.account!.account!.transactionIndex;
  void [index, lossy];
});
void [index, direct, nested];
