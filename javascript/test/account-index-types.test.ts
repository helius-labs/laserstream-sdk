import { decodeSubscribeUpdate, subscribe, SubscribeUpdateAccountInfo,
  AccountTransactionIndex, getAccountTransactionIndex, setAccountTransactionIndex,
  encodeAccountTransactionIndex } from '../client';

const account: SubscribeUpdateAccountInfo = { transactionIndex: '42' };
setAccountTransactionIndex(account, AccountTransactionIndex.Transaction('42'));
setAccountTransactionIndex(account, AccountTransactionIndex.NoTransaction);
const typed: AccountTransactionIndex = getAccountTransactionIndex(account);
const wire: string = encodeAccountTransactionIndex(typed);
// @ts-expect-error uint64 must not silently lose precision through Number
account.transactionIndex = 42;
// @ts-expect-error constructor rejects Number
AccountTransactionIndex.Transaction(42);
// @ts-expect-error no Unknown variant
const unknown: AccountTransactionIndex = {kind: 'Unknown'};
// @ts-expect-error discriminated union rejects numeric index
setAccountTransactionIndex(account, {kind: 'Transaction', index: 42});
const update = decodeSubscribeUpdate(new Uint8Array());
const direct = getAccountTransactionIndex(update.account!.account!);
const nested = getAccountTransactionIndex(update.block!.accounts![0]);
subscribe({ endpoint: 'http://localhost', apiKey: '' }, {}, update => {
  const index = getAccountTransactionIndex(update.account!.account!);
  if (index.kind === 'Transaction') {
    const exact: string = index.index;
    // @ts-expect-error no Number/any escape
    const lossy: number = index.index;
    void [exact, lossy];
  } else {
    // @ts-expect-error NoTransaction has no index
    index.index;
  }
  // @ts-expect-error real callback raw field is typed, not any
  const lossy: number = update.block!.accounts![0].transactionIndex;
  void lossy;
});
void [wire, direct, nested, unknown];
