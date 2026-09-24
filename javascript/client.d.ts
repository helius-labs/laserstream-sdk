// TypeScript declarations for Laserstream client

import type { geyser } from 'laserstream-core-proto-js/generated';

// The generated package exports a namespace, not these top-level aliases.
// Bind update outputs locally so callback/decoder types carry bank IDs.
export type SubscribeUpdate = geyser.ISubscribeUpdate;
export type SubscribeUpdateAccount = geyser.ISubscribeUpdateAccount;
export type SubscribeUpdateAccountInfo = geyser.ISubscribeUpdateAccountInfo;
export type SubscribeUpdateBlock = geyser.ISubscribeUpdateBlock;
export type SubscribeUpdateSlot = geyser.ISubscribeUpdateSlot;
export type SubscribeUpdateTransaction = geyser.ISubscribeUpdateTransaction;
export type SubscribeUpdateTransactionStatus = geyser.ISubscribeUpdateTransactionStatus;
export type SubscribeUpdateBlockMeta = geyser.ISubscribeUpdateBlockMeta;
export type SubscribeUpdateEntry = geyser.ISubscribeUpdateEntry;

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
  SubscribeUpdateTransactionInfo,
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

export interface SubscribeRequestFilterBlockFooter {}

export interface SubscribeUpdateBlockFooter {
  slot: string;
  bankId: string;
  bankHash: Uint8Array | Buffer;
  blockProducerTimeNanos: string;
  blockUserAgent: Uint8Array | Buffer;
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
    }

    interface SubscribeUpdate {
      blockFooter?: (SubscribeUpdateBlockFooter | null);
    }

    interface ISubscribeUpdateAccount { bankId?: (string | null); }
    interface ISubscribeUpdateSlot { bankId?: (string | null); }
    interface ISubscribeUpdateTransaction { bankId?: (string | null); }
    interface ISubscribeUpdateTransactionStatus { bankId?: (string | null); }
    interface ISubscribeUpdateBlock { bankId?: (string | null); }
    interface ISubscribeUpdateBlockMeta { bankId?: (string | null); }
    interface ISubscribeUpdateEntry { bankId?: (string | null); }
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
