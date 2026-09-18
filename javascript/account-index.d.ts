/** Unshifted, zero-based index. Exact decimal strings avoid uint64 precision loss. */
export type AccountTransactionIndex =
  | { readonly kind: 'Transaction'; readonly index: string }
  | { readonly kind: 'NoTransaction' };
export declare const AccountTransactionIndex: {
  readonly NoTransaction: { readonly kind: 'NoTransaction' };
  /** Throws for the reserved NoTransaction value or an invalid uint64. */
  Transaction(index: string): { readonly kind: 'Transaction'; readonly index: string };
};
export declare function decodeAccountTransactionIndex(value: string): AccountTransactionIndex;
export declare function encodeAccountTransactionIndex(value: AccountTransactionIndex): string;
/** Use on both subscribe callback and decodeSubscribeUpdate account/block outputs.
 * Raw transactionIndex remains an exact decimal string. Old omission means Transaction("0"). */
export declare function getAccountTransactionIndex(account: { transactionIndex?: string }): AccountTransactionIndex;
export declare function setAccountTransactionIndex(account: { transactionIndex?: string }, value: AccountTransactionIndex): void;
