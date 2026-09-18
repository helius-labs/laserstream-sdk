const MAX = '18446744073709551615';
function checkedScalar(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) ||
      value.length > MAX.length || (value.length === MAX.length && value > MAX)) {
    throw new RangeError('account transaction index must be an exact uint64 decimal string');
  }
  return value;
}
const NoTransaction = Object.freeze({ kind: 'NoTransaction' });
function decodeAccountTransactionIndex(value) {
  checkedScalar(value);
  return value === MAX ? NoTransaction : Object.freeze({ kind: 'Transaction', index: value });
}
function getAccountTransactionIndex(account) {
  // Proto3 scalar default, including old GA that omits field 32.
  return decodeAccountTransactionIndex(account.transactionIndex === undefined ? '0' : account.transactionIndex);
}
module.exports = { decodeAccountTransactionIndex, getAccountTransactionIndex };
