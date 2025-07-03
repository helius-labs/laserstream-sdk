import net from 'net';
import { randomInt } from 'crypto';

/* dial the proxy in your test script */
const LOCAL_PORT  = 4003;

/* real plaintext Laserstream edge */
const REMOTE_HOST = '';
const REMOTE_PORT = 4001;

/* online / offline windows */
const MIN_UP  = 20_000, MAX_UP  = 60_000;
const MIN_DN  =  5_000, MAX_DN  = 30_000;

let online  = true;
let flipAt  = Date.now() + randomInt(MIN_UP, MAX_UP);
const live  : net.Socket[] = [];

function flip() {
  const now = Date.now();
  if (now >= flipAt) {
    online = !online;
    console.log(`[proxy] ⇆  ${online ? 'ONLINE' : 'OFFLINE'}`);
    if (!online) live.splice(0).forEach(s => s.destroy());
    flipAt = now + randomInt(online ? MIN_UP : MIN_DN, online ? MAX_UP : MAX_DN);
  }
  setTimeout(flip, 500);
}
flip();

net.createServer(client => {
  if (!online) { client.destroy(); return; }

  const upstream = net.connect({ host: REMOTE_HOST, port: REMOTE_PORT },
    () => console.log('[proxy] → upstream connected'));

  /* little perf boost: disable Nagle both ways */
  client.setNoDelay(true);  upstream.setNoDelay(true);

  client.pipe(upstream);  upstream.pipe(client);

  /* housekeeping so we can nuke everything fast */
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
  console.log(`[proxy] listening on localhost:${LOCAL_PORT} → ${REMOTE_HOST}:${REMOTE_PORT}`));
