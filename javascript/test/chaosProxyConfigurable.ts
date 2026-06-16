import net from 'net';
import { randomInt } from 'crypto';
const cfg = require('../test-config');

/*
 * Configurable variant of laserstreamChaosProxy.ts — identical proxying logic,
 * but online/offline windows + listen port are env-driven so tests can drive
 * reconnect/replay deterministically. Defaults match the original proxy.
 *
 *   CHAOS_LOCAL_PORT  (default 4003)
 *   CHAOS_MIN_UP / CHAOS_MAX_UP  online window ms (default 20000 / 60000)
 *   CHAOS_MIN_DN / CHAOS_MAX_DN  offline window ms (default 5000 / 30000)
 *   CHAOS_FIRST_UP    ms before the very first flip (default = random MIN_UP..MAX_UP)
 */
const LOCAL_PORT  = Number(process.env.CHAOS_LOCAL_PORT  ?? cfg.localProxyPort ?? 4003);
const REMOTE_HOST = cfg.proxy.endpoint;
const REMOTE_PORT = cfg.proxy.port;

const MIN_UP = Number(process.env.CHAOS_MIN_UP ?? 20_000);
const MAX_UP = Number(process.env.CHAOS_MAX_UP ?? 60_000);
const MIN_DN = Number(process.env.CHAOS_MIN_DN ?? 5_000);
const MAX_DN = Number(process.env.CHAOS_MAX_DN ?? 30_000);
const FIRST_UP = process.env.CHAOS_FIRST_UP ? Number(process.env.CHAOS_FIRST_UP) : randomInt(MIN_UP, MAX_UP);

let online  = true;
let flipAt  = Date.now() + FIRST_UP;
const live  : net.Socket[] = [];
const ts = () => new Date().toISOString().slice(11, 23);

function flip() {
  const now = Date.now();
  if (now >= flipAt) {
    online = !online;
    const dwell = randomInt(online ? MIN_UP : MIN_DN, online ? MAX_UP : MAX_DN);
    console.log(`[proxy ${ts()}] ⇆  ${online ? 'ONLINE' : 'OFFLINE'} (for ~${Math.round(dwell/1000)}s, killed ${online ? 0 : live.length} conns)`);
    if (!online) live.splice(0).forEach(s => s.destroy());
    flipAt = now + dwell;
  }
  setTimeout(flip, 250);
}
console.log(`[proxy ${ts()}] windows: UP ${MIN_UP/1000}-${MAX_UP/1000}s, DOWN ${MIN_DN/1000}-${MAX_DN/1000}s, first flip in ${Math.round(FIRST_UP/1000)}s`);
flip();

net.createServer(client => {
  if (!online) { client.destroy(); return; }

  const upstream = net.connect({ host: REMOTE_HOST, port: REMOTE_PORT },
    () => console.log(`[proxy ${ts()}] → upstream connected`));

  client.setNoDelay(true);  upstream.setNoDelay(true);
  client.pipe(upstream);  upstream.pipe(client);

  live.push(client, upstream);
  const clean = () => {
    client.destroy(); upstream.destroy();
    [client, upstream].forEach(s => {
      const i = live.indexOf(s); if (i !== -1) live.splice(i, 1);
    });
  };
  client   .on('error', clean).on('close', clean);
  upstream .on('error', clean).on('close', clean);
}).listen(LOCAL_PORT, () =>
  console.log(`[proxy ${ts()}] listening on localhost:${LOCAL_PORT} → ${REMOTE_HOST}:${REMOTE_PORT}`));
