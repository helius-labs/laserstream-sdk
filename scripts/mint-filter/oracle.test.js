const {test} = require('node:test');
const assert = require('node:assert/strict');
const {matches} = require('./verify');
const tx = {signature:'sig',vote:false,failed:false,keys:['key','program'],
  pre:[{accountIndex:0,mint:'mintA',owner:'owner',uiTokenAmount:{amount:'10'}}],
  post:[{accountIndex:0,mint:'mintA',owner:'owner',uiTokenAmount:{amount:'5'}},
    {accountIndex:1,mint:'mintB',owner:'ownerB',uiTokenAmount:{amount:'1'}}]};
const cases = [
  ['disabled is keys only', {accountInclude:['mintA']}, false],
  ['explicit false is keys only', {accountInclude:['mintA'],matchMints:false}, false],
  ['pre/post mint', {accountInclude:['mintA'],matchMints:true}, true],
  ['post-only mint', {accountInclude:['mintB'],matchMints:true}, true],
  ['key hit remains valid', {accountInclude:['key'],matchMints:true}, true],
  ['include uses OR', {accountInclude:['missing','mintA'],matchMints:true}, true],
  ['required uses AND across key and mint', {accountRequired:['key','mintA'],matchMints:true}, true],
  ['missing required rejects', {accountRequired:['missing','mintA'],matchMints:true}, false],
  ['exclude wins over include', {accountInclude:['mintA'],accountExclude:['mintA'],matchMints:true}, false],
  ['unrelated mint rejects', {accountInclude:['missing'],matchMints:true}, false],
  ['failed remains an AND condition', {accountInclude:['mintA'],failed:true,matchMints:true}, false],
  ['vote remains an AND condition', {accountInclude:['mintA'],vote:true,matchMints:true}, false],
  ['signature remains an AND condition', {accountInclude:['mintA'],signature:'other',matchMints:true}, false],
  ['owner plus mint can satisfy required', {accountRequired:['owner','mintA'],tokenAccounts:'ALL',matchMints:true}, true],
  ['changed owner plus mint', {accountRequired:['owner','mintA'],tokenAccounts:'BALANCE_CHANGED',matchMints:true}, true],
];
for (const [name,filter,want] of cases) test(name,()=>assert.equal(matches(tx,filter),want));
test('pre-only mint survives account closure',()=>assert(matches({...tx,post:[]},{accountInclude:['mintA'],matchMints:true})));
test('no token balances falls back to account keys',()=>{
  const empty={...tx,pre:[],post:[]};
  assert(!matches(empty,{accountInclude:['mintA'],matchMints:true}));
  assert(matches(empty,{accountInclude:['key'],matchMints:true}));
});
