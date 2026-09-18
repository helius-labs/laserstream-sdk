const MAX = '18446744073709551615';

function safeInteger(value, field) {
  const number = Number(value);
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(number)) {
    throw new RangeError(`${field} must be a safe nonnegative integer`);
  }
  return number;
}

function decodeAccountIndex(transactionIndex) {
  if (transactionIndex === MAX) {
    return { kind: 'NoTransaction' };
  }
  return { kind: 'Transaction', index: safeInteger(transactionIndex, 'transaction index') };
}

function getAccountIndex(account) {
  return decodeAccountIndex(account.transactionIndex === undefined ? '0' : account.transactionIndex);
}

module.exports = { decodeAccountIndex, getAccountIndex };
