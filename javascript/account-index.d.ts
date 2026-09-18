/** Read-only view of an unshifted, zero-based index.
 * Exact decimal strings avoid uint64 precision loss. Match on `kind` to read `index`.
 * MAX decodes as NoTransaction; legacy omission decodes as Transaction("0"). */
export type AccountTransactionIndex =
  | { readonly kind: 'Transaction'; readonly index: string }
  | { readonly kind: 'NoTransaction' };
/** Throws unless value is an exact, canonical uint64 decimal string. */
export declare function decodeAccountTransactionIndex(value: string): AccountTransactionIndex;
/** Use on both subscribe callback and decodeSubscribeUpdate account/block outputs.
 * Raw generated transactionIndex remains available for protobuf compatibility. */
export declare function getAccountTransactionIndex(account: { transactionIndex?: string }): AccountTransactionIndex;
