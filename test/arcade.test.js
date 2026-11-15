import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createArcadeCatalog } from '../utils/arcadeCatalog.js';
import { createArcade, ARCADE_ENGINE_VERSION, verifyArcadeReplay, ARCADE_COLLECTIONS } from '../utils/arcade.js';
import { createArcadeRouter } from '../routes/arcade.routes.js';
import { ACCOUNT_COLLECTIONS } from '../utils/accountDeletionCleanup.js';
import { PREVIOUS_ARCADE_VERSION, CHARGED_ARCADE_VERSION, BASELINE_ARCADE_VERSION, PRE_TOSS_ARCADE_VERSION, arcadeKernel } from '../utils/arcadeKernels.js';
const require=createRequire(import.meta.url);
const currentKernel=arcadeKernel(ARCADE_ENGINE_VERSION);
const { Tennis3DEngine }=require(fileURLToPath(new URL('tennis-3d-engine.cjs',currentKernel)));
const { arcadeRandom }=require(fileURLToPath(new URL('tennis-skill.cjs',currentKernel)));
const { ArcadeRecorder, applyArcadeCommand }=require(fileURLToPath(new URL('tennis-replay.cjs',currentKernel)));
function recorded(seed=42, legacy=false, depth=false) {
    const folder=legacy?arcadeKernel(typeof legacy==='string'?legacy:PREVIOUS_ARCADE_VERSION):currentKernel;
    const {Tennis3DEngine}=require(fileURLToPath(new URL('tennis-3d-engine.cjs',folder)));
    const {arcadeRandom}=require(fileURLToPath(new URL('tennis-skill.cjs',folder)));
    const {ArcadeRecorder,applyArcadeCommand}=require(fileURLToPath(new URL('tennis-replay.cjs',folder)));
    const game=new Tennis3DEngine(arcadeRandom(seed),'challenge'),recorder=new ArcadeRecorder();
    game.opponentStrength=.5;game.start('grass','normal','challenge');let held=0,serves=0;
    for(let i=0;i<20000 && game.phase!=='over';i++) {
        const input={left:false,right:false,forward:false,back:false,jump:false,shot:null};
        if(game.phase==='serving'&&game.server===0) {
            if(!held) {
                if(depth) {const command=6+serves++%3;recorder.command(command);applyArcadeCommand(game,command);}
                recorder.command(1);applyArcadeCommand(game,1);
            }
            input.shot=held++<8?'drive':null;
        } else held=0;
        recorder.capture(.02,input);game.update(.02,input);
    }
    assert.equal(game.phase,'over');return {replay:Buffer.from(recorder.exportBytes()).toString('base64'),winner:game.winner,score:[...game.score]};
}
test('player catalogue searches real index fields, snapshots TS and rejects unavailable or duplicate identities',async()=>{
    let loads=0;
    const bytes=brotliCompressSync(JSON.stringify([{playerTPId:11,playerName:'Željko Player',currentTsMean:29,countryISO2:'HR',countryISO3:'HRV'}, {playerTPId:12,playerName:'No Rating',currentTsMean:null}]));
    const catalog=createArcadeCatalog({load:async()=>{loads++;return {bytes,version:'synthetic.br'};}});
    assert.equal((await catalog.search('zeljko')).items[0].id,11);assert.equal((await catalog.get(11)).countryISO2,'hr');assert.equal(loads,1);
    assert.match((await catalog.get(11)).catalogVersion,/^[a-f0-9]{64}$/);await assert.rejects(catalog.get(12),{code:'ARCADE_OPPONENT_UNAVAILABLE'});
    const duplicate=createArcadeCatalog({load:async()=>({version:'test',bytes:brotliCompressSync(JSON.stringify([{playerTPId:1,playerName:'A'},{playerTPId:1,playerName:'B'}]))})});
    await assert.rejects(duplicate.search(''),{code:'ARCADE_CATALOG_UNAVAILABLE'});
});
test('game catalogue supports canonical IDs and legitimate negative TS without mislabelling them as missing',async()=>{
 const catalog=createArcadeCatalog({load:async()=>({encoding:'json',version:'audited-game-only',bytes:Buffer.from(JSON.stringify({players:[{playerId:78341,playerName:'Synthetic lower rating',currentTsMean:-.87}]}))})});
 const player=await catalog.get(78341);assert.equal(player.ts,-.87);assert.equal((await catalog.search('lower')).items[0].id,78341);
});
test('bounded worker reconstructs a full recorded challenge and rejects invented results',async()=>{
    const fixture=recorded();const result=await verifyArcadeReplay(fixture.replay,{seed:42,strength:.5,surface:'grass'});
    assert.equal(result.winner,fixture.winner);assert.deepEqual(result.score,fixture.score);
    await assert.rejects(verifyArcadeReplay(Buffer.alloc(7).toString('base64'),{seed:42,strength:.5,surface:'grass'}),{code:'ARCADE_REPLAY_INVALID'});
});
test('previously started challenges use their trusted original physics, unknown versions are rejected',async()=>{
    const fixture=recorded(42,true);
    const result=await verifyArcadeReplay(fixture.replay,{seed:42,strength:.5,surface:'grass',engineVersion:PREVIOUS_ARCADE_VERSION});
    assert.equal(result.winner,fixture.winner);assert.deepEqual(result.score,fixture.score);
    await assert.rejects(verifyArcadeReplay(fixture.replay,{seed:42,strength:.5,surface:'grass',engineVersion:'../unknown'}),{code:'ARCADE_VERSION_CHANGED'});
});
test('hold/release challenges from the preceding version remain verifiable after adding drops',async()=>{
    const fixture=recorded(42,CHARGED_ARCADE_VERSION);
    const result=await verifyArcadeReplay(fixture.replay,{seed:42,strength:.5,surface:'grass',engineVersion:CHARGED_ARCADE_VERSION});
    assert.equal(result.winner,fixture.winner);assert.deepEqual(result.score,fixture.score);
});
test('challenges started before the receiving-stance correction retain their original kernel',async()=>{
    const fixture=recorded(42,BASELINE_ARCADE_VERSION);
    const result=await verifyArcadeReplay(fixture.replay,{seed:42,strength:.5,surface:'grass',engineVersion:BASELINE_ARCADE_VERSION});
    assert.equal(result.winner,fixture.winner);assert.deepEqual(result.score,fixture.score);
    assert.notEqual(BASELINE_ARCADE_VERSION,ARCADE_ENGINE_VERSION);
});
test('kernel registry preserves all trusted historical versions without accepting client paths',()=>{
    assert.equal(PRE_TOSS_ARCADE_VERSION,'3f9932e83cc2a7fbd209737038566aff5494930b274f0d8ae040558ea7a12600');
    for(const version of new Set([ARCADE_ENGINE_VERSION,PRE_TOSS_ARCADE_VERSION,PREVIOUS_ARCADE_VERSION,CHARGED_ARCADE_VERSION,BASELINE_ARCADE_VERSION])) {
        const root=arcadeKernel(version);assert.ok(root instanceof URL);
        assert.equal(JSON.parse(readFileSync(new URL('manifest.json',root),'utf8')).version,version);
    }
    for(const version of ['../arcade-engine/',`${PRE_TOSS_ARCADE_VERSION}/`,'0'.repeat(64),'toString',null,undefined])assert.equal(arcadeKernel(version),null);
});

