import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompetition } from '../utils/competition.js';
import { createCompetitionStore } from '../utils/competitionStore.js';
import { competitionEligibility, competitionSummary, modelFairOdds, validateCompetitionObservation, settleCompetitionPick } from '../utils/competitionPolicy.js';
import { publishCompetitionObservation } from '../utils/competitionPublisher.js';

const startAt='2026-11-22T13:00:00.000Z', issuedAt='2026-11-22T10:00:00.000Z';
const at='2026-11-22T12:54:20.000Z';
const modelOnly={modelFairOnly:true}, allowedSources=['fixture-signed-model'];
const packet={schema:'bonzobyte.competition-model-source.v1',oddsKind:'model-fair',matchTPId:1234,revision:1,
    source:allowedSources[0],sourceEventId:'fixture-222',tournament:'Private fixture',startAt,status:'scheduled',
    timePrecision:'minute',statusObservedAt:'2026-11-22T12:54:00.000Z',
    players:[{id:101,name:'First player'},{id:102,name:'Second player'}],model:{version:'frozen-fixture',issuedAt,p1:.75}};

test('derives the full precision pair without any bookmaker fields',()=>{
    const row=validateCompetitionObservation(packet);
    assert.deepEqual(row.odds,[1/.75,4]);
    assert.equal(row.oddsObservedAt,issuedAt);
    assert.equal(row.bookmakers,0);
    assert.equal(competitionEligibility(row,new Date(at),allowedSources,modelOnly),null);
    assert.equal(competitionEligibility(row,new Date(at),[],modelOnly),'sourceUnavailable');
    for (const invalid of [{model:null},{odds:[2,2]},{bookmakers:2},{oddsObservedAt:at},
        {model:{...packet.model,issuedAt:'2026-11-22T12:54:01.000Z'}}])
        assert.throws(()=>validateCompetitionObservation({...packet,...invalid}),/COMPETITION_INVALID_SOURCE/);
    assert.equal(modelFairOdds(0),null);
    assert.equal(modelFairOdds(1),null);
});

test('tenth prediction is accepted; the eleventh is rejected at submission',async()=>{
    let used=9;
    const now=()=>new Date(at),actor={user:'limit-fixture'};
    const store={readMatch:async()=>packet,ownMatch:async()=>null,
        accept:async(_actor,id,create)=>{
            const row=create({source:packet,used,at:now()});
            used++; return {...row,matchTPId:id};
        }};
    const svc=createCompetition({store,secret:'fixture-only',allowedSources,now});
    const {quote}=await svc.match(actor,packet.matchTPId);
    assert.equal(svc.rules().dailyLimit,10);
    const body={side:0,token:quote.token};
    assert.equal((await svc.submit(actor,packet.matchTPId,body)).pick.side,0);
    await assert.rejects(svc.submit(actor,packet.matchTPId,body),{code:'COMPETITION_DAILY_LIMIT'});
    assert.equal(used,10);
});

test('both histories serve a full 31-day month at ten per day', async()=>{
    const rows=Array.from({length:310},(_,i)=>({matchTPId:i+1}));
    const cursor={sort(){return this},limit(n){return {toArray:async()=>rows.slice(0,n)}}};
    const store=createCompetitionStore({environment:'production',User:{collection:{findOne:async()=>({_id:'user'})}},
        connection:{collection:()=>({find:()=>cursor,countDocuments:async()=>7})}});
    const own=await store.own({user:'user',tokenVersion:0},'2026-10');
    assert.equal(own.rows.length,310); assert.equal(own.remainingToday,3);
    assert.equal((await store.publicPicks('12345678-1234-4123-8123-123456789abc','2026-10')).rows.length,310);
});

test('status must remain fresh and the first five-minute lock cannot be reopened',()=>{
    assert.equal(competitionEligibility(packet,new Date('2026-11-22T12:55:00.000Z'),allowedSources,modelOnly),'locked');
    assert.equal(competitionEligibility({...packet,statusObservedAt:'2026-11-22T12:50:00Z'},new Date(at),allowedSources,modelOnly),'stale');
    assert.equal(competitionEligibility({...packet,firstLockAt:'2026-11-22T12:54:00Z'},new Date(at),allowedSources,modelOnly),'locked');
    assert.equal(competitionEligibility({...packet,status:'live'},new Date(at),allowedSources,modelOnly),'locked');
    const legacy={...packet,schema:'bonzobyte.competition-source.v1',oddsKind:'median',odds:[1.4,3.1],oddsObservedAt:at,bookmakers:3};
    assert.equal(competitionEligibility(legacy,new Date(at),allowedSources,modelOnly),'sourceUnavailable');
    assert.equal(competitionEligibility(legacy,new Date(at),allowedSources),null);
});

test('virtual submission keeps the accepted odds, rejects a late quote, and settles without a market',async()=>{
    let now=new Date(at),row,pick;
    await publishCompetitionObservation({input:packet,allowedSources,now,collection:{findOne:async()=>null,insertOne:async v=>{row=v;}}});
    const actor={user:'fixture-account',tokenVersion:0};
    const store={readMatch:async()=>row,ownMatch:async()=>pick,community:async()=>null,
        accept:async(_who,_id,create)=>{
            const saved=create({source:row,existing:pick,used:0,at:now});
            pick={...saved,matchTPId:row.matchTPId,submittedAt:now.toISOString()};
            return pick;
        }};
    const svc=createCompetition({store,secret:'fixture-not-a-production-key',allowedSources,modelFairOnly:true,now:()=>now});
    const {quote}=await svc.match(actor,row.matchTPId);
    assert.deepEqual(quote.snapshot.odds,[1/.75,4]);
    now=new Date('2026-11-22T12:55:00.000Z');
    await assert.rejects(svc.submit(actor,row.matchTPId,{side:0,token:quote.token}),/COMPETITION_LOCKED/);
    now=new Date(at);
    await svc.submit(actor,row.matchTPId,{side:0,token:quote.token});
    const result={...packet,status:'finished',revision:2,statusObservedAt:'2026-11-22T15:00:00.000Z',resultVerified:true,winner:0,
        model:{...packet.model,p1:.6}};
    const settled=settleCompetitionPick(pick,result,new Date('2026-11-22T15:05:00.000Z'));
    assert.equal(settled.units,.333333);
    assert.equal(settled.marketUnits,null);
    const summary=competitionSummary([{...pick,settlement:settled}]);
    assert.equal(summary.comparison.count,0);
    assert.equal(summary.roi,33.3333);
});
