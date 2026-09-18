const MAX = '18446744073709551615';

function safeInteger(value, field) {
  const number = Number(value);
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(number)) {
    throw new RangeError(`${field} must be a safe nonnegative integer`);
  }
  return number;
}

function decodeAccountIndex(transactionIndex, nativeOperationCount = '0') {
  if (transactionIndex === MAX) {
    return { kind: 'NativeOperation', operationCount: safeInteger(nativeOperationCount, 'native operation count') };
  }
  return { kind: 'TransactionIndex', index: safeInteger(transactionIndex, 'transaction index') };
}

function getAccountIndex(account) {
  return decodeAccountIndex(account.transactionIndex === undefined ? '0' : account.transactionIndex, account.nativeOperationCount);
}

module.exports = { decodeAccountIndex, getAccountIndex };
