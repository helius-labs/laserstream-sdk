// TypeScript declarations for the cuckoo (compressed account) filter builder.

import { SubscribeRequest } from 'laserstream-core-proto-js/generated';

/** Default SipHash seed ("yllwstn!"). Always serialized on the wire. */
export declare const DEFAULT_HASH_SEED: bigint;
export declare const ENTRIES_PER_BUCKET: number;
export declare const FINGERPRINT_BITS: number;

/** Thrown when the filter is saturated — rebuild with a larger capacity. */
export declare class TableFullError extends Error {}

/** Wire form of a cuckoo filter, consumed by the native layer. */
export interface CuckooFilterProto {
  /** base64-encoded little-endian u16 fingerprints, row-major */
  data: string;
  bucketCount: number;
  entriesPerBucket: number;
  fingerprintBits: number;
  /** decimal u64 string */
  hashSeed: string;
  hashAlgorithm: number;
}

/** Account filter carrying only a cuckoo filter. */
export interface CuckooAccountFilter {
  account: string[];
  owner: string[];
  filters: never[];
  cuckooAccountsFilter: CuckooFilterProto;
}

/** Transaction filter carrying only a cuckoo filter. */
export interface CuckooTransactionFilter {
  accountInclude: string[];
  accountExclude: string[];
  accountRequired: string[];
  cuckooAccountInclude: CuckooFilterProto;
}

/** A pubkey accepted by the filter: base58 string, raw 32 bytes, or PublicKey-like. */
export type PubkeyInput = string | Uint8Array | Buffer | number[] | { toBytes(): Uint8Array };

/**
 * Safe, tracked builder for a compressed-account (cuckoo) filter.
 *
 * Keeps an exact `Set` of pubkeys alongside the probabilistic fingerprint table.
 * Send the filter once via {@link insertIntoSubscribeRequest}; after mutating the
 * tracked set, re-send the (rebuilt) request on the SAME stream with
 * `stream.write(request)` when {@link takeDirty} returns true. The server may
 * deliver <1% false positives — re-check locally with {@link contains}.
 */
export declare class CompressedAccountFilterSet {
  /**
   * @param capacity max number of pubkeys to track (sizes the table).
   * @param hashSeed optional wire seed override (default "yllwstn!").
   */
  constructor(capacity: number, hashSeed?: bigint);

  readonly bucketCount: number;
  readonly hashSeed: bigint;
  readonly size: number;

  /** Insert a pubkey. Returns true if newly added, false if already present. Throws {@link TableFullError} when saturated. */
  insert(pubkey: PubkeyInput): boolean;
  /** Remove a pubkey; returns whether it was present. */
  remove(pubkey: PubkeyInput): boolean;
  /** Exact membership (no false positives). */
  contains(pubkey: PubkeyInput): boolean;
  isEmpty(): boolean;
  /** True if mutated since the last takeDirty()/insertIntoSubscribeRequest(). */
  isDirty(): boolean;
  /** Returns the dirty flag and clears it. true → rebuild and re-send. */
  takeDirty(): boolean;
  /** Iterate tracked pubkeys as hex strings. */
  keys(): IterableIterator<string>;
  /** Serialize to the wire CuckooFilter shape. */
  toProto(): CuckooFilterProto;
  /** Raw serialized filter bytes (LE u16 fingerprints). */
  toBytes(): Buffer;
  /** An account filter carrying only this cuckoo filter. */
  toAccountFilter(): CuckooAccountFilter;
  /** A transaction filter carrying only this cuckoo filter. */
  toTransactionFilter(): CuckooTransactionFilter;
  /** Insert into request.accounts[name] (replacing any existing entry) and clear the dirty flag. */
  insertIntoSubscribeRequest(request: SubscribeRequest, name: string): SubscribeRequest;
}
