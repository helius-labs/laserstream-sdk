/** Getter-only view: zero-based integer index, or a runtime-generated write. */
export type AccountTransactionIndex =
  | { readonly kind: 'Transaction'; readonly index: number }
  | { readonly kind: 'NoTransaction' };
/** Decode the uint64 wire value; rejects transaction indices outside JS's safe integer range. */
export declare function decodeAccountTransactionIndex(value: string): AccountTransactionIndex;
/** Works on account updates and nested block accounts. Omitted legacy metadata means index 0. */
export declare function getAccountTransactionIndex(account: { transactionIndex?: string }): AccountTransactionIndex;
