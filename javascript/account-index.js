const MAX = '18446744073709551615';
const NoTransaction = Object.freeze({ kind: 'NoTransaction' });

function decodeAccountTransactionIndex(value) {
  if (value === MAX) return NoTransaction;
  const index = Number(value);
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(index)) {
    throw new RangeError('transaction index must be a safe nonnegative integer');
  }
  return { kind: 'Transaction', index };
}

function getAccountTransactionIndex(account) {
  return decodeAccountTransactionIndex(account.transactionIndex === undefined ? '0' : account.transactionIndex);
}

module.exports = { decodeAccountTransactionIndex, getAccountTransactionIndex };
