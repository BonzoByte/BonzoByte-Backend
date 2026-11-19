import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {brotliCompressSync} from 'node:zlib';
import {openArchiveRelease} from '../utils/private-archive-reader/reader.mjs';
import {PRIVATE_READER_SOURCE_SHA256} from '../utils/privateArchiveRuntime.js';

const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(width=3){
 const objects=new Map(),sha=x=>hash(String(x)).slice(0,width);
 function store(data,codec='json'){
  const decoded=Buffer.from(JSON.stringify(data)),raw=codec==='br'?brotliCompressSync(decoded):decoded;
  const digest=hash(raw),key=`publisher-staging-v1/objects/${digest.slice(0,2)}/${digest}.${codec}`;
  objects.set(key,raw);return {key,sha256:digest,bytes:raw.length,jsonSha:hash(decoded)};
 }
 const payload=store({m003:'2026-11-16T12:00:00',m656:true},'br'),logical='matches/123456789.br';
 const cat=store({schema:'bonzobyte.online-catalogue.v1',shard:sha(logical),rows:[[logical,payload.key,payload.bytes,payload.sha256,payload.jsonSha]]});
 const routing={};
 for(const [kind,id] of [['id',42],['tp',123456789]]){
  const d=store({schema:'bonzobyte.online-match-routing.v1',kind,shard:sha(id),rows:[[id,42,123456789,'2026-11-16']]});
  routing[kind]={[sha(id)]:{...d,rows:1}};
 }
 const dates=store({schema:'bonzobyte.online-dates.v1',dates:['2026-11-16']});
 const manifest={schema:'bonzobyte.online-archive-release.v1',release:'a'.repeat(64),through:'2026-11-16',inventorySha256:'b'.repeat(64),
  files:1,matches:1,shardAlgorithm:`sha256-utf8-first-${width}-hex`,catalogues:{[sha(logical)]:{...cat,rows:1}},routing,
  dailyDates:{...dates,rows:1},reports:[],candidateOnly:true,activationAllowed:false};
 const candidate=store(manifest),getObject=async key=>{assert.ok(objects.has(key));return objects.get(key);};
 return {objects,store,manifest,candidate,getObject,payload,logical};
}
for(const width of [1,3])test(`verified read and routing preserve ${width}-hex format`,async()=>{
 const f=fixture(width),r=await openArchiveRelease(f);
 assert.deepEqual(await r.availableDates(),['2026-11-16']);assert.equal((await r.readJson(f.logical)).m656,true);
 assert.equal((await r.locateMatchById(42)).tp,123456789);assert.equal((await r.locateMatchByTp(123456789)).matchId,42);
 await assert.rejects(r.readJson('players/details/999.br'),e=>e.status===404);
 await assert.rejects(r.readJson('../private.json'),e=>e.status===400);
});
test('unsupported catalogue density is rejected',async()=>{
 const f=fixture(2);await assert.rejects(openArchiveRelease(f),e=>e.code==='ARCHIVE_INTEGRITY');
});
test('a compact release cannot carry legacy-width shard names',async()=>{
 const f=fixture(3);f.manifest.shardAlgorithm='sha256-utf8-first-1-hex';f.candidate=f.store(f.manifest);
 await assert.rejects(openArchiveRelease(f),e=>e.code==='ARCHIVE_INTEGRITY');
});
test('full SHA-256 integrity remains mandatory with compact routing',async()=>{
 const f=fixture(1),r=await openArchiveRelease(f);
 const bad=Buffer.from(f.objects.get(f.payload.key));bad[0]^=1;f.objects.set(f.payload.key,bad);
 await assert.rejects(r.readJson(f.logical),e=>e.code==='ARCHIVE_INTEGRITY');
});
test('deployed reader bytes match the recorded revision',()=>{
 assert.equal(hash(readFileSync(new URL('../utils/private-archive-reader/reader.mjs',import.meta.url))),PRIVATE_READER_SOURCE_SHA256['reader.mjs']);
});
