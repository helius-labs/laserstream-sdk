import { getAccountTransactionIndex, SubscribeUpdateAccountInfo } from '../client';

declare const account: SubscribeUpdateAccountInfo;
const index = getAccountTransactionIndex(account);
if (index.kind === 'Transaction') {
  const value: number = index.index;
  void value;
}
