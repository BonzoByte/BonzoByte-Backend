import {privateArchiveRuntime} from './privateArchiveRuntime.js';
import {projectPublicDailyMatch} from './publicDailyMatch.js';
import {refreshScheduleOffers} from './rallyScheduledCompetition.js';
import {publishCompetitionObservation} from './competitionPublisher.js';
import {accepted,archiveMatch,provisionalFinal,readRallyPacket,recentDay,zagrebDay} from './rallyCompetitionFinal.js';

export const rallySource='rally-model-fair';
const iso=n=>new Date(n).toISOString();
export function scheduledInput(m,b,start,status,now){
    if(!status||!Number.isFinite(status.at)||now-status.at>=120000||status.at>now||!m.publicForecastIssuedAtUtc||
        m.isFinished!==false||m.result||m.resultDetails||b?.matchTPId!==m.matchTPId||b.player1TPId!==m.player1TPId||
        b.player2TPId!==m.player2TPId||b.matchId!==m.matchId||b.p1*100!==m.modelProbabilityPlayer1||
        !Number.isFinite(Date.parse(start))||Date.parse(start)!==Date.parse(b.earliestScheduledStartUtc)||
        Date.parse(m.publicForecastIssuedAtUtc)!==Date.parse(b.issuedAtUtc)||Date.parse(b.issuedAtUtc)>status.at||
        now>=Date.parse(start)-300000)return null;
    return {schema:'bonzobyte.competition-model-source.v1',source:rallySource,sourceEventId:status.id,oddsKind:'model-fair',
        matchTPId:m.matchTPId,tournament:m.tournamentEventName,startAt:start,revision:status.at,timePrecision:'minute',status:'scheduled',
        statusObservedAt:iso(status.at),players:[{id:m.player1TPId,name:m.player1Name},{id:m.player2TPId,name:m.player2Name}],
        model:{issuedAt:iso(Date.parse(b.issuedAtUtc)),version:'rally-public-prematch-v1',p1:b.p1}};
}
export function completedInput(old,match,now){
    if(!match||match.matchTPId!==old.matchTPId||match.isFinished!==true||!/^20$|^21$|^02$|^12$|^30$|^31$|^32$|^03$|^13$|^23$/.test(match.result)||
        match.qualityStatus!=='Validated'||Date.parse(old.startAt)>now)return null;
    const ids=[match.player1TPId,match.player2TPId], winnerId=ids[+match.result[0]>+match.result[1]?0:1];
    if(!old.players.every(p=>ids.includes(p.id)))return null;
    return {...old,revision:now,status:'finished',statusObservedAt:iso(now),resultVerified:true,winner:old.players.findIndex(p=>p.id===winnerId)};
}
// The standard publisher validates the full final. Give it only a conditional
// terminal update, never insert/replace or a second revision of a settled row.
function send(collection,old,input,now){
    const bound={
        findOne:async()=>old,
        updateOne:(filter,{$set},options)=>collection.updateOne({...filter,source:old.source,sourceEventId:old.sourceEventId,
            status:'scheduled',acceptedReads:{$gt:0},pendingSettlement:{$ne:true},resultVerified:{$ne:true},winner:null,
            startAt:old.startAt,tournament:old.tournament,'players.0.id':old.players[0].id,'players.1.id':old.players[1].id},
        {$set:{status:$set.status,winner:$set.winner,resultVerified:$set.resultVerified,revision:$set.revision,
            statusObservedAt:$set.statusObservedAt,publishedAt:$set.publishedAt,pendingSettlement:$set.pendingSettlement}},options),
    };
    return publishCompetitionObservation({collection:bound,input,allowedSources:[rallySource],now:new Date(now)});
}
const oncePerKey=load=>{
    const cache=new Map();
    return key=>{
        if(!cache.has(key))cache.set(key,Promise.resolve().then(()=>load(key)));
        return cache.get(key);
    };
};
export function createRallyCompetitionFeed(collection,{clock=Date.now,refresh=refreshScheduleOffers,
    getReader=()=>privateArchiveRuntime.getReader(),read=readRallyPacket}={}){
    let lastProbe=0;
    const archiveCache=new Map();
    async function finals(now,packet){
        const outstanding=await collection.find({source:rallySource,status:'scheduled',acceptedReads:{$gt:0},startAt:{$lte:iso(now)}},
            {maxTimeMS:3500}).sort({startAt:-1}).limit(150).toArray();
        const pending=outstanding.filter(accepted);
        if(!pending.length)return;
        const reader=await getReader();
        const daily=oncePerKey(async day=>{
            const key=reader.releaseId+':'+day,cached=archiveCache.get(key);
            if(cached&&now-cached.at<300000)return cached.rows;
            const rows=await reader.readJson('daily/'+day+'.br',{maxBytes:5*1024*1024});
            if(!Array.isArray(rows)||rows.length>2500)throw Error('Invalid Rally daily archive');
            const projected=rows.map(r=>r&&({...projectPublicDailyMatch(r),status:r.status,
                // Projection alone normalizes even a missing flag to false.
                explicitPending:(r.isFinished??r.l03)===false&&(r.l03==null||r.l03===false)}));
            if(reader.releaseId){
                archiveCache.set(key,{at:now,rows:projected});
                if(archiveCache.size>8)archiveCache.delete(archiveCache.keys().next().value);
            }
            return projected;
        });
        let failed=false;
        for(const old of pending){
            try{
                const day=zagrebDay(Date.parse(old.startAt)),m=archiveMatch(old,await daily(day),day);
                if(!m)continue;
                let final=completedInput(old,m,clock());
                // Never substitute TP for a canonical final, partial or held outcome.
                if(!final&&m.explicitPending&&m.isFinished===false&&!m.result&&!m.resultDetails&&recentDay(day,now)&&recentDay(day,clock()))
                    final=provisionalFinal(old,m,await packet('provisional-results/'+day),clock());
                if(final)await send(collection,old,final,clock());
            }catch{failed=true;} // Other identities/dates still get their own reconciliation.
        }
        if(failed)throw Error('Some Rally finals unavailable');
    }
    return {connected:()=>clock()-lastProbe<120000,async poll(){
        const now=clock(),packet=oncePerKey(read);
        const offers=async()=>{if(await refresh(collection,now,packet))lastProbe=clock();};
        // A broken offer bulk write must not suppress finals; wait for both
        // before returning to the runtime's independent native reconcile().
        const work=await Promise.allSettled([offers(),finals(now,packet)]);
        if(work.some(r=>r.status==='rejected'))throw Error('Rally poll partially unavailable');
    }};
}
