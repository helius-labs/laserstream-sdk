# LaserStream NAPI

High-performance Solana gRPC streaming client using Rust + NAPI + Tonic for maximum bandwidth.

## Features

- **Zero-copy data transfer** between Rust and JavaScript
- **Native HTTP/2** handling with Tonic
- **Buffer pooling** for memory efficiency  
- **Real-time metrics** tracking
- **Batched message processing** for throughput optimization
- **Concurrent streaming** support

## Installation

```bash
# Install dependencies
npm install

# Build the native module
npm run build
```

## Usage

```javascript
const LaserStream = require('laserstream-napi');

const client = new LaserStream('https://yellowstone.rpcpool.com', 'your-token');

// Subscribe to all data types
const handle = await client.subscribeAll((buffer) => {
    // Raw protobuf buffer - parse as needed
    console.log(`Received ${buffer.length} bytes`);
});

// Get real-time metrics
setInterval(() => {
    const metrics = client.getMetrics();
    console.log(`Throughput: ${(metrics.totalBytesPerSec / 1024 / 1024).toFixed(2)} MB/s`);
}, 1000);
```

## Testing

### Bandwidth Test
```bash
ENDPOINT=https://your-endpoint TOKEN=your-token npm run test:bandwidth
```

### Benchmark vs Pure JS
```bash
ENDPOINT=https://your-endpoint TOKEN=your-token npm run test:benchmark
```

## Architecture

- **Rust Core**: Tonic gRPC client with optimized channel settings
- **NAPI Bindings**: Zero-copy buffer transfer to JavaScript
- **Buffer Pool**: Reusable memory allocation for efficiency
- **Stream Management**: Async stream handling with backpressure
- **Metrics Collection**: Real-time performance tracking

## Performance Targets

- **Latency**: < 1ms from gRPC receive to JS callback
- **Throughput**: > 1GB/s on modern hardware  
- **Memory**: Constant usage with buffer pooling
- **CPU**: < 5% overhead vs direct Rust consumption

## Configuration

The client is pre-configured with optimized settings:
- 100MB max message size
- 65MB HTTP/2 window size
- 30s keepalive interval
- Connection pooling enabled