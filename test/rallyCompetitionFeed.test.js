import test from 'node:test';
import assert from 'node:assert/strict';
import {detailIdentity,shortlist} from '../utils/rallyCompetitionStatus.js';
import {scheduledInput,completedInput} from '../utils/rallyCompetitionFeed.js';
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
