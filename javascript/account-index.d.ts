/** Getter-only view: zero-based transaction index or native operation count per pubkey/bank. */
export type AccountIndex =
  | { readonly kind: 'NativeOperation'; readonly operationCount: number }
  | { readonly kind: 'TransactionIndex'; readonly index: number };
/** Decode raw uint64 strings; rejects the selected payload outside JS's safe nonnegative integer range. */
export declare function decodeAccountIndex(transactionIndex: string, nativeOperationCount?: string): AccountIndex;
/** Works on account updates and nested block accounts. Omitted legacy metadata means TransactionIndex(0). */
export declare function getAccountIndex(account: { transactionIndex?: string; nativeOperationCount?: string }): AccountIndex;
