// TypeScript declarations for Laserstream client

import type { ChannelOptions as GrpcChannelOptions } from '@grpc/grpc-js';
import { geyser, solana } from 'laserstream-core-proto-js/generated';

// protobufjs exposes messages in the geyser namespace. Export the interfaces
// so callers can pass plain subscription objects without constructing messages.
export type SubscribePreprocessedRequest = geyser.ISubscribePreprocessedRequest;
export type SubscribePreprocessedRequestFilterTransactions = geyser.ISubscribePreprocessedRequestFilterTransactions;
export type SubscribePreprocessedUpdate = geyser.ISubscribePreprocessedUpdate;
export type SubscribePreprocessedTransaction = geyser.ISubscribePreprocessedTransaction;
export type SubscribePreprocessedTransactionInfo = geyser.ISubscribePreprocessedTransactionInfo;
export type SubscribeUpdate = geyser.ISubscribeUpdate;
export type SubscribeUpdateAccount = geyser.ISubscribeUpdateAccount;
export type SubscribeUpdateAccountInfo = geyser.ISubscribeUpdateAccountInfo;
export type SubscribeUpdateSlot = geyser.ISubscribeUpdateSlot;
export type SubscribeUpdateTransaction = geyser.ISubscribeUpdateTransaction;
export type SubscribeUpdateTransactionInfo = geyser.ISubscribeUpdateTransactionInfo;
export type SubscribeUpdateTransactionStatus = geyser.ISubscribeUpdateTransactionStatus;
export type SubscribeUpdateBlock = geyser.ISubscribeUpdateBlock;
export type SubscribeUpdateBlockMeta = geyser.ISubscribeUpdateBlockMeta;
export type SubscribeUpdateEntry = geyser.ISubscribeUpdateEntry;
export type SubscribeUpdatePing = geyser.ISubscribeUpdatePing;
export type SubscribeUpdatePong = geyser.ISubscribeUpdatePong;
export type SubscribeRequest = geyser.ISubscribeRequest;
export type SubscribeRequestFilterAccounts = geyser.ISubscribeRequestFilterAccounts;
export type SubscribeRequestFilterAccountsFilter = geyser.ISubscribeRequestFilterAccountsFilter;
export type SubscribeRequestFilterSlots = geyser.ISubscribeRequestFilterSlots;
export type SubscribeRequestFilterTransactions = geyser.ISubscribeRequestFilterTransactions;
export type SubscribeRequestFilterBlocks = geyser.ISubscribeRequestFilterBlocks;
export type SubscribeRequestFilterBlocksMeta = geyser.ISubscribeRequestFilterBlocksMeta;
export type SubscribeRequestFilterEntry = geyser.ISubscribeRequestFilterEntry;
export type SubscribeRequestAccountsDataSlice = geyser.ISubscribeRequestAccountsDataSlice;
export type SubscribeRequestPing = geyser.ISubscribeRequestPing;
export import CommitmentLevel = geyser.CommitmentLevel;
export type SlotStatus = geyser.SlotStatus;
export type Transaction = solana.storage.ConfirmedBlock.ITransaction;
export type Message = solana.storage.ConfirmedBlock.IMessage;
export type MessageAddressTableLookup = solana.storage.ConfirmedBlock.IMessageAddressTableLookup;
export type TransactionStatusMeta = solana.storage.ConfirmedBlock.ITransactionStatusMeta;
export type TransactionError = solana.storage.ConfirmedBlock.ITransactionError;

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

// The native transport also supports zstd, which grpc-js does not expose.
export type ChannelOptions = Omit<GrpcChannelOptions, 'grpc.default_compression_algorithm'> & {
  'grpc.default_compression_algorithm'?: GrpcChannelOptions['grpc.default_compression_algorithm'] | CompressionAlgorithms;
};

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
    interface ISubscribeRequestFilterAccounts {
      /**
       * @deprecated No-op as of Agave 4.2. The validator now skips updates for
       * accounts a transaction write-locked but never wrote to, so `'write'`-only
       * delivery is the default and only behavior. Setting this has no effect; it
       * is accepted only for backward compatibility and will be removed in a
       * future release. (proto field #31)
       */
      notifyOn?: ('lock' | 'write' | null);
    }
  }
}
