/** Getter-only view: no transaction or an unshifted zero-based transaction index. */
export type AccountIndex =
  | { readonly kind: 'NoTransaction' }
  | { readonly kind: 'Transaction'; readonly index: number };
/** Decode a raw uint64 string; exact UINT64_MAX means NoTransaction, otherwise requires a safe nonnegative integer. */
export declare function decodeAccountIndex(transactionIndex: string): AccountIndex;
/** Works on account updates and nested block accounts. Omitted legacy metadata means Transaction(0). */
export declare function getAccountIndex(account: { transactionIndex?: string }): AccountIndex;
