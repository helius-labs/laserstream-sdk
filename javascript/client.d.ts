// TypeScript declarations for Laserstream client
import type { CommitmentLevel } from 'laserstream-core-proto-js/generated';
import type { geyser } from 'laserstream-core-proto-js/generated';
import type Long = require('long');

// protobufjs declarations model uint64 fields as `number | Long`, but the
// public decoder uses `longs: String` to preserve all 64 bits. Recursively map
// generated message inputs to the values users actually receive at runtime.
type DecodedProto<T> = [Extract<NonNullable<T>, Long>] extends [never]
  ? T extends Uint8Array
    ? T
    : T extends readonly (infer U)[]
      ? DecodedProto<U>[]
      : T extends object
        ? { [K in keyof T]: DecodedProto<T[K]> }
        : T
  : string | Extract<T, null | undefined>;

type DecodedSubscribeUpdate = Omit<DecodedProto<geyser.ISubscribeUpdate>, 'createdAt'> & {
  createdAt?: Date | null;
};

export type SubscribeUpdate = DecodedSubscribeUpdate;
export type SubscribeUpdateAccount = DecodedProto<geyser.ISubscribeUpdateAccount>;
export type SubscribeUpdateAccountInfo = DecodedProto<geyser.ISubscribeUpdateAccountInfo>;
export type SubscribeUpdateBlock = DecodedProto<geyser.ISubscribeUpdateBlock>;
export type SubscribeUpdateSlot = DecodedProto<geyser.ISubscribeUpdateSlot>;
export type SubscribeUpdateTransaction = DecodedProto<geyser.ISubscribeUpdateTransaction>;
export type SubscribeUpdateTransactionStatus = DecodedProto<geyser.ISubscribeUpdateTransactionStatus>;
export type SubscribeUpdateBlockMeta = DecodedProto<geyser.ISubscribeUpdateBlockMeta>;
export type SubscribeUpdateEntry = DecodedProto<geyser.ISubscribeUpdateEntry>;

// Request inputs use the JavaScript shapes consumed by napi-src/client.rs, not
// protobufjs' encoder shapes. In particular, native u64 fields are numbers and
// memcmp bytes are base64 strings.
export type SubscribeRequestFilterAccountsFilterMemcmp = Omit<
  geyser.ISubscribeRequestFilterAccountsFilterMemcmp,
  'offset' | 'bytes'
> & {
  offset?: number | null;
  bytes?: string | null;
};

export type SubscribeRequestFilterAccountsFilterLamports = Omit<
  geyser.ISubscribeRequestFilterAccountsFilterLamports,
  'eq' | 'ne' | 'lt' | 'gt'
> & {
  eq?: number | null;
  ne?: number | null;
  lt?: number | null;
  gt?: number | null;
};

export type SubscribeRequestFilterAccountsFilter = Omit<
  geyser.ISubscribeRequestFilterAccountsFilter,
  'memcmp' | 'datasize' | 'lamports'
> & {
  memcmp?: SubscribeRequestFilterAccountsFilterMemcmp | null;
  datasize?: number | null;
  lamports?: SubscribeRequestFilterAccountsFilterLamports | null;
};

export type SubscribeRequestFilterAccounts = Omit<geyser.ISubscribeRequestFilterAccounts, 'filters'> & {
  filters?: SubscribeRequestFilterAccountsFilter[] | null;
};

export type SubscribeRequestAccountsDataSlice = Omit<
  geyser.ISubscribeRequestAccountsDataSlice,
  'offset' | 'length'
> & {
  offset?: number | null;
  length?: number | null;
};

export type SubscribeRequest = Omit<
  geyser.ISubscribeRequest,
  'accounts' | 'accountsDataSlice' | 'fromSlot'
> & {
  accounts?: { [key: string]: SubscribeRequestFilterAccounts } | null;
  accountsDataSlice?: SubscribeRequestAccountsDataSlice[] | null;
  fromSlot?: number | null;
};

export type SubscribeRequestFilterSlots = geyser.ISubscribeRequestFilterSlots;
export type SubscribeRequestFilterTransactions = geyser.ISubscribeRequestFilterTransactions;
export type SubscribeRequestFilterBlocks = geyser.ISubscribeRequestFilterBlocks;
export type SubscribeRequestFilterBlocksMeta = geyser.ISubscribeRequestFilterBlocksMeta;
export type SubscribeRequestFilterEntry = geyser.ISubscribeRequestFilterEntry;
export type SubscribeRequestPing = geyser.ISubscribeRequestPing;

