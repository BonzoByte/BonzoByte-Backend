import test from 'node:test';
import assert from 'node:assert/strict';
import {detailIdentity,shortlist} from '../utils/rallyCompetitionStatus.js';
import {scheduledInput,completedInput,createRallyCompetitionFeed} from '../utils/rallyCompetitionFeed.js';
import {archiveMatch,ordinaryWinner,provisionalFinal,readRallyPacket,recentDay,zagrebDay} from '../utils/rallyCompetitionFinal.js';
import {validateCompetitionObservation,settleCompetitionPick} from '../utils/competitionPolicy.js';
import {createCompetitionStore} from '../utils/competitionStore.js';
import {createCompetition} from '../utils/competition.js';
const start='2026-11-26T18:00:00.000Z',issued='2026-11-26T14:00:00.000Z', now=Date.parse('2026-11-26T15:00:00.000Z');
const m={matchTPId:8,matchId:100,player1TPId:10,player2TPId:11,player1Name:'One A',player2Name:'Two B',isFinished:false,
    tournamentEventName:'Buenos Aires (Argentina Open)',tournamentTypeName:'WTA',publicForecastIssuedAtUtc:issued,modelProbabilityPlayer1:60};
const b={...m,p1:.6,issuedAtUtc:issued,earliestScheduledStartUtc:start};
const te='<i class="timezone">GMT+1</i><div class="boxBasic lGray">Today, 19:00, <a href="/buenos-aires/2026/wta-women/">Buenos Aires WTA</a> Match has not started <iframe class="game-fblike" src="/match-detail/?id=33"></iframe></div>'+
    '<table class="result gDetail"><thead><tr><th class="plName"><a>One A</a></th><td class="gScore"></td><th class="plName"><a>Two B</a></th></tr></thead></table>';
test('TE pairs each Buenos Aires opening row with its own opponent, not just the tournament’s first row',()=>{
    const pairs=[
        ['one fRow bott','Maristany Zuleta De Reales G.','Brancaccio N.','Maristany Zuleta De Reales Guiomar','Brancaccio Nuria',3388473],
        ['two bott','Costoulas S.','Lepchenko V.','Costoulas Sofia','Lepchenko Varvara',3388707],
        ['one bott','Burillo Escorihuela I.','Samson L.','Burillo Escorihuela Irene','Samson Laura',3388699],
        ['two bott','Carle M.','Podoroska N.','Carle Maria Lourdes','Podoroska Nadia',3389221],
    ];
    const rows=pairs.map(([cls,a,b,,,teId],i)=>
        '<tr id="r'+(10+i)+'" class="'+cls+'"><td><a href="/player/a">'+a+'</a></td><td><a href="/match-detail/?id='+teId+'">info</a></td></tr>'+
        '<tr id="r'+(10+i)+'b"><td><a href="/player/b">'+b+'</a></td></tr>');
    const table=rows=>'<table class="result"><tbody>'+rows+'</tbody></table>';
    const html=table(rows.join(''));
    for(const [,, ,player1Name,player2Name,id] of pairs)assert.equal(shortlist(html,{player1Name,player2Name}),id);
    const m={player1Name:pairs[1][3],player2Name:pairs[1][4]};
    assert.equal(shortlist(table(rows[1].replace('r11b','r12b')),m),null);
    assert.equal(shortlist(table(rows[1].replace('</tr><tr','</tr></tbody><tbody><tr')),m),null);
    assert.equal(shortlist(table(rows[1]+rows[1].replace('3388707','9999999')),m),null);
    assert.equal(shortlist(html,{...m,player2Name:'Samson Laura'}),null);
});
test('explicit, match-specific status, clock, identity and blank scores all required',()=>{
    assert.equal(detailIdentity(te,33,m,start,now),true);
    for(const [from,to] of [['Match has not started',''],['19:00','18:00'],['Two B','Other'],['Buenos Aires WTA','Elsewhere WTA'],['?id=33','?id=37'],['gScore"></td>','gScore">15</td>'],['Match has not started','Match has not started (suspended)']]){
        assert.equal(detailIdentity(te.replace(from,to)+'<p>match has not started</p>',33,m,start,now),false);
    }
});
test('only confirmed and frozen prices open the index; a stale heartbeat, held status or lock disables it',async()=>{
    const status={at:now,id:'TE:33'}, x=scheduledInput(m,b,start,status,now);
    assert.ok(x); for(const wrong of [null,{...status,at:now-120000},{...status,at:now+1}])assert.equal(scheduledInput(m,b,start,wrong,now),null);
    assert.equal(scheduledInput({...m,player1TPId:11},b,start,status,now),null);
    let clock=now,rows=[x];const game=createCompetition({modelFairOnly:true,secret:'fixture',allowedSources:[x.source],
        store:{candidates:async()=>rows},now:()=>new Date(clock)});
    assert.deepEqual((await game.openings()).entries,[{id:8,until:now+120000}]);
    rows=[{...x,rallyHeld:true}];assert.deepEqual((await game.openings()).entries,[]);
    rows=[x];clock+=120001;assert.deepEqual((await game.openings()).entries,[]);
    const reversed={...m,player1TPId:11,player2TPId:10,isFinished:true,qualityStatus:'Validated',result:'21'};
    assert.equal(completedInput(x,reversed,Date.parse(start)+100000).winner,1);
    assert.equal(completedInput(x,{...reversed,player1TPId:12},Date.parse(start)+100000),null);
});
const date='2026-11-27',day='20261127',finalNow=Date.parse(date+'T17:00:00Z'),at=date+'T16:55:00.000Z';
const iso=n=>new Date(n).toISOString();
function quote(tp=8,d=date){
    const issued=d+'T10:00:00.000Z';
    return {...validateCompetitionObservation({schema:'bonzobyte.competition-model-source.v1',oddsKind:'model-fair',
        matchTPId:tp,source:'rally-model-fair',sourceEventId:'TP-schedule:'+tp,tournament:'Buenos Aires',status:'scheduled',timePrecision:'minute',
        startAt:d+'T12:00:00.000Z',statusObservedAt:issued,revision:Date.parse(issued),players:[{id:21,name:'A'},{id:22,name:'B'}],
        model:{issuedAt:issued,version:'rally-public-prematch-v1',p1:.75}}),_id:tp,acceptedReads:1};
}
const match=(tp=8,d=date)=>({matchTPId:tp,matchId:tp+100,tournamentEventTPId:31,tournamentEventName:'Buenos Aires',
    dateTime:d+'T00:00:00',player1TPId:21,player2TPId:22,isFinished:false,qualityStatus:'NotAssessed'});