test('pre-toss challenges remain verifiable through the standard bounded worker',async()=>{
    const fixture=recorded(42,PRE_TOSS_ARCADE_VERSION);
    const result=await verifyArcadeReplay(fixture.replay,{seed:42,strength:.5,surface:'grass',engineVersion:PRE_TOSS_ARCADE_VERSION});
    assert.equal(result.winner,fixture.winner);assert.deepEqual(result.score,fixture.score);
    // New depth commands must not be interpreted by the old physics implementation.
    for(const command of [6,7,8]) {
        const bytes=Buffer.from(fixture.replay,'base64');bytes[4]=command;
        await assert.rejects(verifyArcadeReplay(bytes.toString('base64'),{seed:42,strength:.5,surface:'grass',engineVersion:PRE_TOSS_ARCADE_VERSION}),{code:'ARCADE_REPLAY_INVALID'});
    }
});

test('registered historical versions cannot start new public challenges',async()=>{
    let starts=0,lookups=0;const actor={user:'synthetic'};
    const service=createArcade({store:{start:async()=>{starts++;}},catalog:{get:async()=>{lookups++;},search:async()=>({items:[]})}});
    assert.equal((await service.opponents('')).engineVersion,ARCADE_ENGINE_VERSION);
    for(const engineVersion of new Set([PRE_TOSS_ARCADE_VERSION,PREVIOUS_ARCADE_VERSION,CHARGED_ARCADE_VERSION,BASELINE_ARCADE_VERSION])) {
        if(engineVersion===ARCADE_ENGINE_VERSION)continue;
        await assert.rejects(service.start(actor,{opponentId:11,surface:'grass',requestId:randomUUID(),engineVersion,publicRanking:true}),{code:'ARCADE_VERSION_CHANGED'});
    }
    assert.equal(starts,0);assert.equal(lookups,0);
});

