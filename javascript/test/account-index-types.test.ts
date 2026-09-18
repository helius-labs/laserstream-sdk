import { decodeSubscribeUpdate, subscribe, SubscribeUpdateAccountInfo,
  AccountTransactionIndex, getAccountTransactionIndex, decodeAccountTransactionIndex } from '../client';
import * as client from '../client';
import * as indexApi from '../account-index';
// @ts-expect-error no public setter export
import { setAccountTransactionIndex } from '../client';
// @ts-expect-error no public encoder export
import { encodeAccountTransactionIndex } from '../client';
// @ts-expect-error no helper setter export
import { setAccountTransactionIndex as helperSetter } from '../account-index';
// @ts-expect-error no helper encoder export
import { encodeAccountTransactionIndex as helperEncoder } from '../account-index';

// Raw generated fields remain writable for protobuf compatibility (test fixture only).
const account: SubscribeUpdateAccountInfo = { transactionIndex: '42' };
const typed: AccountTransactionIndex = getAccountTransactionIndex(account);
const decoded: AccountTransactionIndex = decodeAccountTransactionIndex('18446744073709551614');
// @ts-expect-error uint64 must not silently lose precision through Number
account.transactionIndex = 42;
// @ts-expect-error decoder requires exact decimal strings
decodeAccountTransactionIndex(42);
// @ts-expect-error read type has no runtime constructor/factory value
AccountTransactionIndex.Transaction('42');
// @ts-expect-error read type has no runtime NoTransaction value
client.AccountTransactionIndex.NoTransaction;
// @ts-expect-error helper read type has no runtime factory value
indexApi.AccountTransactionIndex.Transaction('42');
// @ts-expect-error no Unknown variant
const unknown: AccountTransactionIndex = {kind: 'Unknown'};
// @ts-expect-error discriminated union rejects numeric index
const numeric: AccountTransactionIndex = {kind: 'Transaction', index: 42};
// @ts-expect-error typed view is read-only
typed.kind = 'NoTransaction';
const update = decodeSubscribeUpdate(new Uint8Array());
const direct = getAccountTransactionIndex(update.account!.account!);
const nested = getAccountTransactionIndex(update.block!.accounts![0]);
subscribe({ endpoint: 'http://localhost', apiKey: '' }, {}, update => {
  const index = getAccountTransactionIndex(update.account!.account!);
  switch (index.kind) {
    case 'Transaction': {
      const exact: string = index.index;
      // @ts-expect-error no Number/any escape
      const lossy: number = index.index;
      // @ts-expect-error typed view is read-only
      index.index = '1';
      void [exact, lossy];
      break;
    }
    case 'NoTransaction':
      // @ts-expect-error NoTransaction has no index
      index.index;
      break;
    default: {
      const exhaustive: never = index;
      void exhaustive;
    }
  }
  // @ts-expect-error real callback raw field is typed, not any
  const lossy: number = update.block!.accounts![0].transactionIndex;
  void lossy;
});
void [typed, decoded, direct, nested, unknown, numeric];
