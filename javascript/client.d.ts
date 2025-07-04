// TypeScript declarations for Laserstream client with protobuf decoding

// Configuration interface
export interface LaserstreamConfig {
  apiKey: string;
  endpoint: string;
  maxReconnectAttempts?: number;
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

// Subscribe update interface
export interface SubscribeUpdate {
  filters: string[];
  createdAt: Date;
  account?: any;
  slot?: any;
  transaction?: any;
  transactionStatus?: any;
  block?: any;
  blockMeta?: any;
  entry?: any;
  ping?: any;
  pong?: any;
}

// Stream handle interface
export interface StreamHandle {
  id: string;
  cancel(): void;
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