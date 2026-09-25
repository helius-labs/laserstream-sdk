// TypeScript declarations for Laserstream client
import type { CommitmentLevel } from 'laserstream-core-proto-js/generated';

// Re-export gRPC types
export { ChannelOptions } from '@grpc/grpc-js';

// Re-export all proto types from laserstream-core-proto-js
export {
  // Preprocessed subscription types
  SubscribePreprocessedRequest,
  SubscribePreprocessedRequestFilterTransactions,
  SubscribePreprocessedUpdate,
  SubscribePreprocessedTransaction,
  SubscribePreprocessedTransactionInfo,
  // Regular subscription types
  SubscribeUpdate,
  SubscribeUpdateAccount,
  SubscribeUpdateAccountInfo,
  SubscribeUpdateSlot,
  SubscribeUpdateTransaction,
  SubscribeUpdateTransactionInfo,
  SubscribeUpdateTransactionStatus,
  SubscribeUpdateBlock,
  SubscribeUpdateBlockMeta,
  SubscribeUpdateEntry,
  SubscribeUpdatePing,
  SubscribeUpdatePong,
  // Request types
  SubscribeRequest,
  SubscribeRequestFilterAccounts,
  SubscribeRequestFilterAccountsFilter,
  SubscribeRequestFilterSlots,
  SubscribeRequestFilterTransactions,
  SubscribeRequestFilterBlocks,
  SubscribeRequestFilterBlocksMeta,
  SubscribeRequestFilterEntry,
  SubscribeRequestAccountsDataSlice,
  SubscribeRequestPing,
  // Enums
  CommitmentLevel,
  SlotStatus,
} from 'laserstream-core-proto-js/generated';

// ============================================================================
// Compression and Configuration
// ============================================================================

// Compression algorithms enum
export declare enum CompressionAlgorithms {
  identity = 0,
  deflate = 1,
  gzip = 2,
  zstd = 3
}

// Configuration interface
export interface LaserstreamConfig {
  apiKey: string;
  endpoint: string;
  maxReconnectAttempts?: number;
  channelOptions?: ChannelOptions;
  // When true, enable replay on reconnects (uses fromSlot and internal slot tracking). When false, no replay.
  replay?: boolean;
}

// ============================================================================
// Stream Handle Interface
// ============================================================================

export interface StreamHandle {
  id: string;
  cancel(): void;
  write(request: SubscribeRequest): Promise<void>;
}

// ============================================================================
// Main API Functions
// ============================================================================

// Regular subscribe function using NAPI directly
export declare function subscribe(
  config: LaserstreamConfig,
  request: SubscribeRequest,
  onData: (update: SubscribeUpdate) => void | Promise<void>,
  onError?: (error: Error) => void | Promise<void>
): Promise<StreamHandle>;

// Preprocessed subscribe function
export declare function subscribePreprocessed(
  config: LaserstreamConfig,
  request: SubscribePreprocessedRequest,
  onData: (update: SubscribePreprocessedUpdate) => void | Promise<void>,
  onError?: (error: Error) => void | Promise<void>
): Promise<StreamHandle>;

// ============================================================================
// Unary RPCs
// ============================================================================

// uint64 values are decimal strings (same convention as subscribe updates).
export interface GetSlotResponse { slot: string }
export interface GetBlockHeightResponse { blockHeight: string }
export interface GetLatestBlockhashResponse { slot: string; blockhash: string; lastValidBlockHeight: string }
export interface IsBlockhashValidResponse { slot: string; valid: boolean }
export interface GetVersionResponse { version: string }
export interface PongResponse { count: number }
export interface SubscribeReplayInfoResponse { firstAvailable?: string }

/**
 * Client for unary (request/response) RPCs. Create once and reuse: all calls
 * share one HTTP/2 connection, opened lazily on the first call.
 * `commitment` defaults to the server default when omitted.
 */
export interface LaserstreamClientConfig extends Pick<LaserstreamConfig, 'endpoint' | 'apiKey' | 'channelOptions'> {
  /** Per-call deadline in milliseconds, including connecting (default 30000). */
  timeoutMs?: number;
}