test('pre-toss in-flight sessions finish with stored physics and server-reconstructed results',async()=>{
    const fixture=recorded(42,PRE_TOSS_ARCADE_VERSION),actor={user:'synthetic'},id=randomUUID();
    const startedAt=new Date('2026-11-13T10:00:00Z');let finishes=0,verifiedConfig;
    const row={_id:id,status:'active',seed:42,engineVersion:PRE_TOSS_ARCADE_VERSION,opponent:{strength:.5},surface:'grass',startedAt,expiresAt:new Date(+startedAt+7200000)};
    const store={session:async(who,key)=>who===actor&&key===id?row:null,finish:async(who,key,digest,result)=>{
        assert.equal(who,actor);assert.equal(key,id);assert.match(digest,/^[a-f0-9]{64}$/);finishes++;return result;
    }};
    const service=createArcade({store,catalog:{},now:()=>new Date(+startedAt+3600000),verify:(replay,config)=>{
        verifiedConfig=config;return verifyArcadeReplay(replay,config);
    }});
    for(const extra of [{winner:0},{score:[7,0]},{result:{winner:0,score:[7,0]}},{rating:{mu:100}},{engineVersion:ARCADE_ENGINE_VERSION}]) {
        await assert.rejects(service.finish(actor,id,{replay:fixture.replay,...extra}),{code:'ARCADE_INVALID_BODY'});
    }
    assert.equal(finishes,0);assert.equal(verifiedConfig,undefined);
    const result=await service.finish(actor,id,{replay:fixture.replay});
    assert.deepEqual(verifiedConfig,{seed:42,strength:.5,surface:'grass',engineVersion:PRE_TOSS_ARCADE_VERSION});
    assert.equal(result.winner,fixture.winner);assert.deepEqual(result.score,fixture.score);assert.equal(finishes,1);
});

const awaitingTossKernel=ARCADE_ENGINE_VERSION===PRE_TOSS_ARCADE_VERSION?'Awaiting parent-supplied physical-toss kernel':false;
test('physical-toss depth commands 6/7/8 map only to short/centre/deep inputs',{skip:awaitingTossKernel},()=>{
    const depths=[];const game={setServeDepth:value=>depths.push(value)};
    for(const command of [6,7,8])applyArcadeCommand(game,command);
    assert.deepEqual(depths,[-1,0,1]);
});

test('physical-toss depth replay reconstructs results and rejects non-input command payloads',{skip:awaitingTossKernel},async()=>{
    const fixture=recorded(42,false,true),bytes=Buffer.from(fixture.replay,'base64'),commands=new Set();
    for(let pos=0;pos<bytes.length;pos+=7)for(let i=0;i<6;i++)commands.add((bytes[pos+4+Math.floor(i/2)]>>>((i%2)*4))&15);
    for(const command of [6,7,8])assert.ok(commands.has(command));
    const config={seed:42,strength:.5,surface:'grass',engineVersion:ARCADE_ENGINE_VERSION};
    const result=await verifyArcadeReplay(fixture.replay,config);
    assert.equal(result.winner,fixture.winner);assert.deepEqual(result.score,fixture.score);
    assert.deepEqual(Object.keys(result).sort(),['bestRally','frames','score','seconds','winner']);
    for(const command of [9,15]) {
        const invalid=Buffer.from(bytes);invalid[4]=command;
        await assert.rejects(verifyArcadeReplay(invalid.toString('base64'),config),{code:'ARCADE_REPLAY_INVALID'});
    }
    const gapped=Buffer.from(bytes);gapped[4]=0x60;
    await assert.rejects(verifyArcadeReplay(gapped.toString('base64'),config),{code:'ARCADE_REPLAY_INVALID'});
});

