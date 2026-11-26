import test from 'node:test';
import assert from 'node:assert/strict';
import {announcedOffers,dailyOffers,refreshScheduleOffers} from '../utils/rallyScheduledCompetition.js';
import {createCompetition} from '../utils/competition.js';
import {competitionEligibility,competitionSnapshot} from '../utils/competitionPolicy.js';
const day='20261126',start='2026-11-26T19:00:00.000Z', now=Date.parse(start)-1800000, obs='2026-11-26T17:00:00.000Z';
const tp=123, m={matchTPId:tp,player1TPId:1,player2TPId:2,player1Name:'A',player2Name:'B',tournamentEventName:'Florianopolis',
    isFinished:false,modelProbabilityPlayer1:60,publicForecastIssuedAtUtc:'2026-11-26T17:02:00.000Z'};
const schedule={schema:'bonzobyte.planned-match-schedule.v1',day,observedAt:obs,slots:[[tp,1,2,start]]};
const data={daily:{matches:[m]},schedule,day,now}, get=(x={})=>dailyOffers({...data,...x}).offers;
test('displayed future minute opens without a TE confirmation; wrong ids, date-only, score and missing model do not',()=>{
    const [o]=get();assert.equal(o.startAt,start);assert.equal(o.statusObservedAt,obs);assert.deepEqual(o.odds,[1/.6,1/.4]);
    for(const s of [[tp,1,2,day],[tp,2,1,start],[tp,1,2,null]])assert.deepEqual(get({schedule:{...schedule,slots:[s]}}),[]);
    for(const patch of [{isFinished:true},{result:'21'},{resultDetails:'1:0'},{status:'live'},{modelProbabilityPlayer1:null}])
        assert.deepEqual(get({daily:{matches:[{...m,...patch}]}}),[]);
    assert.deepEqual(get({results:{day,schema:'bonzobyte.provisional-results.v1',rows:[[tp]]}}),[]);
    assert.deepEqual(get({now:Date.parse(start)}),[]);
});
test('19:59 is eligible; same quote at exactly 20:00 is rejected by the submitting server',async()=>{
    const [o]=get();let at=Date.parse(start)-1000, pick;
    const source={...o,scheduleCheckedAt:new Date(at).toISOString(),firstLockAt:start};
    const store={candidates:async()=>[source],readMatch:async()=>source,ownMatch:async()=>null,community:async()=>null,
        accept:async(_a,_id,build)=>{pick=build({source,used:0,at:new Date(at)});return pick;}};
    const svc=createCompetition({store,secret:'schedule-test',allowedSources:[o.source],modelFairOnly:true,now:()=>new Date(at)});
    const actor={user:'test'}, {quote}=await svc.match(actor,tp);
    assert.equal(quote.snapshot.lockAt,start);assert.deepEqual(quote.snapshot.odds,o.odds);
    assert.deepEqual((await svc.openings()).entries,[{id:tp,until:Date.parse(start)}]);
    await svc.submit(actor,tp,{side:0,token:quote.token});assert.equal(pick.snapshot.odds[0],1/.6);
    at++;assert.deepEqual(competitionSnapshot({...source,scheduleCheckedAt:new Date(at).toISOString()}),quote.snapshot);
    at=Date.parse(start);await assert.rejects(svc.submit(actor,tp,{side:0,token:quote.token}),/COMPETITION_LOCKED/);
    assert.deepEqual((await svc.openings()).entries,[]);
    assert.equal(competitionEligibility({...source,rallyHeld:true},new Date(now),[o.source]),'sourceUnavailable');
});
test('announced tomorrow: explicit clock and issued model; no midnight inference or current-day reuse',()=>{
    const m={id:tp,start,names:['A','B'],grid:{title:'T',players:[{id:1},{id:2}],forecast:{p:.7,at:obs}}};
    const packet={day:'2026-11-26',zone:'Europe/Zagreb',observedAt:obs,matches:[m,{...m,id:124,start:null}]};
    assert.equal(announcedOffers(packet,day,now).length,1);
    assert.throws(()=>announcedOffers(packet,'20261127',now));
});
test('a new score immediately holds the existing offer; a terminal document is never upserted again',async()=>{
    const o=get()[0];let ops=[];
    const run=async(old,results)=>refreshScheduleOffers({find:()=>({toArray:async()=>[old]}),bulkWrite:async x=>ops=x},now,
        async p=>p.startsWith('archives/')?data.daily:p.startsWith('match-schedule/')?schedule:p.startsWith('provisional-results/')?results:null);
    const old={...o,_id:tp,firstLockAt:start};await run(old,{day,schema:'bonzobyte.provisional-results.v1',rows:[[tp]]});
    assert.equal(ops[0].updateOne.update.$set.rallyStarted,true);ops=[];await run({...old,status:'finished'},null);assert.equal(ops.length,0);
});