// Re-export gRPC types
export { ChannelOptions } from '@grpc/grpc-js';

// Re-export all proto types from laserstream-core-proto-js
export {
  // Regular subscription types
  SubscribeUpdateTransactionInfo,
  SubscribeUpdatePing,
  SubscribeUpdatePong,
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
  // When true, confirmed and finalized deliver every write of each bank. Retention is limited, so a fromSlot older than it fails with OUT_OF_RANGE. Default: false.
  intraSlotUpdates?: boolean;
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

export interface SubscribeRequestFilterBlockFooter {}

export interface SubscribeUpdateBlockFooter {
  slot: string;
  bankId: string;
  bankHash: Uint8Array | Buffer;
  blockProducerTimeNanos: string;
  blockUserAgent: Uint8Array | Buffer;
}

/**
 * Reports a bank cleared by an Alpenglow UpdateParent marker. Updates already
 * delivered for `clearedBankId` describe a bank that no longer exists: replay
 * restarts from the marker's FEC set and the new bank carries a different id.
 */
export interface SubscribeUpdateEntryUpdateParent {
  slot: string;
  clearedBankId: string;
  parentSlot: string;
  parentBlockId: Uint8Array | Buffer;
}

// Augment the generated proto type so `tokenAccounts` is accepted on
// transaction filters without forking the generated bindings. Removed once a
// core-proto-js release ships field #30 natively.
declare module 'laserstream-core-proto-js/generated' {
  namespace geyser {
    interface ISubscribeRequest {
      /** Triton-compatible footer subscription map (proto field #12). */
      blockFooter?: ({ [key: string]: SubscribeRequestFilterBlockFooter } | null);
    }

    interface SubscribeRequest {
      blockFooter?: ({ [key: string]: SubscribeRequestFilterBlockFooter } | null);
    }

    interface ISubscribeUpdate {
      /** Triton-compatible footer update (proto field #12). */
      blockFooter?: (SubscribeUpdateBlockFooter | null);
      /** Alpenglow UpdateParent notice (proto field #13). */
      entryUpdateParent?: (SubscribeUpdateEntryUpdateParent | null);
    }

    interface SubscribeUpdate {
      blockFooter?: (SubscribeUpdateBlockFooter | null);
      entryUpdateParent?: (SubscribeUpdateEntryUpdateParent | null);
    }

    interface ISubscribeUpdateAccount { bankId?: (string | null); }
    interface ISubscribeUpdateSlot { bankId?: (string | null); }
    interface ISubscribeUpdateTransaction { bankId?: (string | null); }
    interface ISubscribeUpdateTransactionStatus { bankId?: (string | null); }
    interface ISubscribeUpdateBlock { bankId?: (string | null); }
    interface ISubscribeUpdateBlockMeta { bankId?: (string | null); }
    interface ISubscribeUpdateEntry { bankId?: (string | null); }

    // Accepted by JsAccountFilter in napi-src/client.rs but absent from the
    // proto account filter, so declared here to keep existing callers compiling.
    interface ISubscribeRequestFilterAccounts {
      /** Not in the Helius docs; accepted by the native layer. */
      accountInclude?: (string[] | null);
      /** Not in the Helius docs; accepted by the native layer. */
      accountExclude?: (string[] | null);
      /** Not in the Helius docs; accepted by the native layer. */
      accountRequired?: (string[] | null);
      /**
       * Compressed account (cuckoo) filter.
       * Built client-side via {@link CompressedAccountFilterSet.insertIntoSubscribeRequest}.
       */
      cuckooAccountsFilter?: (import('./cuckoo').CuckooFilterProto | null);
    }

    interface ISubscribeRequestFilterEntry {
      /**
       * Include {@link SubscribeUpdateEntryUpdateParent} updates (proto field #1).
       * Omitted or false sends entries only.
       */
      includeUpdateParent?: (boolean | null);
    }

    interface SubscribeRequestFilterEntry {
      includeUpdateParent?: (boolean | null);
    }

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
