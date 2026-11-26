import {privateArchiveRuntime} from './privateArchiveRuntime.js';
import {projectPublicDailyMatch} from './publicDailyMatch.js';
import {overlayPublicPrematchForecasts} from './publicPrematchForecast.js';
import {resolveDetailsSchedule} from './plannedDetailsSchedule.js';
import {confirmedTE,dayOf} from './rallyCompetitionStatus.js';
import {publishCompetitionObservation} from './competitionPublisher.js';

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
export function createRallyCompetitionFeed(collection){
    let next=new Map(),cache=new Map(),serial=0, lastProbe=0;
    const send=input=>publishCompetitionObservation({collection,input,allowedSources:[rallySource]});
    async function dayData(reader,day){
        const key=reader.releaseId+':'+day;let entry=cache.get(key);
        if(entry&&Date.now()-entry.at<300000)return entry;
        const raw=await reader.readJson('daily/'+day+'.br'),rows=raw.map(projectPublicDailyMatch);
        let batch=null;
        try{batch=await reader.readJson('analytics/public-prematch-'+day+'.json',{maxBytes:64*1024});}catch(e){if(e.status!==404)throw e;}
        entry={at:Date.now(),rows:overlayPublicPrematchForecasts(rows,batch,day),batch};cache.set(key,entry);return entry;
    }
    return {connected:()=>Date.now()-lastProbe<120000,async poll(){
        const now=Date.now(),reader=await privateArchiveRuntime.getReader(), days=[dayOf(now),dayOf(now+86400000)];
        for(const [key,item] of cache)if(now-item.at>=300000)cache.delete(key);
        for(const [key,until] of next)if(until<=now)next.delete(key);
        // A pending pick remains settleable after midnight or a process restart.
        const outstanding=await collection.find({source:rallySource,status:'scheduled',acceptedReads:{$gt:0},startAt:{$lte:iso(now)}},{maxTimeMS:3500}).sort({startAt:-1}).limit(150).toArray();
        for(const old of outstanding){
            const day=dayOf(Date.parse(old.startAt)),data=await dayData(reader,day).catch(()=>null);
            const row=data?.rows.find(m=>m.matchTPId===old.matchTPId), result=completedInput(old,row,Date.now());
            if(result)await send(result);
        }
        let upcoming=[];
        for(const day of days){
            const data=await dayData(reader,day).catch(()=>null);
            for(const m of data?.rows??[]){if(!m.publicForecastIssuedAtUtc||next.has(m.matchTPId))continue;
                const b=data.batch.rows.find(x=>x.matchTPId===m.matchTPId);
                if(Date.parse(b.earliestScheduledStartUtc)>now+300000)upcoming.push({m,b,day});}
        }
        if(!upcoming.length)return;
        let ix=serial++%upcoming.length;
        for(let j=0;j<Math.min(4,upcoming.length);j++){
            const {m,b,day}=upcoming[(ix+j)%upcoming.length];
            const slot=await resolveDetailsSchedule({located:{tp:m.matchTPId,day},match:{m001:m.matchTPId,m004:m.player1TPId,m005:m.player2TPId},now:new Date()});
            let confirmed=null;
            if(Date.parse(slot.plannedStartUtc)===Date.parse(b.earliestScheduledStartUtc)){
                try{confirmed=await confirmedTE(m,slot.plannedStartUtc,day);}catch{ /* stale or unavailable: never open */ }
            }
            const input=scheduledInput(m,b,slot.plannedStartUtc,confirmed,Date.now());
            if(input){await send(input);lastProbe=Date.now();}
            else{
                await collection.updateOne({_id:m.matchTPId,source:rallySource,status:'scheduled'},{$set:{rallyHeld:true}},{maxTimeMS:3500});
                next.set(m.matchTPId,Date.now()+300000);
            }
            if(j+1<Math.min(4,upcoming.length))await new Promise(r=>setTimeout(r,2500));
        }
    }};
}