export declare class LaserstreamClient {
  constructor(config: LaserstreamClientConfig);
  /** Releases the shared connection. In-flight calls complete; a later call reconnects. */
  close(): void;
  getSlot(commitment?: CommitmentLevel): Promise<GetSlotResponse>;
  getBlockHeight(commitment?: CommitmentLevel): Promise<GetBlockHeightResponse>;
  getLatestBlockhash(commitment?: CommitmentLevel): Promise<GetLatestBlockhashResponse>;
  isBlockhashValid(blockhash: string, commitment?: CommitmentLevel): Promise<IsBlockhashValidResponse>;
  getVersion(): Promise<GetVersionResponse>;
  ping(count?: number): Promise<PongResponse>;
  /**
   * Oldest slot this endpoint can replay from: the smallest usable `fromSlot`
   * (`firstAvailable` is undefined if the server reports no replay data).
   *
   * Call it right before subscribing with an explicit `fromSlot` (the value
   * moves forward as old data is evicted). A `fromSlot` below it may not be
   * servable, and the subscription can fail (e.g. `OUT_OF_RANGE`) instead of
   * streaming. Clamp with `Math.max(fromSlot, Number(firstAvailable))` and
   * treat the skipped slots as missed. `firstAvailable` is a decimal string,
   * but `fromSlot` in a subscribe request must be a number.
   *
   * It only reports this lower bound; it can't detect gaps in storage above it.
   * Despite the name, this is a single request/response call, not a stream.
   */
  subscribeReplayInfo(): Promise<SubscribeReplayInfoResponse>;
}

// ============================================================================
// Utility Functions
// ============================================================================

export declare function initProtobuf(): Promise<void>;
export declare function decodeSubscribeUpdate(bytes: Uint8Array): SubscribeUpdate;
export declare function decodeSubscribePreprocessedUpdate(bytes: Uint8Array): SubscribePreprocessedUpdate;
export declare function shutdownAllStreams(): void;
export declare function getActiveStreamCount(): number;

// ============================================================================
// Compressed account (cuckoo) filtering
// ============================================================================

export {
  CompressedAccountFilterSet,
  TableFullError,
  DEFAULT_HASH_SEED,
  CuckooFilterProto,
  CuckooAccountFilter,
  CuckooTransactionFilter,
  PubkeyInput,
} from './cuckoo';

// ============================================================================
// tokenAccounts (ATA) transaction filter
// ============================================================================

/**
 * ATA (Associated Token Account) expansion mode for the `tokenAccounts` field
 * on transaction / transactionsStatus filters.
 *
 * - `"none"`           — no expansion (default; same as omitting the field).
 * - `"balanceChanged"` — also match txs touching an ATA owned by an
 *                        `accountInclude` wallet whose token balance changed.
 * - `"all"`            — match any tx touching an ATA owned by an
 *                        `accountInclude` wallet.
 *
 * The JS-facing API accepts these strings for ergonomics; the NAPI layer
 * converts to the proto enum (`TokenAccountExpansionControlFlag` at field
 * #30) before sending on the wire. Invalid strings raise at subscribe time.
 */
export type TokenAccountsFilterMode = 'none' | 'balanceChanged' | 'all';

// Augment the generated proto type so `tokenAccounts` is accepted on
// transaction filters without forking the generated bindings. Removed once a
// core-proto-js release ships field #30 natively.
declare module 'laserstream-core-proto-js/generated' {
  namespace geyser {
    interface ISubscribeRequestFilterTransactions {
      /** Helius ATA expansion control (proto field #30). */
      tokenAccounts?: (TokenAccountsFilterMode | string | null);
      /**
       * Compressed account (cuckoo) filter over `accountInclude` (proto field #31).
       * Built client-side via {@link CompressedAccountFilterSet.toTransactionFilter}.
       */
      cuckooAccountInclude?: (import('./cuckoo').CuckooFilterProto | null);
      /**
       * Helius mint matching (proto field #32). When true, `accountInclude` /
       * `accountExclude` / `accountRequired` also match against the mints of
       * pre/post token balances — catches classic SPL `Transfer`s, whose
       * account keys never contain the mint. Put mints in `accountInclude`
       * to stream every transaction touching those tokens.
       */
      matchMints?: (boolean | null);
    }
  }
}
