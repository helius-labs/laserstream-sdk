'use strict';
// The public JS API, fresh NAPI binding and actual HTTP/2 transport are mandatory.
const assert = require('node:assert/strict');
const sdk = require(process.env.SDK_REPLAY_JS_PACKAGE || '../client');
async function main() {
  const endpoint = process.env.SDK_REPLAY_ENDPOINT;
  assert(endpoint.startsWith('http://127.0.0.1:'));
  const fromSlot = process.env.SDK_REPLAY_FROM_SLOT === '' ? undefined : Number(process.env.SDK_REPLAY_FROM_SLOT);
  assert(fromSlot === undefined || (Number.isSafeInteger(fromSlot) && fromSlot >= 0), 'JS request slot must be exactly representable');
  let resolve, reject;
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  const timer = setTimeout(() => reject(Error('replay consumer deadline')), 100000);
  try {
    await sdk.subscribe({ endpoint, apiKey: '', replay: process.env.SDK_REPLAY_ENABLED === 'true', maxReconnectAttempts: 10 },
      { fromSlot }, update => {
        if (update.filters.length === 1 && update.filters[0] === '__sdk_test_done') resolve();
        else console.log('SDK_UPDATE ' + JSON.stringify({ decoded: update }));
      }, reject);
    await done;
  } finally {
    clearTimeout(timer);
    sdk.shutdownAllStreams();
  }
}
function finish(code) {
  // Flush potentially large captured banks before terminating the native runtime.
  process.stdout.write('', () => process.exit(code));
}
main().then(() => finish(0), e => { console.error(e); finish(1); });
