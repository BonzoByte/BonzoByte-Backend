// Settlement-only evidence. The packet time versions the publication, not an
// individual TP row, a live heartbeat, an issued price or a pre-match quote.
const fmt=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Zagreb',year:'numeric',month:'2-digit',day:'2-digit'});
export const zagrebDay=ms=>fmt.format(ms).replaceAll('-','');
const ordinal=d=>Date.UTC(+d.slice(0,4),+d.slice(4,6)-1,+d.slice(6,8))/86400000;
export function recentDay(day,now){
    const age=ordinal(zagrebDay(now))-ordinal(day);
    return age>=0&&age<=2;
}
const id=n=>Number.isSafeInteger(n)&&n>0;
const empty=value=>value==null||value==='';
const utc=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s)&&
    Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,19)===s.slice(0,19)?Date.parse(s):NaN;
export function accepted(old){
    return old?.source==='rally-model-fair'&&old.schema==='bonzobyte.competition-model-source.v1'&&old.oddsKind==='model-fair'&&
        Array.isArray(old.odds)&&old.odds.length===2&&old.odds.every(n=>Number.isFinite(n)&&n>1)&&
        utc(old.model?.issuedAt)<utc(old.startAt)&&
        old.status==='scheduled'&&id(old.acceptedReads)&&id(old.revision)&&id(old.matchTPId)&&old._id===old.matchTPId&&
        !old.pendingSettlement&&!old.resultVerified&&old.winner==null&&Number.isFinite(utc(old.startAt))&&
        Array.isArray(old.players)&&old.players.length===2&&old.players.every(p=>id(p?.id))&&old.players[0].id!==old.players[1].id;
}
function matchesArchive(old,m,day){
    return m?.matchTPId===old.matchTPId&&typeof m.dateTime==='string'&&m.dateTime.split('T')[0]===day.slice(0,4)+'-'+day.slice(4,6)+'-'+day.slice(6)&&
        typeof old.tournament==='string'&&old.tournament.length>0&&m.tournamentEventName===old.tournament&&
        (old.matchId==null||old.matchId===m.matchId)&&(old.tournamentEventTPId==null||old.tournamentEventTPId===m.tournamentEventTPId);
}
export function archiveMatch(old,rows,day){
    const hits=rows.filter(m=>m?.matchTPId===old.matchTPId);
    if(hits.length!==1)return null;
    const [m]=hits;
    return matchesArchive(old,m,day)&&(m.matchId==null||rows.filter(r=>r?.matchId===m.matchId).length===1)?m:null;
}
export function ordinaryWinner(summary,details){
    if(typeof summary!=='string'||!/^(?:2:[01]|[01]:2|3:[012]|[012]:3)$/.test(summary)||
        typeof details!=='string'||details.length>80)return null;
    const final=summary.split(':').map(Number),target=Math.max(...final),wins=[0,0],sets=details.split(' ');
    if(sets.length!==final[0]+final[1])return null;
    for(const set of sets){
        const s=/^([0-7]):([0-7])(?:\((0|[1-9]\d?)\))?$/.exec(set);
        if(!s||wins.includes(target))return null;
        const a=+s[1],b=+s[2],hi=Math.max(a,b),lo=Math.min(a,b);
        if(!(hi===6&&lo<=4||hi===7&&(lo===5||lo===6))||(s[3]!=null&&lo!==6))return null;
        wins[a>b?0:1]++;
    }
    return wins.every((w,i)=>w===final[i])?(wins[0]===target?0:1):null;
}
export function provisionalFinal(old,m,packet,now){
    if(!accepted(old)||!m)return null;
    // The native canonical path does not depend on a TP event-key convention.
    if(old.sourceEventId!=='TP-schedule:'+old.matchTPId&&old.sourceEventId!=='TP:'+old.matchTPId&&
        !/^TE:[1-9]\d*$/.test(old.sourceEventId))return null;
    const start=utc(old.startAt),day=zagrebDay(start),at=utc(packet?.observedAt);
    if(!matchesArchive(old,m,day)||!recentDay(day,now)||packet?.day!==day||packet.schema!=='bonzobyte.provisional-results.v1'||
        !Array.isArray(packet.rows)||packet.rows.length>600||!Number.isFinite(at)||at<start||at>now||at<=old.revision||
        !(at>=utc(old.statusObservedAt))||m.isFinished!==false||!empty(m.result)||!empty(m.resultDetails)||
        (m.status!=null&&!['scheduled','pending'].includes(m.status))||(m.qualityStatus!=null&&m.qualityStatus!=='NotAssessed')||
        !id(m.matchId)||!id(m.tournamentEventTPId)||old.players[0].id!==m.player1TPId||old.players[1].id!==m.player2TPId)return null;
    const hits=packet.rows.filter(r=>Array.isArray(r)&&(r[0]===old.matchTPId||r[1]===m.matchId));
    if(hits.length!==1)return null;
    const [r]=hits;
    if(r.length!==7||r[0]!==m.matchTPId||r[1]!==m.matchId||r[2]!==m.player1TPId||r[3]!==m.player2TPId||r[4]!==m.tournamentEventTPId)return null;
    const winner=ordinaryWinner(r[5],r[6]);
    return winner===null?null:{...old,status:'finished',winner,resultVerified:true,revision:at,statusObservedAt:packet.observedAt};
}
export async function readRallyPacket(route){
    const result=/^provisional-results\/20\d{6}$/.test(route);
    if(!result&&!/^(?:(?:archives\/daily|match-schedule|forecast-grades-v2)\/20\d{6}|announced-fixtures\/20\d\d-\d\d-\d\d)$/.test(route))
        throw Error('Unexpected Rally route');
    const response=await fetch('https://bonzobyte.com/api/'+route,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(response.status===404){await response.body?.cancel();return null;}
    if(response.status!==200||!response.body||!/^application\/json\b/i.test(response.headers.get('content-type')??'')){
        await response.body?.cancel();throw Error('Rally packet unavailable');
    }
    const parts=[],limit=result?96*1024:5*1024*1024;let n=0;
    for await(const part of response.body){
        n+=part.byteLength;if(n>limit)throw Error('Rally packet too large');parts.push(part);
    }
    return JSON.parse(Buffer.concat(parts,n));
}
