// Compile-time checks for values returned by decodeSubscribeUpdate/subscribe.
// Runtime uint64 values are decimal strings because protobufjs decodes with
// `longs: String`; the public declarations must expose that exact contract.

import type {
  SubscribeUpdate,
  SubscribeUpdateAccount,
  SubscribeUpdateBlock,
  SubscribeUpdateSlot,
  SubscribeUpdateTransaction,
} from 'helius-laserstream';

const maxUint64 = '18446744073709551615';

export const accountUpdate: SubscribeUpdateAccount = { slot: maxUint64 };
export const slotUpdate: SubscribeUpdateSlot = { slot: maxUint64, parent: '42' };
export const transactionUpdate: SubscribeUpdateTransaction = { slot: maxUint64 };
export const blockUpdate: SubscribeUpdateBlock = { slot: maxUint64, blockHeight: { blockHeight: maxUint64 } };

// The recursive mapping must apply through the top-level update union too.
export const nestedUpdate: SubscribeUpdate = {
  transaction: { slot: maxUint64 },
  createdAt: new Date(0),
};

// @ts-expect-error: decoded uint64 values are never numbers.
export const numericSlot: SubscribeUpdateSlot = { slot: 42 };
// @ts-expect-error: createdAt is converted from Timestamp to Date.
export const timestampObject: SubscribeUpdate = { createdAt: { seconds: 0, nanos: 0 } };
