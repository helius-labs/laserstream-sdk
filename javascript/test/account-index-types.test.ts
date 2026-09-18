import { getAccountIndex, SubscribeUpdateAccountInfo } from '../client';

declare const account: SubscribeUpdateAccountInfo;
const index = getAccountIndex(account);
if (index.kind === 'TransactionIndex') {
  const value: number = index.index;
  void value;
} else {
  const value: number = index.operationCount;
  void value;
}
