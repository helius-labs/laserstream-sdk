// TypeScript declarations for Laserstream client with protobuf decoding

// Re-export gRPC types directly
export { ChannelOptions } from '@grpc/grpc-js';

// Re-export Yellowstone proto types directly
export {
  SubscribeUpdate,
  SubscribeUpdateAccount,
  SubscribeUpdateAccountInfo,
  SubscribeUpdateBlock,
  SubscribeUpdateBlockMeta,
  SubscribeUpdateSlot,
  SubscribeUpdateTransaction,
  SubscribeUpdateTransactionInfo,
  SubscribeUpdateTransactionStatus,
  SubscribeUpdateEntry,
  SubscribeUpdatePing,
  SubscribeUpdatePong,
  SubscribeRequest,
  SubscribeRequestFilterAccounts,
  SubscribeRequestFilterSlots,
  SubscribeRequestFilterTransactions,
  SubscribeRequestFilterBlocks,
  SubscribeRequestFilterBlocksMeta,
  SubscribeRequestFilterEntry,
  SubscribeRequestAccountsDataSlice,
  SubscribeRequestPing,
} from '@triton-one/yellowstone-grpc/dist/types/grpc/geyser';

export {
  MessageAddressTableLookup,
  Message,
  Transaction,
  TransactionStatusMeta,
  TransactionError,
} from '@triton-one/yellowstone-grpc/dist/types/grpc/solana-storage';

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

// Subscription request interface
export interface SubscribeRequest {
  accounts?: { [key: string]: any };
  slots?: { [key: string]: any };
  transactions?: { [key: string]: any };
  transactionsStatus?: { [key: string]: any };
  blocks?: { [key: string]: any };
  blocksMeta?: { [key: string]: any };
  entry?: { [key: string]: any };
  accountsDataSlice?: any[];
  commitment?: number;
  ping?: any;
  fromSlot?: number;
}


// Stream handle interface
export interface StreamHandle {
  id: string;
  cancel(): void;
  write(request: SubscribeRequest): Promise<void>;
}

// Commitment level enum
export declare const CommitmentLevel: {
  readonly PROCESSED: 0;
  readonly CONFIRMED: 1;
  readonly FINALIZED: 2;
};

// Single subscribe function using NAPI directly
export declare function subscribe(
  config: LaserstreamConfig,
  request: SubscribeRequest,
  onData: (update: SubscribeUpdate) => void | Promise<void>,
  onError?: (error: Error) => void | Promise<void>
): Promise<StreamHandle>;

// Utility functions
export declare function initProtobuf(): Promise<void>;
export declare function decodeSubscribeUpdate(bytes: Uint8Array): SubscribeUpdate;
export declare function shutdownAllStreams(): void;
export declare function getActiveStreamCount(): number; 