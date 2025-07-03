// ES Module wrapper for LaserStream client
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Import everything from the CommonJS client
const clientModule = require('./client.js');
const indexModule = require('./index.js');

// Export clean API for ES modules
export const subscribe = clientModule.subscribe;
export const CommitmentLevel = clientModule.CommitmentLevel;
export const initProtobuf = clientModule.initProtobuf;
export const decodeSubscribeUpdate = clientModule.decodeSubscribeUpdate;

// Export utility functions
export const shutdownAllStreams = indexModule.shutdownAllStreams;
export const getActiveStreamCount = indexModule.getActiveStreamCount;

// Export types (these are just for TypeScript, no runtime effect)
// The actual type definitions will come from index.d.ts 