const row=(tp=8)=>[tp,tp+100,21,22,31,'1:2','6:4 6:7(5) 2:6'];
const packet=(rows=[row()],d=day)=>({schema:'bonzobyte.provisional-results.v1',day:d,observedAt:at,rows});
test('full ordinary terminal sets only; verify summary, orientation and stopping point',()=>{
    assert.equal(ordinaryWinner('3:2','6:0 4:6 7:5 6:7(12) 7:6(0)'),0);
    assert.equal(ordinaryWinner('1:2','6:4 6:7(5) 2:6'),1);
    for(const [s,g] of [['2:1','6:1 6:2 4:6'],['1:2','6:3 6:3 3:6'],['2:0','7:4 6:0'],['2:0','6:5 6:2'],
        ['2:0','7:5(2) 6:0'],['2:0','7:6(05) 6:0'],['2:1','6:3 4:6 10:8'],['2:0','6:2 RET'],['1:0','6:0'],
        ['2:0','6:1'],['2:0','6:1 6:0 6:0'],['2:0','WO'],['2:0',null]])assert.equal(ordinaryWinner(s,g),null);
});
test('exact accepted identity and publication revision; no stale, conflicting or held substitutes',()=>{
    const q=quote(),m=match(),p=packet(),final=provisionalFinal(q,m,p,finalNow);
    assert.deepEqual(final,{...q,status:'finished',winner:1,resultVerified:true,statusObservedAt:at,revision:Date.parse(at)});
    assert.equal(settleCompetitionPick({matchTPId:8,snapshot:q,side:1,submittedAt:q.model.issuedAt},final,new Date(finalNow)).units,3);
    for(const delta of [{source:'demo'},{sourceEventId:'TP-schedule:9'},{status:'finished'},{acceptedReads:0},{pendingSettlement:true},
        {winner:0},{resultVerified:true},{_id:77},{matchId:888},{tournamentEventTPId:99},{odds:null},{players:[...q.players].reverse()},
        {revision:Date.parse(at)},{revision:Date.parse(at)+1},{statusObservedAt:iso(finalNow)}])
        assert.equal(provisionalFinal({...q,...delta},m,p,finalNow),null);
    for(const delta of [{tournamentEventName:'Another'},{dateTime:'2026-11-26'},{matchId:109},{matchTPId:9},{tournamentEventTPId:32},
        {player1TPId:22,player2TPId:21},{qualityStatus:'NonRatedOutcome'},{result:'20'},{resultDetails:'RET'},
        {status:'suspended'},{isFinished:true},{isFinished:undefined}])assert.equal(provisionalFinal(q,{...m,...delta},p,finalNow),null);
    for(const delta of [{day:'20261126'},{schema:'other'},{observedAt:iso(finalNow+1)},{observedAt:'2026-11-27T16:55:00'},
        {observedAt:'2026-11-27T11:59:59Z'},{rows:[row(),row()]},{rows:[row(),[10,...row().slice(1)]]},
        {rows:[[...row(),0]]},{rows:Array(601).fill(row())},{rows:[[...row().slice(0,5),'2:1',row()[6]]]}])
        assert.equal(provisionalFinal(q,m,{...p,...delta},finalNow),null);
    for(let i=0;i<5;i++){const r=row();r[i]++;assert.equal(provisionalFinal(q,m,packet([r]),finalNow),null);}
    assert.equal(archiveMatch(q,[m,m],day),null);assert.equal(archiveMatch(q,[m,{...m,matchTPId:9}],day),null);
});
test('window is Zagreb civil days, not elapsed 24-hour blocks; rechecked after midnight',()=>{
    for(const [clock,days,outside] of [
        ['2026-03-29T22:01:00Z',['20260330','20260329','20260328'],'20260327'],
        ['2026-10-25T22:59:00Z',['20261025','20261024','20261023'],'20261022'],
        ['2026-12-31T23:01:00Z',['20270101','20261231','20261230'],'20261229']]){
        const n=Date.parse(clock);assert.equal(zagrebDay(n),days[0]);assert.ok(days.every(d=>recentDay(d,n)));assert.ok(!recentDay(outside,n));
    }
    const d='2026-11-25',q=quote(8,d),m=match(8,d),p=packet([row()],'20261125');
    assert.ok(provisionalFinal(q,m,p,finalNow));assert.equal(provisionalFinal(q,m,p,Date.parse('2026-11-27T23:00:00Z')),null);
});
function memory(quotes){
    const changes=[];
    return {changes,find(){const cursor={sort:()=>cursor,limit:()=>cursor,toArray:async()=>quotes.map(q=>({...q}))};return cursor;},
        async updateOne(f,u,opts){
            assert.equal(opts.upsert,undefined);
            const q=quotes.find(q=>q._id===f._id&&q.revision===f.revision&&q.status===f.status&&q.acceptedReads>0);
            if(!q)return {matchedCount:0};
            assert.deepEqual(Object.keys(u.$set).sort(),['pendingSettlement','publishedAt','resultVerified','revision','status','statusObservedAt','winner']);
            changes.push(q._id);Object.assign(q,u.$set);return {matchedCount:1};
        }};
}
test('failed offers and failed day do not block other finals; canonical wins; per-poll shared reads and no corrections',async()=>{
    const yesterday='2026-11-26',older='2026-11-24';
    const qs=[quote(1,yesterday),quote(2,yesterday),quote(3),quote(4),quote(5),quote(6,older),quote(7,older)];
    const db=memory(qs),reads=[],archives=[];
    const feed=createRallyCompetitionFeed(db,{clock:()=>finalNow,
        refresh:async(_,__,read)=>{await read('provisional-results/'+day);throw Error('offer bulk unavailable');},
        read:async route=>{reads.push(route);if(!route.endsWith(day))throw Error('unavailable');return packet([row(3),row(4),row(5)]);},
        getReader:async()=>({readJson:async path=>{
            archives.push(path);return qs.filter(q=>path==='daily/'+q.startAt.slice(0,10).replaceAll('-','')+'.br').map(q=>{
                const m=match(q._id,q.startAt.slice(0,10));
                return [5,6].includes(q._id)?{...m,isFinished:true,qualityStatus:'Validated',result:'20'}:m;
            });
        }})});
    await assert.rejects(feed.poll(),/partially unavailable/);
    assert.deepEqual(db.changes,[3,4,5,6]);assert.equal(qs[4].winner,0);
    assert.deepEqual(reads.sort(),['provisional-results/20261126','provisional-results/20261127']);
    assert.equal(archives.length,3);assert.equal(qs[2].statusObservedAt,at);assert.equal(qs[2].pendingSettlement,true);
    await assert.rejects(feed.poll());assert.deepEqual(db.changes,[3,4,5,6]);
});
test('archive outage cannot settle from TP alone; concurrent terminal state cannot be corrected',async()=>{
    const q=quote(),db=memory([q]),base={clock:()=>finalNow,refresh:async()=>0};
    await assert.rejects(createRallyCompetitionFeed(db,{...base,getReader:async()=>{throw Error('offline');},
        read:async()=>assert.fail('no archive')}).poll());
    await assert.rejects(createRallyCompetitionFeed(db,{...base,getReader:async()=>({readJson:async()=>[match()]}),
        read:async()=>{q.status='finished';q.winner=0;return packet();}}).poll());
    assert.equal(q.winner,0);assert.deepEqual(db.changes,[]);
});
test('canonical finals accept native event keys including legacy TP:<id> without consulting TP packets',async()=>{
    const qs=[{...quote(1),sourceEventId:'TP:1'},{...quote(2),sourceEventId:'native-accepted-event'}],db=memory(qs);
    await createRallyCompetitionFeed(db,{clock:()=>finalNow,refresh:async()=>0,
        getReader:async()=>({readJson:async()=>qs.map(q=>({...match(q._id),isFinished:true,qualityStatus:'Validated',result:'02'}))}),
        read:async()=>assert.fail('canonical final fetched provisional feed')}).poll();
    assert.deepEqual(db.changes,[1,2]);assert.ok(qs.every(q=>q.winner===1));
});
test('private archive rows are reused under five minutes, never across release IDs, with bounded eviction',async()=>{
    let clock=finalNow,releaseId='first',reads=0;
    const feed=createRallyCompetitionFeed(memory([quote()]),{clock:()=>clock,refresh:async()=>0,
        getReader:async()=>({releaseId,readJson:async()=>{reads++;return [];}}),
        read:async()=>assert.fail('missing archive identity fetched TP')});
    await feed.poll();clock+=299999;await feed.poll();assert.equal(reads,1);
    clock++;await feed.poll();assert.equal(reads,2);
    for(let i=1;i<=8;i++){releaseId='next-'+i;await feed.poll();assert.equal(reads,2+i);}
    await feed.poll();assert.equal(reads,10);releaseId='first';await feed.poll();assert.equal(reads,11);
});
test('bounded pinned HTTPS reader rejects foreign URLs, redirects and oversized packets without retries',async t=>{
    let calls=0,response;
    t.mock.method(globalThis,'fetch',async(url,o)=>{calls++;assert.equal(url,'https://bonzobyte.com/api/provisional-results/'+day);
        assert.equal(o.redirect,'error');assert.equal(o.cache,'no-store');return response;});
    const route='provisional-results/'+day;
    await assert.rejects(readRallyPacket('https://elsewhere.invalid/'));assert.equal(calls,0);
    for(const [body,status,type] of [['',302,'application/json'],['{}',200,'text/html'],['x'.repeat(96*1024+1),200,'application/json']]){
        response=new Response(body,{status,headers:{'content-type':type}});await assert.rejects(readRallyPacket(route));
    }
    response=Response.json(packet());assert.deepEqual(await readRallyPacket(route),packet());assert.equal(calls,4);
});
test('durable final drains once through native reconciliation with the feed offline, at accepted odds',async()=>{
    const q=quote(),db=memory([q]),pick={_id:77,matchTPId:8,submittedAt:q.statusObservedAt,
        side:1,snapshot:structuredClone(q),settlement:null};
    await createRallyCompetitionFeed(db,{clock:()=>finalNow,refresh:async()=>0,
        getReader:async()=>({readJson:async()=>[match()]}),read:async()=>packet()}).poll();
    const unavailable=async()=>{throw Error('offline');};
    await assert.rejects(createRallyCompetitionFeed(memory([quote(99)]),{clock:()=>finalNow,refresh:unavailable,getReader:unavailable}).poll());
    const cursor=rows=>({sort(){return this;},limit(){return this;},toArray:async()=>rows});
    const matches={find:()=>cursor(q.pendingSettlement?[q]:[]),updateOne:async(f,u)=>{assert.equal(f.revision,q.revision);Object.assign(q,u.$set);}};
    const picks={find:()=>cursor(pick.settlement?[]:[pick]),findOne:async()=>pick.settlement?null:pick,
        updateOne:async(f,u)=>{assert.equal(f._id,pick._id);assert.equal(u.$push,undefined);Object.assign(pick,u.$set);}};
    const store=createCompetitionStore({connection:{collection:n=>n==='competitionpicks'?picks:matches},environment:'production',
        allowedSources:[q.source],now:()=>new Date(finalNow)});
    assert.deepEqual(await store.reconcile(),{processed:1});assert.equal(pick.settlement.units,3);
    assert.equal(pick.settlement.resultObservedAt,at);assert.equal(q.pendingSettlement,false);
    assert.deepEqual(await store.reconcile(),{processed:0});
});
