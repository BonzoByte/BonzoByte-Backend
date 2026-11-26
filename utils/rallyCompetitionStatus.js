// Source-side confirmation only. A planned time, empty scoreboard or third-party
// odds are never affirmative evidence. No caller-supplied hosts or identifiers.
import {parse} from 'parse5';
const origin='https://www.tennisexplorer.com';
const all=(n,p,a=[])=>{if(p(n))a.push(n); for(const c of n.childNodes??[])all(c,p,a);return a;};
const attr=(n,k)=>n?.attrs?.find(a=>a.name===k)?.value??'';
const cls=(n,k)=>attr(n,'class').split(/\s+/).includes(k);
const txt=n=>(n?.nodeName==='#text'?n.value:(n?.childNodes??[]).map(txt).join(' ')).replace(/\s+/g,' ').trim();
const norm=s=>String(s).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const dayParts=d=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Prague',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).formatToParts(d).map(p=>[p.type,p.value]));
export const dayOf=d=>{const x=dayParts(d);return x.year+x.month+x.day;};
const one=a=>a.length===1?a[0]:null;
export function detailIdentity(html,id,match,start,observed) {
    const d=parse(html),panels=all(d,n=>cls(n,'boxBasic')&&cls(n,'lGray')&&all(n,c=>cls(c,'game-fblike')).length);
    const panel=one(panels),table=one(all(d,n=>n.tagName==='table'&&cls(n,'gDetail'))),head=table&&one(all(table,n=>n.tagName==='thead'));
    if(!panel||!head)return false;
    const frame=one(all(panel,n=>n.tagName==='iframe'&&cls(n,'game-fblike')));
    const identity=frame&&/match-detail\/\?id=(\d+)(?:&|$)/.exec(decodeURIComponent(attr(frame,'src')));
    if(!identity||Number(identity[1])!==id)return false;
    const names=all(head,n=>n.tagName==='th'&&cls(n,'plName')).map(n=>txt(one(all(n,c=>c.tagName==='a')))).map(norm);
    if(names.length!==2||names[0]!==norm(match.player1Name)||names[1]!==norm(match.player2Name))return false;
    const event=one(all(panel,n=>n.tagName==='a'&&/^\/[\w-]+\/\d{4}\/(atp-men|wta-women)\/$/.test(attr(n,'href'))));
    if(!event||!attr(event,'href').endsWith(match.tournamentTypeName==='WTA'?'/wta-women/':'/atp-men/')||
       !['WTA','ATP'].includes(match.tournamentTypeName)||
       norm(txt(event).replace(/\s+(ATP|WTA)$/i,''))!==norm(match.tournamentEventName.split(' (')[0]))return false;
    const x=dayParts(new Date(start)),z=txt(one(all(d,n=>cls(n,'timezone')))),meta=txt(panel),dt=/\b(Today|Tomorrow|\d{1,2}\.\d{1,2}\.\d{4}),\s*(\d{1,2}):(\d\d),/i.exec(meta);
    if(!dt||z!==x.timeZoneName||+dt[2]!==+x.hour||dt[3]!==x.minute)return false;
    const expectedDay=dt[1].toLowerCase()==='today'?dayOf(observed):dt[1].toLowerCase()==='tomorrow'?dayOf(observed+86400000):
        dt[1].split('.').reverse().map(v=>v.padStart(2,'0')).join('');
    return expectedDay===dayOf(Date.parse(start)) && /\b(?:match (?:has not started|not started|hasn't started)|not played yet)\b/i.test(meta)
        && !/\b(?:live now|in progress|finished|retired|walkover|suspended|cancelled|postponed)\b/i.test(meta)
        && !all(head,n=>cls(n,'gScore')).some(n=>txt(n));
}
// Short names only shortlist detail pages; they cannot authorize a pick.
export function shortlist(html,m) {
    const rows=all(parse(html),n=>n.tagName==='tr'), hits=[];
    const short=(label,full)=>{const v=norm(label),f=norm(full);return v.length>=4&&(f===v||f.startsWith(v));};
    for(let i=0;i+1<rows.length;i++){
        // fRow marks the first match of a tournament; later matches start with
        // bott alone. Never join a player to a row in a different table section.
        const r=rows[i],s=rows[i+1],id=attr(r,'id');
        if(!(cls(r,'fRow')||cls(r,'bott'))||!id||s.parentNode!==r.parentNode||attr(s,'id')!==id+'b')continue;
        const label=row=>txt(one(all(row,n=>n.tagName==='a'&&/^\/player\//.test(attr(n,'href')))));
        const a=label(r),b=label(s);if(!short(a,m.player1Name)||!short(b,m.player2Name))continue;
        const link=one(all(r,n=>n.tagName==='a'&&/^\/match-detail\/\?id=\d+$/.test(attr(n,'href'))));
        if(link)hits.push(Number(attr(link,'href').split('=')[1]));
    }
    return one(hits);
}
async function get(path,limit){
    const r=await fetch(origin+path,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{'User-Agent':'BonzoByte/1.0 (match-status reader)'}});
    if(!r.ok){await r.body?.cancel();throw Error('source unavailable');}
    const stamp=Date.parse(r.headers.get('date')),now=Date.now(),age=Number(r.headers.get('age')||0);
    // HTTP Date is second-resolution. Never credit an upstream clock lead
    // with extra quote life, or reset a cached response's observed age.
    const at=Math.min(stamp,now-age*1000);
    if(!Number.isFinite(at)||stamp>now+3000||age<0||now-at>=120000){await r.body?.cancel();throw Error('stale');}
    let size=0;const parts=[];for await(const part of r.body){size+=part.length;if(size>limit)throw Error('source size');parts.push(part);}
    const html=Buffer.concat(parts).toString();if(/cf-chl-|verify you are human|<title[^>]*>[^<]*(?:access denied|just a moment)/i.test(html))throw Error('source unavailable');
    return {html,at};
}
let robotsUntil=0, index=null;
export async function confirmedTE(match,start,day) {
    const now=Date.now();
    if(now>=robotsUntil){
        const {html}=await get('/robots.txt',200000);
        // Conservative: honor any applicable disallow, even a more restrictive group.
        if(!/user-agent:/i.test(html)||html.split(/\r?\n/).some(l=>{const rule=/^\s*disallow:\s*([^#\s]+)/i.exec(l)?.[1];
            return rule&&(rule.includes('*')||['/match-detail/','/matches/','/next/'].some(p=>p.startsWith(rule)));}))throw Error('source policy');
        robotsUntil=now+3600000;
    }
    if(!index||index.day!==day||now-index.at>300000){
        const endpoint=day===dayOf(now)?'matches':'next';
        index={day,...await get('/'+endpoint+'/?type=all&year='+day.slice(0,4)+'&month='+day.slice(4,6)+'&day='+day.slice(6),2500000)};
    }
    const id=shortlist(index.html,match);if(!id)return null;
    const detail=await get('/match-detail/?id='+id,650000);
    return detailIdentity(detail.html,id,match,start,detail.at)?{id:'TE:'+id,at:detail.at}:null;
}
