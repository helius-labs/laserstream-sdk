# LaserStream NAPI-RS Implementation Plan

## Overview

This document outlines the complete implementation plan for converting the mock LaserStream NAPI module into a production-ready Tonic gRPC wrapper using NAPI-RS. The implementation will provide high-performance access to Yellowstone gRPC streams from Node.js.

## Current State Analysis

### What Exists
- ✅ Full Tonic gRPC client implementation (`client.rs`)
- ✅ Stream handling with batching and metrics (`stream.rs`)
- ✅ Buffer pooling for memory optimization (`buffer_pool.rs`)
- ✅ Comprehensive metrics system (`metrics.rs`)
- ✅ JavaScript wrapper and TypeScript definitions
- ❌ NAPI bindings (currently mock implementation)
- ❌ Proper JS-to-Protobuf conversion
- ❌ Reconnection logic
- ❌ Full filter support

### Architecture
```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   JavaScript    │────▶│   NAPI Layer    │────▶│   Tonic gRPC    │
│   (index.js)    │     │    (lib.rs)     │     │  (client.rs)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                │
                                ▼
                        ┌─────────────────┐
                        │  Stream Handler  │
                        │   (stream.rs)    │
                        └─────────────────┘
```

## Implementation Phases

### Phase 1: Core Structure Setup
**Priority: HIGH**  
**Files:** `src/lib.rs`

#### Tasks:
1. **Replace mock implementation with real bindings**
   ```rust
   #[napi]
   pub struct LaserStreamClient {
       inner: Arc<client::ClientInner>,
   }
   ```

2. **Export required types**
   - StreamHandle with cancel() and metrics()
   - StreamMetrics and GlobalMetrics as NAPI objects
   - Error types for proper error handling

3. **Add NAPI attributes**
   - `#[napi]` on all public structs and implementations
   - `#[napi(object)]` for plain data structures
   - `#[napi(constructor)]` for new() methods
   - `#[napi(getter)]` for property accessors

### Phase 2: Client Method Implementation
**Priority: HIGH**  
**Files:** `src/lib.rs`, `src/client.rs`

#### Tasks:
1. **Implement subscribe() method**
   ```rust
   #[napi]
   pub async fn subscribe(
       &self,
       request: Object,
       callback: JsFunction,
   ) -> Result<StreamHandle>
   ```

2. **Create JS-to-Protobuf converter**
   - Parse accounts, transactions, blocks, slots filters
   - Handle commitment levels
   - Process data slice configurations

3. **Wire up stream creation**
   - Create stream with proper lifecycle management
   - Return StreamHandle for control

### Phase 3: Request Parsing and Validation
**Priority: MEDIUM**  
**Files:** `src/converters.rs` (new), `src/lib.rs`

#### Detailed Filter Support:

**Account Filters:**
```typescript
{
  accounts: {
    "client": {
      account: ["pubkey1", "pubkey2"],
      owner: ["program1", "program2"],
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: "base58string"
          }
        },
        {
          datasize: 165
        },
        {
          lamports: {
            gt: 1000000,
            lt: 10000000
          }
        }
      ]
    }
  }
}
```

**Transaction Filters:**
```typescript
{
  transactions: {
    "client": {
      vote: false,
      failed: false,
      signature: ["sig1", "sig2"],
      accountInclude: ["account1"],
      accountExclude: ["account2"],
      accountRequired: ["account3"]
    }
  }
}
```

#### Implementation Steps:
1. Create type-safe parser for each filter type
2. Add validation for required fields
3. Handle optional parameters with defaults
4. Implement proper error messages for invalid inputs

### Phase 4: Error Handling
**Priority: MEDIUM**  
**Files:** `src/error.rs` (new)

#### Error Types:
```rust
#[derive(Debug)]
pub enum LaserStreamError {
    Connection(String),
    Parse(String),
    Stream(String),
    Cancelled,
    Internal(String),
}

impl From<LaserStreamError> for napi::Error {
    // Convert to NAPI errors with proper status codes
}
```

#### Requirements:
- Descriptive error messages
- Proper error codes for different scenarios
- Stack traces where applicable
- Graceful degradation

### Phase 5: Stream Operations
**Priority: MEDIUM**  
**Files:** `src/stream.rs`

#### Features:
1. **Cancel operation**
   - Immediate stream termination
   - Cleanup of resources
   - Metric preservation

2. **Metrics access**
   - Real-time performance data
   - Historical statistics
   - Memory usage tracking

3. **Lifecycle management**
   - Proper cleanup on drop
   - Resource leak prevention
   - State tracking

### Phase 6: TypeScript Definitions
**Priority: MEDIUM**  
**Files:** `index.d.ts`

#### Complete Interface:
```typescript
export interface LaserStreamClient {
  new(endpoint: string, token?: string): LaserStreamClient;
  subscribe(request: SubscribeRequest, callback: MessageCallback): Promise<StreamHandle>;
  readonly metrics: GlobalMetrics;
}

export interface StreamHandle {
  readonly id: string;
  cancel(): void;
  readonly metrics: StreamMetrics;
}

export interface SubscribeRequest {
  accounts?: { [key: string]: AccountFilter };
  transactions?: { [key: string]: TransactionFilter };
  blocks?: { [key: string]: BlockFilter };
  slots?: { [key: string]: SlotFilter };
  commitment?: Commitment;
  accountsDataSlice?: DataSlice[];
}

// ... complete type definitions
```

