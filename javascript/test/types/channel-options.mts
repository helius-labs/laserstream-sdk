// Compile-time checks for the ChannelOptions declarations.
//
// Run with `npm run test:types`. Nothing here executes; a failure is a tsc
// error. ChannelOptions used to be re-exported from @grpc/grpc-js, which is
// not a dependency, so the documented camelCase fields below were untyped.

import type { ChannelOptions, LaserstreamConfig } from 'helius-laserstream';

// @ts-expect-error: ChannelOptions must not accept null.
export const channelOptionsCheck: ChannelOptions = null;

// Every camelCase field documented in the README and
// examples/channel-options-example.ts must compile.
export const documentedFields: ChannelOptions = {
  connectTimeoutSecs: 20,
  timeoutSecs: 60,
  maxDecodingMessageSize: 2_000_000_000,
  maxEncodingMessageSize: 64_000_000,
  http2KeepAliveIntervalSecs: 15,
  keepAliveTimeoutSecs: 10,
  keepAliveWhileIdle: true,
  initialStreamWindowSize: 8_388_608,
  initialConnectionWindowSize: 16_777_216,
  http2AdaptiveWindow: true,
  tcpNodelay: true,
  tcpKeepaliveSecs: 30,
  bufferSize: 131_072,
};

// The README assigns through LaserstreamConfig.channelOptions; existing
// grpc.* keys current callers pass must keep compiling.
export const configCheck: LaserstreamConfig = {
  apiKey: 'key',
  endpoint: 'https://example.com',
  channelOptions: { 'grpc.keepalive_time_ms': 20_000, 'grpc-node.max_session_memory': 4_194_304 },
};

export const misspelledField: ChannelOptions = {
  // @ts-expect-error: "connectTimeoutSec" is a typo for "connectTimeoutSecs".
  connectTimeoutSec: 20,
};
