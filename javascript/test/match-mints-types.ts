import { subscribe, SubscribeRequest, SubscribeRequestFilterTransactions, StreamHandle, CommitmentLevel, CompressionAlgorithms } from '../client';

const mintFilter: SubscribeRequestFilterTransactions = {
  accountInclude: ['So11111111111111111111111111111111111111112'],
  matchMints: true,
};
const request: SubscribeRequest = {
  transactions: { mint: mintFilter },
  transactionsStatus: { mint: { matchMints: false } },
  commitment: CommitmentLevel.CONFIRMED,
};
// This is compile-only; it must never open a network connection.
void (() => subscribe({endpoint: '', apiKey: ''}, request, () => {}));
const bad: SubscribeRequestFilterTransactions = {
  // @ts-expect-error matchMints must be a boolean.
  matchMints: 'true',
};
void bad;

declare const handle: StreamHandle;
void (() => handle.write(request));
// @ts-expect-error write requests retain the filter's boolean type.
void (() => handle.write({transactions: {mint: {matchMints: 1}}}));
// @ts-expect-error inline subscribe requests must also reject strings.
void (() => subscribe({endpoint: '', apiKey: ''}, {transactions: {mint: {matchMints: 'true'}}}, () => {}));
void (() => subscribe({endpoint: '', apiKey: '', channelOptions: {
  'grpc.default_compression_algorithm': CompressionAlgorithms.zstd,
}}, request, () => {}));
