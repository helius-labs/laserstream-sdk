const MAX = '18446744073709551615';
function checkedScalar(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) ||
      value.length > MAX.length || (value.length === MAX.length && value > MAX)) {
    throw new RangeError('account transaction index must be an exact uint64 decimal string');
  }
  return value;
}
const NoTransaction = Object.freeze({ kind: 'NoTransaction' });
const AccountTransactionIndex = Object.freeze({
  NoTransaction,
  Transaction(index) {
    checkedScalar(index);
    if (index === MAX) throw new RangeError('transaction index is reserved for NoTransaction');
    return { kind: 'Transaction', index };
  },
});
function decodeAccountTransactionIndex(value) {
  checkedScalar(value);
  return value === MAX ? NoTransaction : AccountTransactionIndex.Transaction(value);
}
function encodeAccountTransactionIndex(value) {
  if (value && value.kind === 'NoTransaction' && !Object.hasOwn(value, 'index')) return MAX;
  if (value && value.kind === 'Transaction') return AccountTransactionIndex.Transaction(value.index).index;
  throw new TypeError('invalid AccountTransactionIndex');
}
function getAccountTransactionIndex(account) {
  // Proto3 scalar default, including old GA that omits field 32.
  return decodeAccountTransactionIndex(account.transactionIndex === undefined ? '0' : account.transactionIndex);
}
function setAccountTransactionIndex(account, value) {
  account.transactionIndex = encodeAccountTransactionIndex(value);
}
module.exports = { AccountTransactionIndex, decodeAccountTransactionIndex, encodeAccountTransactionIndex, getAccountTransactionIndex, setAccountTransactionIndex };
