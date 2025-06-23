export interface StreamMetrics {
  messagesPerSec: number;
  bytesPerSec: number;
  totalMessages: number;
  totalBytes: number;
  avgLatencyMs: number;
}

export interface GlobalMetrics {
  activeStreams: number;
  totalMessagesPerSec: number;
  totalBytesPerSec: number;
  totalMessages: number;
  totalBytes: number;
}

export interface StreamHandle {
  id: string;
  cancel(): void;
  readonly metrics: StreamMetrics;
}

export interface SubscribeRequest {
  accounts?: {};
  transactions?: {};
  blocks?: {};
  slots?: {};
}

declare class LaserStream {
  constructor(endpoint: string, token?: string | null);
  
  subscribe(
    request: SubscribeRequest, 
    onMessage: (buffer: Buffer) => void,
    onError?: (error: Error) => void
  ): Promise<StreamHandle>;
  
  subscribeAll(
    onMessage: (buffer: Buffer) => void,
    onError?: (error: Error) => void
  ): Promise<StreamHandle>;
  
  createParallelStreams(
    count: number,
    request: SubscribeRequest,
    onMessage: (buffer: Buffer) => void,
    onError?: (error: Error) => void
  ): Promise<StreamHandle[]>;
  
  getMetrics(): GlobalMetrics;
  getStreamMetrics(streamId: string): StreamMetrics | null;
  close(): Promise<void>;
}

export = LaserStream;