test('service trusts server opponent TS, validates version and accepts only input replay, not client winner or rating',async()=>{
    let row,finishes=0, at=new Date('2026-11-13T10:00:00Z');const actor={user:'synthetic'};
    const store={start:async(_actor,entry)=>(row=entry),session:async(a,id)=>a===actor&&row?row:null,finish:async(_actor,_id,digest,result)=>{finishes++;row.status='complete';row.replaySha256=digest;return row.result=result;}};
    const catalog={get:async()=>({id:11,name:'Synthetic Player',ts:27.5}),search:async()=>({items:[]})};
    const service=createArcade({store,catalog,now:()=>at,verify:async()=>({winner:0,score:[7,3],seconds:60})});
    const body={opponentId:11,surface:'grass',requestId:randomUUID(),engineVersion:ARCADE_ENGINE_VERSION,publicRanking:true};
    await assert.rejects(service.start(actor,{...body,ts:50}),{code:'ARCADE_INVALID_BODY'});
    await assert.rejects(service.start(actor,{...body,engineVersion:'old'}),{code:'ARCADE_VERSION_CHANGED'});
    await assert.rejects(service.start(actor,{...body,publicRanking:false}),{code:'ARCADE_INVALID_BODY'});
    const started=await service.start(actor,body);assert.equal(started.opponent.strength,.5);assert.equal(started.opponent.gameMu,25);
    const replay=Buffer.alloc(7).toString('base64');
    for(const extra of [{winner:0},{score:[7,0]},{result:{winner:0,score:[7,0]}},{rating:{mu:100}},{engineVersion:PRE_TOSS_ARCADE_VERSION}]) {
        await assert.rejects(service.finish(actor,started.id,{replay,...extra}),{code:'ARCADE_INVALID_BODY'});
    }
    await assert.rejects(service.finish({},started.id,{replay}),{code:'ARCADE_AUTH_REQUIRED'});
    await assert.rejects(service.finish(actor,started.id,{replay}),{code:'ARCADE_REPLAY_TOO_FAST'});
    at=new Date(+at+60000);assert.equal((await service.finish(actor,started.id,{replay})).winner,0);
    assert.equal((await service.finish(actor,started.id,{replay})).winner,0);assert.equal(finishes,1);
    await assert.rejects(service.finish(actor,started.id,{replay:Buffer.alloc(14).toString('base64')}),{code:'ARCADE_ALREADY_FINISHED'});
});
test('all new user-linked stores participate in account erasure',()=>{
    for(const [key,name] of Object.entries(ARCADE_COLLECTIONS))assert.equal(ACCOUNT_COLLECTIONS[key],name);
});
test('HTTP endpoint preserves access gates, rejects malformed input and never caches personal responses',async()=>{
    let writes=0;const app=express();
    const auth=(req,res,next)=>{if(req.headers.authorization!=='Bearer synthetic')return res.status(401).end();req.user={_id:'fake',tokenVersion:0,isVerified:req.headers['x-verified']==='yes'};next();};
    const service={opponents:async()=>({items:[]}),me:async()=>({career:{mu:25}}),leaderboard:async()=>({items:[]}),start:async()=>{writes++;return {id:'fake'};}};
    app.use('/api/arcade',createArcadeRouter({service,auth}));const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const root=`http://127.0.0.1:${server.address().port}/api/arcade`;
    try {
        const me=await fetch(root+'/me');assert.equal(me.status,401);assert.equal(me.headers.get('cache-control'),'private, no-store');
        assert.equal((await fetch(root+'/opponents?q[x]=wrong')).status,400);
        assert.equal((await fetch(root+'/leaderboard?month=2026-99')).status,400);
        assert.equal((await fetch(root+'/sessions',{method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json'},body:'{}'})).status,403);assert.equal(writes,0);
        assert.equal((await fetch(root+'/sessions',{method:'POST',headers:{authorization:'Bearer synthetic','x-verified':'yes','content-type':'application/json'},body:'{broken'})).status,400);
        const personal=await fetch(root+'/me',{headers:{authorization:'Bearer synthetic'}});assert.equal(personal.status,200);assert.equal((await personal.json()).career.mu,25);
    } finally {await new Promise(resolve=>server.close(resolve));}
});
