// Black-box release checks: real SDK clients talk to a local gRPC server, or
// to a live endpoint with an independent oracle over each received transaction.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');
const protobuf = require('protobufjs');
const bs58 = require('bs58');

const ROOT = path.resolve(__dirname, '../..');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RANDOM = bs58.encode(Buffer.alloc(32, 197));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
async function until(predicate, description, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = predicate(); if (result) return result; await sleep(20); }
  throw new Error(`Timeout: ${description}`);
}
function config() {
  // Credentials are read locally and passed only in subprocess environments.
  // Never put them in argv, reports, or captured request logs.
  const env = {...process.env};
  if (env.MINT_ENV_FILE) {
    for (const line of fs.readFileSync(env.MINT_ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?(\w+)\s*=\s*(.*?)\s*$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  env.MINT_ENDPOINT ||= env.LASERSTREAM_PRODUCTION_ENDPOINT;
  env.MINT_API_KEY ||= env.LASERSTREAM_PRODUCTION_API_KEY;
  return env;
}
class Client {
  constructor(sdk, env) {
    this.sdk = sdk; this.events = []; this.errors = []; this.stderr = '';
    const command = sdk.startsWith('javascript') ? [process.execPath, path.join(__dirname, 'clients/javascript.js')]
      : sdk === 'go' ? [path.join(__dirname, 'clients/go/client')]
      : [path.join(__dirname, 'clients/rust/target/debug/mint-filter-client')];
    this.child = spawn(command[0], command.slice(1), {env, stdio: ['pipe', 'pipe', 'pipe']});
    this.child.on('error', e => this.errors.push({type: 'fatal', message: e.message}));
    this.child.on('exit', (code, signal) => {this.exited = {code, signal};});
    this.child.stderr.on('data', b => {this.stderr = (this.stderr + b).slice(-8000);});
    readline.createInterface({input: this.child.stdout}).on('line', line => {
      let e; try {e = JSON.parse(line);} catch {return;}
      if (['error', 'fatal', 'commandError'].includes(e.type)) this.errors.push(e);
      if (['transaction', 'status', 'slot'].includes(e.type) && this.onUpdate) this.onUpdate(e);
      else this.events.push(e);
    });
  }
  send(action, request, extra = {}) {
    // Go uses the official enum spelling; the JS API deliberately uses strings.
    let converted = structuredClone(request);
    if (this.sdk.startsWith('javascript') && converted) {
      if (converted.fromSlot !== undefined) converted.fromSlot = Number(converted.fromSlot);
      for (const map of ['transactions', 'transactionsStatus']) {
        for (const f of Object.values(converted[map] || {})) {
          if (f.tokenAccounts === 'ALL') f.tokenAccounts = 'all';
          if (f.tokenAccounts === 'BALANCE_CHANGED') f.tokenAccounts = 'balanceChanged';
        }
      }
      if (this.sdk === 'javascript-snake') {
        const snake = o => Array.isArray(o) ? o.map(snake) : o && typeof o === 'object'
          ? Object.fromEntries(Object.entries(o).map(([k,v]) => [k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), snake(v)])) : o;
        converted = snake(converted);
      }
    }
    this.child.stdin.write(JSON.stringify({action, request: converted, ...extra}) + '\n');
  }
  async stop() {
    if (!this.exited) this.send('stop');
    try {await until(() => this.exited, `${this.sdk} exit`, 5000);} catch {this.child.kill('SIGKILL');}
  }
}
function normalized(filter) {
  const f = structuredClone(filter);
  for (const field of ['accountInclude', 'accountExclude', 'accountRequired']) f[field] ||= [];
  f.matchMints ||= false;
  if (f.tokenAccounts === 'ALL') f.tokenAccounts = 0;
  if (f.tokenAccounts === 'BALANCE_CHANGED') f.tokenAccounts = 1;
  return f;
}
function checkRequest(actual, expected) {
  for (const map of ['transactions', 'transactionsStatus']) {
    assert.deepEqual(Object.keys(actual[map] || {}).sort(), Object.keys(expected[map] || {}).sort(), `${map} names`);
    for (const [name, f] of Object.entries(expected[map] || {})) {
      assert.deepEqual(normalized(actual[map][name]), normalized(f), `${map}.${name}`);
      if (!f.matchMints) assert(!Object.hasOwn(actual[map][name], 'matchMints'), 'false must be absent on the wire');
    }
  }
}
async function mockServer() {
  const root = await protobuf.load(path.join(ROOT, 'javascript/proto/geyser.proto'));
  const Request = root.lookupType('geyser.SubscribeRequest');
  const Update = root.lookupType('geyser.SubscribeUpdate');
  const server = new grpc.Server();
  const calls = [], requests = [];
  server.addService({subscribe: {path: '/geyser.Geyser/Subscribe', requestStream: true, responseStream: true,
    requestDeserialize: b => {
      const message = Request.decode(b);
      // Prost legitimately omits a map entry's empty message value. protobufjs
      // decodes that as null; materialize the default before calling toObject.
      for (const field of Object.values(Request.fields)) if (field.map && message[field.name]) {
        for (const key of Object.keys(message[field.name])) message[field.name][key] ||= field.resolvedType.create();
      }
      return Request.toObject(message, {longs: String, enums: Number, bytes: Buffer});
    },
    requestSerialize: o => Buffer.from(Request.encode(Request.fromObject(o)).finish()),
    responseDeserialize: b => Update.decode(b),
    responseSerialize: o => Buffer.from(Update.encode(Update.fromObject(o)).finish())}},
  {subscribe: call => {
    call.sendMetadata(new grpc.Metadata());
    calls.push(call); call.on('error', () => {});
    call.on('data', request => {
      requests.push({call, request});
      if (request.ping) call.write({pong: {id: request.ping.id}});
    });
  }});
  const port = await new Promise((resolve,reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e,p) => e ? reject(e) : resolve(p)));
  return {server, calls, requests, endpoint: `http://127.0.0.1:${port}`};
}
async function local(sdk, replay) {
  const mock = await mockServer();
  const client = new Client(sdk, {...process.env, MINT_ENDPOINT: mock.endpoint, MINT_API_KEY: 'local-test'});
  let checked = 0;
  const next = async (expected, action, label) => {
    const before = mock.requests.length;
    client.send(action, expected, {id: label, replay});
    let item;
    try { item = await until(() => mock.requests.slice(before).find(x => !x.request.ping), `${sdk} ${label}`); }
    catch (e) { throw new Error(`${e.message}; client errors=${JSON.stringify(client.errors)} stderr=${client.stderr}`); }
    checkRequest(item.request, expected); checked++;
    return item;
  };
  try {
    const variants = {on: {matchMints: true}, off: {matchMints: false}, omitted: {}, null: {matchMints: null},
      include: {accountInclude: [USDC, USDT, USDC], matchMints: true, vote: false, failed: false},
      exclude: {accountExclude: [USDC], matchMints: true},
      required: {accountRequired: [USDC, TOKEN], matchMints: true},
      full: {accountInclude: [USDC, WSOL], accountExclude: [RANDOM], accountRequired: [TOKEN],
        vote: false, failed: true, signature: bs58.encode(Buffer.alloc(64, 5)), matchMints: true},
      ata: {accountInclude: [USDC], matchMints: true, tokenAccounts: 'ALL'},
      ata_changed: {accountInclude: [USDC], matchMints: true, tokenAccounts: 'BALANCE_CHANGED'}};
    const req = {transactions: variants, transactionsStatus: variants, slots: {visible: {}}, commitment: 0};
    if (replay) req.fromSlot = '900';
    let item = await next(req, 'subscribe', 'initial');
    assert.equal(item.request.fromSlot, replay ? '900' : undefined);
    assert.equal(Object.keys(item.request.slots).some(k => k !== 'visible'), replay);
    // Toggle both maps through true/false/omitted and change the watched mint.
    for (const flag of [false, true, undefined]) {
      const filter = {accountInclude: [USDT], accountExclude: [RANDOM], accountRequired: [TOKEN], vote: false};
      if (flag !== undefined) filter.matchMints = flag;
      const replacement = {transactions: {replacement: filter}, transactionsStatus: {replacement_status: filter}, slots: {visible: {}}, commitment: 0};
      item = await next(replacement, 'write', `toggle-${flag}`);
      const slot = 1000 + checked;
      item.call.write({filters: Object.keys(item.request.slots), slot: {slot: String(slot), status: 0}});
      await until(() => client.events.find(e => e.type === 'slot' && Number(e.slot) === slot), 'delivered slot');
      const before = mock.requests.length;
      item.call.emit('error', Object.assign(new Error('intentional reconnect test'), {code: grpc.status.UNAVAILABLE}));
      const reconnected = await until(() => mock.requests.slice(before).find(x => !x.request.ping), 'reconnected request', 22000);
      checkRequest(reconnected.request, replacement); checked++;
      if (replay) assert(reconnected.request.fromSlot !== undefined, 'replay cursor missing');
      else assert.equal(reconnected.request.fromSlot, undefined);
      assert(Object.values(reconnected.request.transactions).every(f => f.accountInclude[0] === USDT));
    }
    // A realistic large mint list must survive conversion without truncation.
    const large = Array.from({length: 1000}, (_,i) => {const b = Buffer.alloc(32); b.writeUInt32LE(i + 1); return bs58.encode(b);});
    await next({transactions: {large: {accountInclude: large, matchMints: true}}, commitment: 0}, 'write', 'large-list');
    if (sdk.startsWith('javascript')) {
      for (const bad of ['true', 1, {}, []]) {
        const id = `invalid-${JSON.stringify(bad)}`;
        client.send('write', {transactions: {invalid: {matchMints: bad}}}, {id});
        await until(() => client.events.find(e => e.type === 'commandError' && e.id === id), id);
        checked++;
      }
    }
    assert(client.errors.every(e => e.type === 'commandError' && e.id.startsWith('invalid-')),
      `unexpected client errors: ${JSON.stringify(client.errors)}`);
    const result = {mode: 'local', sdk, replay, checks: checked, connections: mock.calls.length, pass: true};
    results.push(result); console.log(JSON.stringify(result));
  } finally {await client.stop(); mock.server.forceShutdown();}
}

// Reference implementation deliberately uses plain sets over decoded payloads.
// It shares no filtering code with the server or SDKs.
function matches(tx, f) {
  if (f.vote !== undefined && tx.vote !== f.vote) return false;
  if (f.failed !== undefined && tx.failed !== f.failed) return false;
  if (f.signature && f.signature !== tx.signature) return false;
  const accounts = new Set(tx.keys);
  if (f.tokenAccounts === 'ALL') for (const b of [...tx.pre, ...tx.post]) if (b.owner) accounts.add(b.owner);
  if (f.tokenAccounts === 'BALANCE_CHANGED') {
    const pre = new Map(tx.pre.map(b => [b.accountIndex || 0, b]));
    const post = new Map(tx.post.map(b => [b.accountIndex || 0, b]));
    for (const i of new Set([...pre.keys(), ...post.keys()])) {
      const a = pre.get(i), b = post.get(i);
      if (!a || !b || a.uiTokenAmount?.amount !== b.uiTokenAmount?.amount) {
        if (a?.owner) accounts.add(a.owner); if (b?.owner) accounts.add(b.owner);
      }
    }
  }
  if (f.matchMints) for (const b of [...tx.pre, ...tx.post]) accounts.add(b.mint);
  return (!(f.accountInclude?.length) || f.accountInclude.some(k => accounts.has(k)))
    && !(f.accountExclude || []).some(k => accounts.has(k))
    && (f.accountRequired || []).every(k => accounts.has(k));
}
function liveFilters(mint = USDC) {
  return {
    reference: {},
    mint: {accountInclude: [mint], matchMints: true},
    legacy: {accountInclude: [mint]},
    disabled: {accountInclude: [mint], matchMints: false},
    negative: {accountInclude: [RANDOM], matchMints: true},
    multiple: {accountInclude: [mint, USDT, WSOL], matchMints: true},
    excluded: {accountExclude: [mint], matchMints: true},
    required: {accountRequired: [mint], matchMints: true},
    required_both: {accountRequired: [mint, WSOL], matchMints: true},
    required_key_and_mint: {accountRequired: [mint, TOKEN], matchMints: true},
    include_exclude: {accountInclude: [mint], accountExclude: [WSOL], matchMints: true},
    impossible: {accountInclude: [mint], accountExclude: [mint], matchMints: true},
    failed: {accountInclude: [mint], failed: true, matchMints: true},
    successful: {accountInclude: [mint], failed: false, matchMints: true},
    nonvote: {accountInclude: [mint], vote: false, matchMints: true},
    ata_all: {accountInclude: [mint], tokenAccounts: 'ALL', matchMints: true},
    ata_changed: {accountInclude: [mint], tokenAccounts: 'BALANCE_CHANGED', matchMints: true},
  };
}
async function live(sdk, seconds, fromSlot) {
  const env = config();
  assert(env.MINT_ENDPOINT && env.MINT_API_KEY, 'Set MINT_ENDPOINT/MINT_API_KEY or MINT_ENV_FILE');
  const client = new Client(sdk, env);
  const filters = liveFilters(process.env.MINT_TARGET || USDC);
  const reference = process.env.MINT_REFERENCE_FILE ? JSON.parse(fs.readFileSync(process.env.MINT_REFERENCE_FILE, 'utf8')) : null;
  if (reference) for (const f of Object.values(filters)) f.vote = false;
  if (reference) fromSlot = reference.start;
  const referenceIDs = reference ? new Set(reference.transactions.map(t => `${t.slot}:${t.signature}`)) : null;
  const seen = new Set();
  const seenStatuses = new Set();
  const stats = {mode: reference ? 'replay' : 'live', sdk, endpoint: new URL(env.MINT_ENDPOINT).hostname,
    target: process.env.MINT_TARGET || USDC,
    commitment: Number(process.env.MINT_COMMITMENT || 1), fromSlot,
    seconds, transactions: 0, statuses: 0, comparisons: 0, falsePositives: 0, falseNegatives: 0,
    balanceOnly: 0, failed: 0, noBalances: 0, preOnly: 0, postOnly: 0, slotMin: null, slotMax: 0,
    counts: Object.fromEntries(Object.keys(filters).map(k => [k,0])), examples: []};
  const bySignature = new Map();
  const pending = new Map();
  const mismatch = (type, tx, name, want, got) => {
    stats[got ? 'falsePositives' : 'falseNegatives']++;
    if (stats.examples.length < 12) stats.examples.push({type, signature: tx.signature, slot: tx.slot, name, want, got});
  };
  const checkStatus = (status, expected) => {
    const got = new Set(status.filters);
    for (const name of Object.keys(filters)) {
      stats.comparisons++;
      if (got.has(`status_${name}`) !== expected.has(name)) mismatch('status', status, name, expected.has(name), got.has(`status_${name}`));
    }
  };
  client.onUpdate = tx => {
    if (reference && (Number(tx.slot) < reference.start || Number(tx.slot) >= reference.end)) return;
    if (tx.type === 'transaction') {
      stats.transactions++; stats.failed += Number(tx.failed);
      const slot = Number(tx.slot); stats.slotMin = Math.min(stats.slotMin ?? slot, slot); stats.slotMax = Math.max(stats.slotMax,slot);
      if (tx.pre.length + tx.post.length === 0) stats.noBalances++;
      const target = process.env.MINT_TARGET || USDC;
      const pre = tx.pre.some(b => b.mint === target), post = tx.post.some(b => b.mint === target);
      if (pre && !post) stats.preOnly++; if (!pre && post) stats.postOnly++;
      if ((pre || post) && !tx.keys.includes(target)) stats.balanceOnly++;
      const got = new Set(tx.filters), expected = new Set();
      for (const [name, f] of Object.entries(filters)) {
        const want = matches(tx, f); if (want) expected.add(name);
        if (got.has(name)) stats.counts[name]++;
        stats.comparisons++;
        if (got.has(name) !== want) mismatch('transaction', tx, name, want, got.has(name));
      }
      const id = `${tx.slot}:${tx.signature}`;
      seen.add(id);
      bySignature.set(id,expected);
      if (pending.has(id)) {checkStatus(pending.get(id), expected); pending.delete(id);}
      // Retain a bounded cross-stream join window.
      if (bySignature.size > 100000) bySignature.delete(bySignature.keys().next().value);
    } else if (tx.type === 'status') {
      stats.statuses++;
      const id = `${tx.slot}:${tx.signature}`;
      seenStatuses.add(id);
      if (bySignature.has(id)) checkStatus(tx,bySignature.get(id)); else pending.set(id, tx);
    }
  };
  try {
    const request = {transactions: filters,
      transactionsStatus: Object.fromEntries(Object.entries(filters).map(([k,v]) => [`status_${k}`,v])), commitment: stats.commitment};
    if (fromSlot) request.fromSlot = String(fromSlot);
    client.send('subscribe',request,{id:'live',replay:true});
    await until(() => stats.transactions || client.errors.length || client.exited, `${sdk} first live transaction`,30000);
    if (!stats.transactions) throw new Error(`${sdk}: no live transactions: ${JSON.stringify(client.errors)} ${client.stderr}`);
    const end = Date.now() + seconds*1000;
    while (Date.now() < end) {await sleep(1000); if (client.exited) break;}
    client.onUpdate = () => {};
    stats.unpairedStatuses = pending.size;
    stats.errors = client.errors;
    if (reference) {
      stats.referenceTransactions = referenceIDs.size;
      stats.missingFromReplay = [...referenceIDs].filter(id => !seen.has(id));
      stats.extraInReplay = [...seen].filter(id => !referenceIDs.has(id));
      stats.missingStatuses = [...referenceIDs].filter(id => !seenStatuses.has(id));
    }
    stats.pass = stats.transactions >= 1000 && stats.balanceOnly >= Number(process.env.MINT_MIN_BALANCE_ONLY || 1) && stats.counts.mint > 0 && stats.statuses > 0
      && stats.falsePositives === 0 && stats.falseNegatives === 0 && client.errors.length === 0
      && (!reference || (stats.missingFromReplay.length === 0 && stats.extraInReplay.length === 0 && stats.missingStatuses.length === 0));
    results.push(stats); console.log(JSON.stringify(stats));
    assert(stats.pass, `${sdk} live correctness or coverage failed`);
  } finally {await client.stop();}
}
async function capture() {
  const env = config();
  const definition = loader.loadSync(path.join(ROOT,'javascript/proto/geyser.proto'), {longs:String, defaults:true, enums:Number});
  const Geyser = grpc.loadPackageDefinition(definition).geyser.Geyser;
  const url = new URL(env.MINT_ENDPOINT);
  const client = new Geyser(url.host, url.protocol === 'https:' ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
    {'grpc.max_receive_message_length':64*1024*1024});
  const metadata = new grpc.Metadata(); metadata.set('x-token',env.MINT_API_KEY);
  const stream = client.subscribe(metadata);
  const transactions = []; let start, end, latest = 0, error, messages = 0;
  stream.on('error',e => {if(e.code !== grpc.status.CANCELLED) error=e;});
  stream.on('data',u=>{
    messages++;
    if (u.ping) stream.write({ping:{id:1}});
    if (!u.transaction) return;
    const slot=Number(u.transaction.slot);
    if (start === undefined) {start=slot+1;end=start+10;}
    latest=Math.max(latest,slot);
    if(slot<start||slot>=end)return;
    const t=u.transaction.transaction,m=t.meta;
    transactions.push({slot,signature:bs58.encode(t.signature),vote:t.isVote,failed:!!m?.err,
      keys:[...(t.transaction?.message?.accountKeys||[]),...(m?.loadedWritableAddresses||[]),...(m?.loadedReadonlyAddresses||[])].map(k=>bs58.encode(k)),
      pre:m?.preTokenBalances||[],post:m?.postTokenBalances||[]});
  });
  try {
    stream.write({transactions:{reference:{vote:false}},commitment:1});
    await until(()=>error||latest>=(end||Infinity)+2,'complete reference capture',90000)
      .catch(e=>{throw new Error(`${e.message}: messages=${messages}, start=${start}, end=${end}, latest=${latest}, transactions=${transactions.length}`);});
    if(error)throw error;
    const output={at:new Date().toISOString(),endpoint:url.hostname,commitment:1,start,end,transactions};
    fs.mkdirSync(path.join(__dirname,'results'),{recursive:true});
    fs.writeFileSync(path.join(__dirname,'results/reference.json'),JSON.stringify(output));
    console.log(JSON.stringify({mode:'capture',start,end,transactions:transactions.length}));
  } finally {stream.cancel();client.close();}
}
async function transitions(sdk) {
  const env = config(), url = new URL(env.MINT_ENDPOINT);
  // Forward raw protobuf bytes. This proxy only injects a stream failure; it
  // does not decode transactions or participate in deciding their filters.
  const upstream = new grpc.Client(url.host, url.protocol === 'https:' ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
    {'grpc.max_receive_message_length':64*1024*1024});
  const server = new grpc.Server();
  const calls = [];
  server.addService({subscribe:{path:'/geyser.Geyser/Subscribe',requestStream:true,responseStream:true,
    requestSerialize:b=>b,requestDeserialize:b=>b,responseSerialize:b=>b,responseDeserialize:b=>b}},
    {subscribe:call=>{
      calls.push(call); call.on('error',()=>{});
      const metadata=new grpc.Metadata();metadata.set('x-token',env.MINT_API_KEY);
      const remote=upstream.makeBidiStreamRequest('/geyser.Geyser/Subscribe',b=>b,b=>b,metadata);
      remote.on('metadata',()=>call.sendMetadata(new grpc.Metadata()));
      remote.on('data',b=>{if(!call.write(b))remote.pause();});
      call.on('drain',()=>remote.resume());
      remote.on('error',e=>{if(e.code!==grpc.status.CANCELLED)call.emit('error',e);});
      remote.on('end',()=>call.end());
      call.on('data',b=>remote.write(b));
      call.on('cancelled',()=>remote.cancel());
      call.on('close',()=>remote.cancel());
    }});
  const port=await new Promise((resolve,reject)=>server.bindAsync('127.0.0.1:0',grpc.ServerCredentials.createInsecure(),(e,p)=>e?reject(e):resolve(p)));
  const client=new Client(sdk,{...env,MINT_ENDPOINT:`http://127.0.0.1:${port}`});
  const phases=[{target:USDC,flag:true},{target:USDC,flag:false},{target:USDT,flag:true}];
  const specs=phases.map(({target,flag},i)=>Object.fromEntries(Object.entries({
    reference:{vote:false}, mint:{vote:false,accountInclude:[target],matchMints:flag},
    exclude:{vote:false,accountExclude:[target],matchMints:flag},
    required:{vote:false,accountRequired:[target],matchMints:flag},
    negative:{vote:false,accountInclude:[RANDOM],matchMints:flag},
  }).map(([name,f])=>[`p${i}_${name}`,f])));
  const counts=phases.map(()=>({transactions:0,matched:0,checks:0,mismatches:0}));
  const examples=[];
  client.onUpdate=tx=>{
    if(tx.type!=='transaction')return;
    const label=tx.filters.find(f=>/^p\d_reference$/.test(f));
    if(!label){examples.push({error:'missing phase reference',filters:tx.filters});return;}
    const i=Number(label[1]),count=counts[i],got=new Set(tx.filters);
    count.transactions++;
    if(got.has(`p${i}_mint`))count.matched++;
    for(const [name,f] of Object.entries(specs[i])) {
      count.checks++; const want=matches(tx,f);
      if(got.has(name)!==want) {count.mismatches++;if(examples.length<10)examples.push({phase:i,name,signature:tx.signature,want});}
    }
    if(tx.filters.some(f=>!Object.hasOwn(specs[i],f)))examples.push({error:'mixed or stale filter names',filters:tx.filters});
  };
  try {
    for(let i=0;i<phases.length;i++) {
      client.send(i?'write':'subscribe',{transactions:specs[i],commitment:1},{id:`phase${i}`,replay:true});
      await until(()=>counts[i].transactions>=500 && counts[i].matched>=5,`${sdk} transition phase ${i}`,45000)
        .catch(e=>{throw new Error(`${e.message}: counts=${JSON.stringify(counts)}, errors=${JSON.stringify(client.errors)}, stderr=${client.stderr}`);});
    }
    const before=counts[2].transactions,connectionCount=calls.length;
    calls.at(-1).emit('error',Object.assign(new Error('intentional live reconnect test'),{code:grpc.status.UNAVAILABLE}));
    await until(()=>calls.length>connectionCount,`${sdk} live reconnection`,22000);
    await until(()=>counts[2].transactions>=before+500,`${sdk} post-reconnect delivery`,45000);
    client.onUpdate = () => {};
    const result={mode:'transitions',sdk,phases:counts,reconnections:calls.length-1,examples,errors:client.errors};
    result.pass=counts.every(c=>c.mismatches===0)&&examples.length===0&&client.errors.length===0;
    results.push(result);console.log(JSON.stringify(result));assert(result.pass,`${sdk} transition checks failed`);
  } finally {await client.stop();server.forceShutdown();upstream.close();}
}
async function main() {
  const mode = process.argv[2] || 'local';
  if(mode==='capture')return capture();
  const sdks = (process.env.MINT_SDKS || 'javascript,javascript-snake,go,rust').split(',');
  for (const sdk of sdks) {
    if (mode === 'local') for (const replay of [true,false]) await local(sdk,replay);
    else if(mode==='transitions')await transitions(sdk);
    else await live(sdk,Number(process.env.MINT_SECONDS || 30), process.env.MINT_FROM_SLOT);
  }
}
module.exports = {matches};
if (require.main === module) {
  main().catch(e => {console.error(e.stack); process.exitCode = 1;}).finally(() => {
    fs.mkdirSync(path.join(__dirname,'results'), {recursive:true});
    fs.writeFileSync(path.join(__dirname,'results',`${process.argv[2] || 'local'}-${Date.now()}.json`), JSON.stringify({at:new Date().toISOString(),results}, null,2));
  });
}
