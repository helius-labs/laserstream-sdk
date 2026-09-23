import type { SubscribeUpdate } from '../client';

// Compile a consumer, not only declarations: an unresolved alias becoming `any`
// would make the negative Number assignment fail with an unused expect-error.
declare const update: SubscribeUpdate;
for (const bankId of [update.account?.bankId, update.slot?.bankId,
  update.transaction?.bankId, update.transactionStatus?.bankId,
  update.block?.bankId, update.blockMeta?.bankId, update.entry?.bankId]) {
  const exact: string | null | undefined = bankId;
  // @ts-expect-error uint64 bank IDs are decimal strings, never JS Numbers.
  const rounded: number = bankId;
  void exact; void rounded;
}
