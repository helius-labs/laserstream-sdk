import { subscribe, SubscribeRequest, SubscribeRequestFilterTransactions } from 'helius-laserstream';

const mintFilter: SubscribeRequestFilterTransactions = {
  accountInclude: ['So11111111111111111111111111111111111111112'],
  matchMints: true,
};
const request: SubscribeRequest = {
  transactions: { mint: mintFilter },
  transactionsStatus: { mint: { matchMints: false } },
};
// This is compile-only; it must never open a network connection.
void (() => subscribe({endpoint: '', apiKey: ''}, request, () => {}));
const bad: SubscribeRequestFilterTransactions = {
  // @ts-expect-error matchMints must be a boolean.
  matchMints: 'true',
};
void bad;