### Phase 7: Build Configuration
**Priority: MEDIUM**  
**Files:** `Cargo.toml`, `package.json`

#### Cargo.toml Updates:
```toml
[package.metadata.napi]
name = "laserstream-napi"
version = "0.1.0"

[dependencies]
napi = { version = "2", features = ["async", "tokio_rt", "napi8", "experimental"] }
napi-derive = "2"

[profile.release]
lto = true
opt-level = 3
codegen-units = 1
```

#### Build Scripts:
- Update `build.rs` for protobuf generation
- Configure GitHub Actions for multi-platform builds
- Add npm scripts for development

### Phase 8: Reconnection Logic
**Priority: MEDIUM**  
**Files:** `src/client.rs`

#### Implementation:
1. **Exponential backoff**
   - Initial delay: 100ms
   - Max delay: 30s
   - Jitter: ±10%

2. **State preservation**
   - Maintain subscription parameters
   - Resume from last known position
   - Notify JS of reconnection events

3. **Circuit breaker**
   - Fail after N attempts
   - Configurable thresholds
   - Health monitoring

### Phase 9: Testing Suite
**Priority: HIGH**  
**Files:** `test/`, `benches/`

#### Test Categories:
1. **Unit Tests**
   - Filter parsing
   - Error handling
   - Metrics calculation

2. **Integration Tests**
   - Real gRPC endpoint connection
   - Stream lifecycle
   - Multiple concurrent streams

3. **Performance Tests**
   - Throughput benchmarks
   - Memory usage profiling
   - Latency measurements

4. **Stress Tests**
   - High message rates
   - Large message sizes
   - Long-running streams

### Phase 10: Documentation
**Priority: LOW**  
**Files:** `README.md`, `docs/`, `examples/`

#### Documentation Sections:
1. **API Reference**
   - All methods and types
   - Code examples
   - Common patterns

2. **Performance Guide**
   - Benchmarks vs pure JS
   - Optimization tips
   - Resource usage

3. **Migration Guide**
   - From pure JS implementation
   - Breaking changes
   - Feature comparison

4. **Examples**
   - Basic usage
   - Advanced filtering
   - Multi-stream handling
   - Error recovery

## Performance Targets

### Throughput
- **Goal:** >100,000 messages/second per stream
- **Baseline:** 10,000 messages/second (pure JS)
- **Optimization:** Batching, buffer pooling, zero-copy

### Latency
- **Goal:** <1ms from gRPC receipt to JS callback
- **Current:** ~5-10ms with pure JS
- **Optimization:** Direct memory access, minimal allocations

### Memory
- **Goal:** <100MB baseline + dynamic buffers
- **Current:** ~500MB with pure JS
- **Optimization:** Buffer pooling, efficient data structures

### CPU Usage
- **Goal:** <10% overhead vs native Rust
- **Measurement:** Profile hot paths, optimize serialization

## Risk Mitigation

### Technical Risks
1. **NAPI version compatibility**
   - Test on Node 16, 18, 20
   - Use stable NAPI features only

2. **Memory leaks**
   - Implement proper cleanup
   - Use valgrind for testing
   - Monitor long-running processes

3. **Thread safety**
   - Use Arc for shared state
   - Minimize locking
   - Test concurrent access

### Operational Risks
1. **Breaking changes**
   - Version appropriately
   - Maintain compatibility layer
   - Clear migration documentation

2. **Platform support**
   - Test on Linux, macOS, Windows
   - Provide prebuilt binaries
   - Document build requirements

## Timeline Estimate

### Week 1-2: Foundation
- Phase 1: Core Structure
- Phase 2: Client Methods
- Basic testing

### Week 3-4: Features
- Phase 3: Request Parsing
- Phase 4: Error Handling
- Phase 5: Stream Operations

### Week 5-6: Polish
- Phase 6: TypeScript Definitions
- Phase 7: Build Configuration
- Phase 8: Reconnection Logic

### Week 7-8: Quality
- Phase 9: Testing Suite
- Phase 10: Documentation
- Performance optimization

## Success Criteria

1. **Functional Requirements**
   - ✅ All subscription types working
   - ✅ Proper error handling
   - ✅ Stream lifecycle management
   - ✅ Metrics collection

2. **Performance Requirements**
   - ✅ 10x throughput improvement
   - ✅ Sub-millisecond latency
   - ✅ Efficient memory usage

3. **Quality Requirements**
   - ✅ >90% test coverage
   - ✅ Zero memory leaks
   - ✅ Comprehensive documentation

## Appendix

### Useful Commands

```bash
# Build the module
npm run build

# Run tests
npm test

# Benchmark performance
npm run bench

# Check for memory leaks
npm run test:valgrind

# Generate documentation
npm run docs
```

### Resources
- [NAPI-RS Documentation](https://napi.rs)
- [Tonic Documentation](https://github.com/hyperium/tonic)
- [Yellowstone gRPC Spec](https://github.com/rpcpool/yellowstone-grpc)

### Contact
- Technical questions: [GitHub Issues](https://github.com/helius-labs/laserstream-sdk)
- Performance concerns: Run benchmarks and profiling
- Implementation details: See inline code documentation
