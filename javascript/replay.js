const { createHash } = require('node:crypto');

// Per-subscription state, retained across native transport reconnects.
class ReplayDedup {
  constructor() {
    this.newestSlot = 0n;
    this.seen = new Map();
  }

  beginConnection() {
    for (const updates of this.seen.values()) {
      for (const count of updates.values()) count.observed = 0;
    }
  }

  duplicate(update) {
    const kind = ['account', 'slot', 'transaction', 'transactionStatus', 'block', 'blockMeta', 'entry']
      .find(key => update[key]);
    if (!kind) return false;
    const payload = update[kind];
    const slot = BigInt(payload.slot);
    if (slot > this.newestSlot) this.newestSlot = slot;
    const oldest = this.newestSlot > 31n ? this.newestSlot - 31n : 0n;
    for (const retainedSlot of this.seen.keys()) {
      if (retainedSlot < oldest) this.seen.delete(retainedSlot);
    }
    // Scalar zero also represents an absent field on legacy sources. Do not
    // infer an identified bank from it. Optional explicit zero is identifiable.
    if (slot < oldest || payload.bankId == null ||
        (kind !== 'account' && kind !== 'slot' && payload.bankId === '0')) return false;
    // Preserve canonical indices, pubkeys and semantic content. Normalize only
    // a copy: users still receive the original worker's writeVersion unchanged.
    let identity = payload;
    if (kind === 'account' && (!payload.account || !payload.account.txnSignature?.length)) {
      // Worker ingest dedup is separate. Do not guess a native write's
      // position when the initial subscription starts mid-bank.
      return false;
    }
    if (kind === 'account' && payload.account) {
      identity = { ...payload, account: { ...payload.account, writeVersion: '0' } };
    } else if (kind === 'block') {
      // Compare the account multiset, not worker callback/assembly order.
      const accounts = payload.accounts
        .map(account => JSON.stringify({ ...account, writeVersion: '0' }))
        .sort();
      identity = { ...payload, accounts };
    }
    const key = createHash('sha256')
      .update(JSON.stringify([kind, identity, [...update.filters].sort()]))
      .digest('hex');
    let seen = this.seen.get(slot);
    if (!seen) this.seen.set(slot, seen = new Map());
    let count = seen.get(key);
    if (!count) seen.set(key, count = { delivered: 0, observed: 0 });
    // Preserve repeated notifications within a connection while removing
    // their replay overlap. Native account writes bypass this state.
    count.observed++;
    if (count.observed <= count.delivered) return true;
    count.delivered = count.observed;
    return false;
  }
}

module.exports = { ReplayDedup };
