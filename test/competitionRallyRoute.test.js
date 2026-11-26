import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {createCompetition} from '../utils/competition.js';
import {createCompetitionRouter} from '../routes/competition.routes.js';
import {publishCompetitionObservation} from '../utils/competitionPublisher.js';

test('model-only quote and submission over HTTP; previously issued quote closes exactly five minutes before kickoff',async()=>{
    const playerA={id:10,name:'Fixture A'}, playerB={id:11,name:'Fixture B'}, choices=new Map();
    let playedMatch=300, probability=.6, start='2026-11-22T13:00:00.000Z', issued='2026-11-22T12:00:00.000Z';
    const local=process.env.RALLY_PRIVATE_CHECKED_FORECAST;
    if(local){
        const verified=JSON.parse(await readFile(path.join(local,'independent-review.json')));
        assert.equal(verified.passed,true);assert.equal(verified.independentFrozenModelParity,true);
        const hash=b=>createHash('sha256').update(b).digest('hex');
        const proofBytes=await readFile(path.join(local,'complete.json'));
        assert.equal(hash(proofBytes),verified.inference.sha256);
        const proof=JSON.parse(proofBytes); assert.equal(proof.localPilotOnly,true);
        const forecastBytes=await readFile(path.join(local,'predictions.json'));
        assert.equal(hash(forecastBytes),proof.predictions.sha256);
        const rows=JSON.parse(forecastBytes);assert.equal(rows.length,1);
        playedMatch=rows[0].MatchTPId;probability=rows[0].ProbabilityPlayer1;
        start=new Date(rows[0].scheduledStartUtc).toISOString();issued=new Date(rows[0].forecastedAtUtc).toISOString();
    }
    const lock=Date.parse(start)-300000;
    let now=new Date(lock-1000), observation;
    assert.ok(Date.parse(issued)<+now-1000);
    const allowedSources=['rally-model-fair'];
    await publishCompetitionObservation({allowedSources,now,collection:{findOne:async()=>null,insertOne:async row=>{observation=row;}},
        input:{schema:'bonzobyte.competition-model-source.v1',oddsKind:'model-fair',matchTPId:playedMatch,revision:1,
            source:allowedSources[0],sourceEventId:'private-test',tournament:'Fixture',startAt:start,
            status:'scheduled',statusObservedAt:new Date(lock-2000).toISOString(),timePrecision:'minute',players:[playerA,playerB],
            model:{version:'fixture',issuedAt:issued,p1:probability}}});
    const store={readMatch:async()=>observation,ownMatch:async actor=>choices.get(actor.user),community:async()=>null,
        accept:async(actor,id,create)=>{
            const row=create({source:observation,existing:choices.get(actor.user),used:0,at:now});
            const pick={...row,matchTPId:id,submittedAt:now.toISOString()};choices.set(actor.user,pick);return pick;
        }};
    const localFixtureAuth=(req,_res,next)=>{req.user={_id:req.get('x-fixture-id'),isVerified:true,tokenVersion:0};next();};
    const app=express();app.use('/api/competition',createCompetitionRouter({auth:localFixtureAuth,
        service:createCompetition({store,modelFairOnly:true,allowedSources,secret:'private-unit-fixture',now:()=>now})}));
    const server=app.listen(0,'127.0.0.1');await once(server,'listening');
    try {
        const url=`http://127.0.0.1:${server.address().port}/api/competition/matches/${playedMatch}`;
        const quote=async user=>(await fetch(url,{headers:{'x-fixture-id':user}})).json();
        const send=(user,token)=>fetch(url,{method:'POST',headers:{'x-fixture-id':user,'content-type':'application/json'},
            body:JSON.stringify({side:0,token})});
        const a=(await quote('local-test-a')).quote,b=(await quote('local-test-b')).quote;
        assert.deepEqual(a.snapshot.odds,[1/probability,1/(1-probability)]);assert.equal(a.snapshot.lockAt,new Date(lock).toISOString());
        const ok=await send('local-test-a',a.token);assert.equal(ok.status,200);
        assert.deepEqual((await ok.json()).pick.snapshot.odds,a.snapshot.odds);
        now=new Date(lock);
        const no=await send('local-test-b',b.token);assert.equal(no.status,409);
        assert.equal((await no.json()).code,'COMPETITION_LOCKED');assert.equal(choices.size,1);
    }finally {server.close();await once(server,'close');}
});
