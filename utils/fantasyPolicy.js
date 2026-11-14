import { createHash } from 'node:crypto';

export const FANTASY_RULES = Object.freeze({ version:'fantasy-v1', budget:1000000, squad:10, perTour:5,
    monthlyTransfers:4, minHistory:5, rewardDays:30, reviewHours:72, priceMin:25000, priceRange:175000 });
export const FANTASY_COLLECTIONS = Object.freeze({ fantasySeasons:'fantasyseasons', fantasyPlayers:'fantasyplayers',
    fantasyTeams:'fantasyteams', fantasyFixtures:'fantasyfixtures', fantasyLedger:'fantasyledger', fantasyAwards:'fantasyawards' });
export const fantasyError = (code,status=400) => Object.assign(new Error(code),{code:'FANTASY_'+code,status});
export const need = (condition,code='INVALID_INPUT',status=400) => { if(!condition)throw fantasyError(code,status); };
export const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const RULES_SHA = sha(FANTASY_RULES);
export function monthBounds(month) {
    need(typeof month==='string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(month),'INVALID_MONTH');
    const start=new Date(month+'-01T00:00:00.000Z');
    const end=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1));
    return {start:start.toISOString(),end:end.toISOString()};
}
export const utcDay = at => new Date(at).toISOString().slice(0,10);
export const nextDay = at => new Date(new Date(utcDay(at)+'T00:00:00.000Z').getTime()+86400000).toISOString().slice(0,10);
export function instant(value) {
    need(typeof value==='string' && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)),'UTC_REQUIRED');
    const normalized=new Date(value).toISOString();need(normalized.slice(0,19)===value.slice(0,19),'UTC_REQUIRED');return normalized;
}
const id = n => Number.isSafeInteger(n)&&n>0;
const digest = value => typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const validName = value => typeof value==='string'&&value.trim().length>=2&&value.trim().length<=80&&!/[\p{Cc}\p{Cf}<>]/u.test(value);
export function buildSeason(input,at=new Date()) {
    need(input?.schema==='bonzobyte.fantasy-season-input.v1'&&input.calculationPolicy==='typed-scoring-v2'&&digest(input.sourceSha256),'INVALID_SOURCE');
    need(input.catalogueCoverage===undefined||['reviewed-main-tour','reviewed-grand-slam-pool-2026'].includes(input.catalogueCoverage),'INVALID_CATALOGUE');
    const bounds=monthBounds(input.month),observed=instant(input.observedAt),asOf=instant(input.sourceAsOf);
    need(observed<=at.toISOString()&&asOf<=observed&&observed<bounds.start&&at.toISOString()<bounds.start,'HISTORICAL_SEASON_FORBIDDEN',409);
    need(Array.isArray(input.players)&&input.players.length<=20000,'INVALID_CATALOGUE');
    const seen=new Set(),players=[];
    for(const raw of input.players) {
        need(id(raw.playerId)&&!seen.has(raw.playerId),'DUPLICATE_PLAYER');seen.add(raw.playerId);
        need(validName(raw.name)&&['ATP','WTA'].includes(raw.tour)&&Number.isFinite(raw.mu)&&raw.mu>=-100&&raw.mu<=100
            &&Number.isFinite(raw.sigma)&&raw.sigma>0&&raw.sigma<=100&&Number.isSafeInteger(raw.recentMatches)&&raw.recentMatches>=0,'INVALID_PLAYER');
        const last=instant(raw.lastMatchAt);
        need(last<=asOf,'FUTURE_HISTORY_FORBIDDEN');
        if(raw.mainTourEligible!==true||raw.recentMatches<FANTASY_RULES.minHistory||Date.parse(asOf)-Date.parse(last)>365*86400000)continue;
        players.push({playerId:raw.playerId,name:raw.name.trim(),tour:raw.tour,
            countryISO2:/^[a-z]{2}$/i.test(raw.countryISO2||'')?raw.countryISO2.toLowerCase():null,
            countryISO3:/^[A-Z]{3}$/.test(raw.countryISO3||'')?raw.countryISO3:null,
            mu:raw.mu,sigma:raw.sigma,strength:raw.mu-2*raw.sigma,recentMatches:raw.recentMatches,lastMatchAt:last});
    }
    for(const tour of ['ATP','WTA']) {
        const group=players.filter(p=>p.tour===tour).sort((a,b)=>a.strength-b.strength||a.playerId-b.playerId);
        need(group.length>=5,'INSUFFICIENT_PLAYERS');
        for(let i=0;i<group.length;) {
            let end=i+1;while(end<group.length&&group[end].strength===group[i].strength)end++;
            const percentile=group.length===1?.5:(i+end-1)/2/(group.length-1);
            const price=Math.round((25000+175000*percentile**2)/1000)*1000;
            for(let j=i;j<end;j++)group[j].price=price;
            i=end;
        }
    }
    need(['ATP','WTA'].reduce((sum,t)=>sum+players.filter(p=>p.tour===t).sort((a,b)=>a.price-b.price).slice(0,5).reduce((s,p)=>s+p.price,0),0)<=FANTASY_RULES.budget,'NO_AFFORDABLE_SQUAD');
    players.sort((a,b)=>a.playerId-b.playerId);
    return {season:{month:input.month,...bounds,status:'open',rules:FANTASY_RULES,rulesSha:RULES_SHA,
        sourceSha:input.sourceSha256,observedAt:observed,sourceAsOf:asOf,catalogueSha:sha(players),fixtureRevision:0,
        rewardsEnabled:input.rewardsEnabled===true,catalogueCoverage:input.catalogueCoverage??'reviewed-main-tour',createdAt:at.toISOString()},players};
}
export function normalizeSquad(ids,players) {
    need(Array.isArray(ids)&&ids.length===10&&ids.every(id)&&new Set(ids).size===10,'SQUAD_REQUIRED');
    const byId=new Map(players.map(p=>[p.playerId,p]));
    need(ids.every(n=>byId.has(n)),'PLAYER_UNAVAILABLE',409);
    const selected=ids.map(n=>byId.get(n));
    need(selected.filter(p=>p.tour==='ATP').length===5&&selected.filter(p=>p.tour==='WTA').length===5,'TOUR_BALANCE');
    const cost=selected.reduce((sum,p)=>sum+p.price,0);need(Number.isSafeInteger(cost)&&cost<=1000000,'BUDGET_EXCEEDED');
    return {players:[...ids].sort((a,b)=>a-b),cost,cash:1000000-cost};
}
export const changes = (before,after) => after.filter(id=>!before.includes(id)).length;
export function lineupForDay(team,day) {return [...(team?.lineups||[])].filter(r=>r.day<=day).sort((a,b)=>a.day.localeCompare(b.day)).at(-1)?.players||[];}
export function transferCount(lineups) {return lineups.reduce((sum,row,i)=>sum+(i?changes(lineups[i-1].players,row.players):0),0);}
export function planTeam(existing,season,players,body,at=new Date()) {
    need(season?.status==='open'&&season.rulesSha===RULES_SHA,'SEASON_CLOSED',409);
    need(body&&Object.keys(body).every(k=>['players','revision','name'].includes(k))&&Number.isSafeInteger(body.revision)&&body.revision>=0,'INVALID_BODY');
    need((existing?.revision||0)===body.revision,'TEAM_CHANGED',409);
    const name=body.name??existing?.name;need(validName(name)&&name.trim().length<=40,'INVALID_TEAM_NAME');
    const roster=normalizeSquad(body.players,players),beforeStart=at.toISOString()<season.start;
    const effective=beforeStart?season.start.slice(0,10):nextDay(at);
    need(effective<season.end.slice(0,10),'SEASON_CLOSED',409);
    const earlier=(existing?.lineups||[]).filter(row=>row.day<effective);
    const previous=earlier.at(-1)?.players;
    const lineups=[...earlier,...(!previous||changes(previous,roster.players)>0?[{day:effective,players:roster.players}]:[])];
    need(transferCount(lineups)<=4,'TRANSFER_LIMIT',409);
    return {name:name.trim(),qualified:existing?.qualified??beforeStart,revision:body.revision+1,lineups,
        firstDay:existing?.firstDay??effective,createdAt:existing?.createdAt??at.toISOString(),updatedAt:at.toISOString()};
}
export function prepareFixture(input,season,at=new Date()) {
    need(season.status==='open'&&season.rulesSha===RULES_SHA,'SEASON_CLOSED',409);
    need(input?.schema==='bonzobyte.fantasy-fixture-input.v1'&&id(input.matchId)&&id(input.player1Id)&&id(input.player2Id)
        &&input.player1Id!==input.player2Id&&['ATP','WTA'].includes(input.tour)&&input.mainDraw===true&&input.category==='main-tour-singles'
        &&input.startVerified===true&&digest(input.sourceSha256)&&input.calculationPolicy==='typed-scoring-v2','INVALID_FIXTURE');
    const startAt=instant(input.startAt),capturedAt=instant(input.capturedAt),sourceAsOf=instant(input.sourceAsOf);
    const day=startAt.slice(0,10),lockAt=day+'T00:00:00.000Z';
    need(startAt>=season.start&&startAt<season.end&&capturedAt<lockAt&&sourceAsOf<=capturedAt&&capturedAt<=at.toISOString()
        &&at.toISOString()<lockAt,'PREMATCH_SNAPSHOT_REQUIRED',409);
    need(Number.isFinite(input.player1Probability)&&input.player1Probability>=0&&input.player1Probability<=1
        &&input.probabilityKind==='prematch-ts-M'&&input.predictionComputed===true,'INVALID_PROBABILITY');
    const snapshot={matchId:input.matchId,player1Id:input.player1Id,player2Id:input.player2Id,tour:input.tour,
        day,lockAt,startAt,capturedAt,sourceAsOf,player1Probability:input.player1Probability,sourceSha:input.sourceSha256};
    return {...snapshot,snapshotSha:sha(snapshot),revision:0,status:'pending',winnerId:null,result:null,pendingSettlement:false};
}
export function resultUpdate(fixture,input,at=new Date()) {
    need(input?.matchId===fixture.matchId&&input.snapshotSha===fixture.snapshotSha&&Number.isSafeInteger(input.revision)
        &&input.revision>fixture.revision&&digest(input.sourceSha256),'RESULT_CHANGED',409);
    need(at.toISOString()>=fixture.startAt,'PREMATURE_RESULT',409);
    need(['finished','void'].includes(input.status),'INVALID_RESULT');
    if(input.status==='finished')need([fixture.player1Id,fixture.player2Id].includes(input.winnerId)&&input.validated===true
        &&input.retired===false&&input.walkover===false&&typeof input.result==='string'&&/^(?:2:[01]|3:[012])$/.test(input.result)
        &&input.scoringPolicy==='typed-scoring-v2','INVALID_RESULT');
    else need(typeof input.reason==='string'&&input.reason.length>=3&&input.reason.length<=160,'VOID_REASON_REQUIRED');
    return {revision:input.revision,status:input.status,winnerId:input.status==='finished'?input.winnerId:null,
        result:input.status==='finished'?input.result:null,resultSourceSha:input.sourceSha256,
        voidReason:input.status==='void'?input.reason:null,settledAt:at.toISOString(),pendingSettlement:true};
}
export function pointsMinor(probability,won) {
    need(Number.isFinite(probability)&&probability>=0&&probability<=1,'INVALID_PROBABILITY');
    const amount=(won?10+10*(1-probability):-10*probability)*100;
    return amount===0?0:Math.sign(amount)*Math.round(Math.abs(amount)+1e-9);
}
export function settleTeam(team,fixture) {
    const lineup=lineupForDay(team,fixture.day),entries=[];
    for(const [playerId,p] of [[fixture.player1Id,fixture.player1Probability],[fixture.player2Id,1-fixture.player1Probability]]) {
        if(!lineup.includes(playerId))continue;
        entries.push({playerId,probability:p,outcome:fixture.status==='void'?'void':fixture.winnerId===playerId?'won':'lost',
            pointsMinor:fixture.status==='void'?0:pointsMinor(p,fixture.winnerId===playerId)});
    }
    return {fixtureId:fixture.matchId,sourceRevision:fixture.revision,snapshotSha:fixture.snapshotSha,day:fixture.day,
        entries,pointsMinor:entries.reduce((sum,row)=>sum+row.pointsMinor,0),status:fixture.status};
}
export function teamView(team,season,players,at=new Date()) {
    if(!team)return null;
    const day=utcDay(at),pendingRows=team.lineups.filter(r=>r.day>day),last=team.lineups.at(-1),squad=normalizeSquad(last.players,players);
    const active=team.lineups.filter(r=>r.day<=day);
    return {id:team.publicId,name:team.name,revision:team.revision,qualified:team.qualified,firstDay:team.firstDay,
        currentPlayers:lineupForDay(team,day),plannedPlayers:last.players,effectiveDay:pendingRows.at(-1)?.day??day,
        usedTransfers:transferCount(active),reservedTransfers:transferCount(team.lineups)-transferCount(active),
        remainingTransfers:4-transferCount(team.lineups),cost:squad.cost,cash:squad.cash,season:season.month};
}
