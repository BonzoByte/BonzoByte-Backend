import { dayOf } from './rallyCompetitionStatus.js';
import { modelFairOdds, validateCompetitionObservation } from './competitionPolicy.js';

const origin='https://bonzobyte.com/api/', source='rally-model-fair';
const iso=n=>new Date(n).toISOString();
const full=t=>typeof t==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(t) && Number.isFinite(Date.parse(t));
const id=n=>Number.isSafeInteger(n)&&n>0;
const dashed=d=>d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6);
const recent=(t,now)=>full(t)&&Date.parse(t)<=now&&now-Date.parse(t)<36*3600000;
// A scheduled start qualifies on its own. Never label that as an observed live status.
function offer({tp,players,title,start,at,p,issued,day,now}) {
    if(!id(tp)||!full(start)||dayOf(Date.parse(start))!==day||Date.parse(start)<=now||!recent(at,now)||
        !full(issued)||Date.parse(issued)>now||Date.parse(issued)>=Date.parse(start)||!modelFairOdds(p))return null;
    try{return validateCompetitionObservation({schema:'bonzobyte.competition-model-source.v1',oddsKind:'model-fair',
        matchTPId:tp,source,sourceEventId:'TP-schedule:'+tp,tournament:title,status:'scheduled',timePrecision:'minute',
        startAt:iso(Date.parse(start)),statusObservedAt:iso(Date.parse(at)),revision:Math.max(Date.parse(at),Date.parse(issued)),
        players,model:{issuedAt:iso(Date.parse(issued)),version:'rally-public-prematch-v1',p1:p}});}catch{return null;}
}
export function dailyOffers({daily,schedule,grades,results,day,now}) {
    const blocked=new Set(), offers=[];
    if(results && (results.day!==day||results.schema!=='bonzobyte.provisional-results.v1'||!Array.isArray(results.rows)))throw Error('Unexpected results');
    for(const r of results?.rows??[])blocked.add(r[0]);
    if(grades && (grades.day!==day||grades.schema!=='bonzobyte.issued-forecast-grades.v2'||!Array.isArray(grades.rows)))throw Error('Unexpected grades');
    const grade=new Map();for(const r of grades?.rows??[]){grade.set(r[0],r);if(r[9]!=null||r[11]!=null)blocked.add(r[0]);}
    if(daily&&!Array.isArray(daily.matches))throw Error('Unexpected daily grid');
    const slots=new Map();if(schedule?.day===day && schedule.schema==='bonzobyte.planned-match-schedule.v1' && recent(schedule.observedAt,now)){
        for(const s of schedule.slots){if(slots.has(s[0]))throw Error('Duplicate slot');slots.set(s[0],s);}
    }
    for(const m of daily?.matches??[]){
        const tp=m.matchTPId,s=slots.get(tp),g=grade.get(tp);
        if(m.isFinished||m.result||m.resultDetails||['live','finished','retired','walkover','cancelled','suspended','in-progress'].includes(m.status)){
            blocked.add(tp);continue;
        }
        if(m.isFinished!==false||blocked.has(tp)||!s||s[1]!==m.player1TPId||s[2]!==m.player2TPId)continue;
        // The grid gives the first published pick precedence over a later model rerun.
        const bound=g&&g[1]===m.matchId&&g[4]===m.tournamentEventTPId&&
            g.slice(6,9).every(n=>Number.isSafeInteger(n)&&n>0)&&g[6]<=g[7]&&g[7]<=now&&g[8]<=now&&
            ['display','issued'].includes(g[10])&&m.dateTime?.slice(0,10).replaceAll('-','')===day;
        const exact=bound&&g[2]===s[1]&&g[3]===s[2], reversed=bound&&g[2]===s[2]&&g[3]===s[1];
        const p=exact?g[5]:reversed?1-g[5]:m.modelProbabilityPlayer1/100;
        const issued=exact||reversed?iso(g[7]):m.publicForecastIssuedAtUtc;
        const o=offer({tp,players:[{id:s[1],name:m.player1Name},{id:s[2],name:m.player2Name}],title:m.tournamentEventName,
            start:s[3],at:schedule.observedAt,p,issued,day,now});if(o)offers.push(o);
    }
    return {offers,blocked};
}
export function announcedOffers(packet,day,now) {
    if(!packet)return [];
    if(packet.day!==dashed(day)||packet.zone!=='Europe/Zagreb'||!Array.isArray(packet.matches)||packet.matches.length>600)throw Error('Unexpected announced fixtures');
    return packet.matches.flatMap(m=>{
        const g=m.grid;if(!g?.forecast||g.players?.length!==2||m.names?.length!==2||m.result||m.isFinished||m.resultDetails)return [];
        const o=offer({tp:m.id,players:g.players.map((p,i)=>({id:p.id,name:m.names[i]})),title:g.title,start:m.start,
            at:packet.observedAt,p:g.forecast.p,issued:g.forecast.at,day,now});return o?[o]:[];
    });
}
async function get(path){
    const r=await fetch(origin+path,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(r.status===404)return null;
    if(!r.ok||!r.body)throw Error('Rally source unavailable');
    let n=0;const chunks=[];for await(const x of r.body){n+=x.length;if(n>5*1024*1024)throw Error('Rally packet too large');chunks.push(x);}
    return JSON.parse(Buffer.concat(chunks).toString());
}
export async function refreshScheduleOffers(collection,now=Date.now(),read=get) {
    const day=dayOf(now),tomorrow=dayOf(now+86400000),checked=iso(now);
    const today=Promise.all(['archives/daily/','match-schedule/','forecast-grades-v2/','provisional-results/'].map(p=>read(p+day)))
        .then(([daily,schedule,grades,results])=>dailyOffers({daily,schedule,grades,results,day,now}));
    const [a,b]=await Promise.allSettled([today,read('announced-fixtures/'+dashed(tomorrow)).then(p=>announcedOffers(p,tomorrow,now))]);
    const {offers,blocked}=a.status==='fulfilled'?a.value:{offers:[],blocked:new Set()};
    const unique=new Map();for(const o of [...offers,...(b.status==='fulfilled'?b.value:[])]){
        if(unique.has(o.matchTPId))blocked.add(o.matchTPId);else unique.set(o.matchTPId,o);
    }
    for(const tp of blocked)unique.delete(tp);
    const rows=[...unique.values()];
    // Bulk leases only: no fresh provider observation is invented by polling.
    // Match ids are durable, including after midnight. Never replace accepted reads, terminal state or participant identity.
    const existing=await collection.find({$or:[{source,status:'scheduled',firstLockAt:{$gt:checked}},{_id:{$in:[...unique.keys(),...blocked]}}]},
        {projection:{_id:1,source:1,status:1,sourceEventId:1,players:1,firstLockAt:1,rallyStarted:1},maxTimeMS:5000}).toArray();
    const prior=new Map(existing.map(x=>[x._id,x])),ops=[];
    for(const old of existing)if(blocked.has(old._id)||!unique.has(old._id)){
        ops.push({updateOne:{filter:{_id:old._id,source,status:'scheduled'},update:{$set:blocked.has(old._id)?{rallyHeld:true,rallyStarted:true}:{rallyHeld:true}}}});
    }
    for(const row of rows){
        const old=prior.get(row.matchTPId);
        if(old&&(old.source!==source||old.status!=='scheduled'||old.rallyStarted||old.firstLockAt<=checked||old.sourceEventId!==row.sourceEventId||
            old.players.some((p,i)=>p.id!==row.players[i].id)))continue;
        ops.push({updateOne:{filter:{_id:row.matchTPId,source,sourceEventId:row.sourceEventId,status:'scheduled',rallyStarted:{$ne:true},
            'players.0.id':row.players[0].id,'players.1.id':row.players[1].id},
            update:{$set:{...row,scheduleCheckedAt:checked,publishedAt:checked,rallyHeld:false,pendingSettlement:false},
                $min:{firstLockAt:row.startAt}},upsert:!old}});
    }
    if(ops.length)await collection.bulkWrite(ops,{ordered:false});
    return rows.length;
}
