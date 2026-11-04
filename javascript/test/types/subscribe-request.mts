// Compile-time checks for the SubscribeRequest declarations.
//
// Run with `npm run test:types`. Nothing here executes; a failure is a tsc
// error. Every request type below was silently `any` from 0.1.7 onwards
// because client.d.ts re-exported names that its dependency does not export.

import type {
  CompressedAccountFilterSet,
  StreamHandle,
  SubscribeRequest,
  SubscribeRequestAccountsDataSlice,
  SubscribeRequestFilterAccounts,
  SubscribeRequestFilterAccountsFilter,
  SubscribeRequestFilterBlocks,
  SubscribeRequestFilterBlocksMeta,
  SubscribeRequestFilterEntry,
  SubscribeRequestFilterSlots,
  SubscribeRequestFilterTransactions,
  SubscribeRequestPing,
} from 'helius-laserstream';
import Long = require('long');

// ---------------------------------------------------------------------------
// Every request type must be a real type.
//
// A type-level IsAny<T> assertion cannot catch this bug: a name imported from
// a module that does not export it becomes tsc's internal error type, and tsc
// suppresses every diagnostic derived from it, so IsAny<T> accepts both true
// and false. Assigning null instead fails for any real object type under
// strictNullChecks (empty interfaces included) and passes for `any` or the
// error type, which turns each @ts-expect-error below into an "unused
// directive" error.
// ---------------------------------------------------------------------------

type StreamWriteRequest = Parameters<StreamHandle['write']>[0];
type CuckooInsertRequest = Parameters<CompressedAccountFilterSet['insertIntoSubscribeRequest']>[0];

// @ts-expect-error: SubscribeRequest must not accept null.
export const subscribeRequestCheck: SubscribeRequest = null;
// @ts-expect-error: SubscribeRequestAccountsDataSlice must not accept null.
export const accountsDataSliceCheck: SubscribeRequestAccountsDataSlice = null;
// @ts-expect-error: SubscribeRequestFilterAccounts must not accept null.
export const filterAccountsCheck: SubscribeRequestFilterAccounts = null;
// @ts-expect-error: SubscribeRequestFilterAccountsFilter must not accept null.
export const filterAccountsFilterCheck: SubscribeRequestFilterAccountsFilter = null;
// @ts-expect-error: SubscribeRequestFilterBlocks must not accept null.
export const filterBlocksCheck: SubscribeRequestFilterBlocks = null;
// @ts-expect-error: SubscribeRequestFilterBlocksMeta must not accept null.
export const filterBlocksMetaCheck: SubscribeRequestFilterBlocksMeta = null;
// @ts-expect-error: SubscribeRequestFilterEntry must not accept null.
export const filterEntryCheck: SubscribeRequestFilterEntry = null;
// @ts-expect-error: SubscribeRequestFilterSlots must not accept null.
export const filterSlotsCheck: SubscribeRequestFilterSlots = null;
// @ts-expect-error: SubscribeRequestFilterTransactions must not accept null.
export const filterTransactionsCheck: SubscribeRequestFilterTransactions = null;
// @ts-expect-error: SubscribeRequestPing must not accept null.
export const pingCheck: SubscribeRequestPing = null;

// The request parameters of the public API must be real types too.
// @ts-expect-error: StreamHandle.write must not accept null.
export const streamWriteRequestCheck: StreamWriteRequest = null;
// @ts-expect-error: insertIntoSubscribeRequest must not accept null.
export const cuckooInsertRequestCheck: CuckooInsertRequest = null;

// ---------------------------------------------------------------------------
// Misspelled field names must be rejected.
// ---------------------------------------------------------------------------

export const misspelledAccountField: SubscribeRequest = {
  accounts: {
    tokenAccount: {
      // @ts-expect-error: "acccount" is a typo for "account".
      acccount: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
    },
  },
};

export const misspelledTopLevelField: SubscribeRequest = {
  // @ts-expect-error: "transaction" is a typo for "transactions".
  transaction: {},
};

// ---------------------------------------------------------------------------
// Fields the native layer accepts must keep compiling, documented or not.
// ---------------------------------------------------------------------------

// Documented in the README.
export const documentedFields: SubscribeRequest = {
  accounts: {
    'usdc-accounts': {
      account: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
      owner: [],
      filters: [{ datasize: 165 }, { memcmp: { offset: 0, base58: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } }],
    },
  },
  transactions: {
    'wallet-and-atas': {
      accountInclude: ['vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'],
      accountExclude: [],
      accountRequired: [],
      vote: false,
      failed: false,
      tokenAccounts: 'balanceChanged',
      matchMints: true,
    },
  },
  transactionsStatus: {},
  slots: { 'confirmed-slots': { filterByCommitment: true } },
  blocks: { 'all-blocks': { includeTransactions: true, includeAccounts: true } },
  blocksMeta: { 'block-metadata': {} },
  entry: { entries: { includeUpdateParent: true } },
  accountsDataSlice: [{ offset: 0, length: 64 }],
  fromSlot: 123,
};

// Native request parsing differs from protobufjs encoding: byte filters use a
// base64 string, while every u64 request field uses a JavaScript number.
export const nativeRequestInputs: SubscribeRequest = {
  accounts: {
    native: {
      filters: [
        { memcmp: { offset: 0, bytes: 'AQ==' } },
        { datasize: 165 },
        { lamports: { eq: 1, ne: 2, lt: 3, gt: 4 } },
      ],
    },
  },
  accountsDataSlice: [{ offset: 0, length: 64 }],
  fromSlot: 42,
};

export const protobufByteInputIsRejected: SubscribeRequest = {
  accounts: {
    native: {
      filters: [{
        memcmp: {
          offset: 0,
          // @ts-expect-error: the native parser accepts base64 strings, not Uint8Array.
          bytes: new Uint8Array([1]),
        },
      }],
    },
  },
};

export const protobufLongInputIsRejected: SubscribeRequest = {
  // @ts-expect-error: the native parser accepts a JavaScript number, not protobufjs Long.
  fromSlot: Long.fromNumber(42),
};

// Accepted by JsAccountFilter in napi-src/client.rs but not documented.
export const undocumentedAccountFilterFields: SubscribeRequestFilterAccounts = {
  accountInclude: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  accountExclude: [],
  accountRequired: [],
  cuckooAccountsFilter: {
    data: '',
    bucketCount: 1,
    entriesPerBucket: 4,
    fingerprintBits: 16,
    hashSeed: '0',
    hashAlgorithm: 0,
  },
};

// Already typed before this change; must stay accepted.
export const blockFooterField: SubscribeRequest = {
  blockFooter: { footers: {} },
};

// The README builds requests as un-annotated objects, so literal values widen
// (e.g. tokenAccounts becomes `string`). Passing such an object must compile.
const readmeStyleRequest = {
  transactions: {
    'wallet-and-atas': {
      accountInclude: ['vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'],
      accountExclude: [],
      accountRequired: [],
      vote: false,
      failed: false,
      tokenAccounts: 'balanceChanged',
    },
  },
};
export const readmeStyleRequestCheck: SubscribeRequest = readmeStyleRequest;

// Cuckoo helpers must produce filters the request type accepts.
export function insertCuckooFilter(filterSet: CompressedAccountFilterSet, request: SubscribeRequest): SubscribeRequest {
  return filterSet.insertIntoSubscribeRequest(request, 'tracked');
}
