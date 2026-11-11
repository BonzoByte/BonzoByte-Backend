import { createHash } from 'node:crypto';
import { testAccountEnvironmentAllowed, SOCIAL_TEST_SEED } from './developmentTestAccounts.js';
import { COMPETITION_RULES, competitionError, competitionSummary, settleCompetitionPick } from './competitionPolicy.js';
import { createPopularity, DAY_MS, HALF_LIFE_DAYS, WINDOW_DAYS } from './popularity.js';

export const ACTIVITY_SEED = 'real-match-activity-v1';
export const ACTIVITY_ENV = 'development-fixtures';
export const ACTIVITY_COLLECTION = 'developmentactivity';
export function realActivityAllowed(settings = process.env, database = 'test') {
    return settings.BONZOBYTE_TEST_ACTIVITY === ACTIVITY_SEED && database === 'test' && testAccountEnvironmentAllowed(settings);
}
export function assertRealActivityMode(settings = process.env, database = 'test') {
    if (settings.BONZOBYTE_TEST_ACTIVITY && !realActivityAllowed(settings, database))
        throw new Error('Retrospective test activity requires the isolated local development configuration.');
}
const rand = key => createHash('sha256').update(ACTIVITY_SEED + ':' + key).digest().readUInt32BE(0) / 4294967296;
export const activityMetadata = manifest => ({ seed: ACTIVITY_SEED, retrospective: true,
    preferredMonth: manifest.preferredMonth, generatedAt: manifest.generatedAt });

/** Retrospective test choices. Never observations of a real pre-match submission. */
export function realActivityPlan(users, cards, now = new Date()) {
    if (users.filter(u => u.testAccount?.seedId === SOCIAL_TEST_SEED).length !== 20 || users.length !== 22)
        throw new Error('Twenty marked fixtures and exactly two approved local accounts required.');
    if (new Set(users.map(u => String(u._id))).size !== 22 || users.some(u => !u.isVerified || u.isAdmin || u.accountClosure?.requestedAt))
        throw new Error('Invalid activity participants.');
    const indices=users.filter(u=>u.testAccount?.seedId===SOCIAL_TEST_SEED).map(u=>u.testAccount.index);
    if(new Set(indices).size!==20||indices.some(i=>!Number.isInteger(i)||i<1||i>20))throw new Error('Invalid fixture account indices.');
    const valid = cards.filter(m => m.isFinished === true && m.qualityStatus === 'Validated'
        && /^[1-9]\d*$/.test(String(m.matchTPId)) && m.player1TPId > 0 && m.player2TPId > 0 && m.player1TPId !== m.player2TPId
        && /^\d[:\-]?\d$/.test(m.result || '') && [m.player1Odds ?? m.legacyPlayer1Odds,m.player2Odds ?? m.legacyPlayer2Odds].every(o=>typeof o === 'number' && o>1 && o<=1000));
    const byDay = new Map();
    for (const m of valid) { const day=m.dateTime?.slice(0,10); if (!/^20\d\d-\d\d-\d\d$/.test(day||'')) continue;
        if (!byDay.has(day)) byDay.set(day,[]); if (!byDay.get(day).some(x=>x.matchTPId===m.matchTPId)) byDay.get(day).push(m); }
    const days=[...byDay.keys()].sort(); if(days.length<6)throw new Error('At least six real archive days with odds required.');
    const selected=days.flatMap(day=>byDay.get(day).sort((a,b)=>rand(a.matchTPId)-rand(b.matchTPId)).slice(0,5));
    if(selected.length<30)throw new Error('Thirty distinct eligible real matches required.');
    const rows=[];
    for(const user of users){const test=user.testAccount?.seedId===SOCIAL_TEST_SEED;const index=test?user.testAccount.index:21+users.filter(u=>!u.testAccount).findIndex(u=>String(u._id)===String(user._id));
        const count=test?(index>16?22:Math.min(selected.length,30+index%11)):20;
        const choices=[...selected].sort((a,b)=>rand(index+':'+a.matchTPId)-rand(index+':'+b.matchTPId)).slice(0,count);
        for(const m of choices){const startAt=new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(m.dateTime)?m.dateTime:m.dateTime+'Z').toISOString();
            const submittedAt=new Date(Date.parse(startAt.slice(0,10)+'T00:00:00Z')-3600000).toISOString();const pair=m.result.replace(/\D/g,'');const winner=Number(pair[0])>Number(pair[1])?0:1;
            const odds=[m.player1Odds??m.legacyPlayer1Odds,m.player2Odds??m.legacyPlayer2Odds];
            const players=[1,2].map(side=>({id:m['player'+side+'TPId'],name:m['player'+side+'Name'],countryISO2:m['player'+side+'CountryISO2'],countryISO3:m['player'+side+'CountryISO3'],countryFull:m['player'+side+'CountryFull'],rank:String(m['player'+side+'Rank']||''),seed:m['player'+side+'Seed']}));
            const snapshot={matchTPId:m.matchTPId,tournament:m.tournamentEventName,startAt,lockAt:new Date(Date.parse(startAt)-300000).toISOString(),players,odds,bookmakers:Math.max(1,m.marketBookieCount||1),model:null};
            const pick={environment:ACTIVITY_ENV,userId:user._id,matchTPId:m.matchTPId,day:submittedAt.slice(0,10),month:submittedAt.slice(0,7),submittedAt,side:rand(index+':'+m.matchTPId+':side')<.5?0:1,stake:1,rulesVersion:COMPETITION_RULES.version,snapshot,settlementHistory:[],fixture:{seedId:ACTIVITY_SEED,retrospective:true,generatedAt:now.toISOString(),sourceTimePrecision:m.sourceTimePrecision??'unknown'}};
            // Only the known final result and archived price are used. No model comparison is invented.
            const result={schema:'bonzobyte.competition-source.v1',matchTPId:m.matchTPId,revision:1,source:ACTIVITY_SEED,sourceEventId:String(m.matchTPId),tournament:m.tournamentEventName,startAt,timePrecision:'second',status:'finished',statusObservedAt:now.toISOString(),oddsObservedAt:now.toISOString(),players,odds,oddsKind:'median',bookmakers:snapshot.bookmakers,model:null,resultVerified:true,winner};
            pick.settlement=settleCompetitionPick(pick,result,now);if(!pick.settlement)throw new Error('Fixture settlement failed.');rows.push(pick);
        }
    }
    const buckets=[];const seenPlayers=new Map();
    for(const m of selected)for(const side of[1,2]){const id=m['player'+side+'TPId'];if(!seenPlayers.has(id))seenPlayers.set(id,{id,name:m['player'+side+'Name'],country:m['player'+side+'CountryFull'],gender:m.tournamentTypeName==='WTA'?'W':'M',index:{playerTPId:id,playerName:m['player'+side+'Name'],countryISO2:m['player'+side+'CountryISO2'],countryISO3:m['player'+side+'CountryISO3'],countryFull:m['player'+side+'CountryFull']}});}
    for(let age=0;age<WINDOW_DAYS;age++)for(const kind of['match','player'])for(const id of kind==='match'?selected.map(m=>m.matchTPId):[...seenPlayers.keys()]){
        const count=Math.floor(rand(kind+':'+id+':'+age)*21);if(count)buckets.push({kind,entityId:id,day:new Date(+now-age*DAY_MS).toISOString().slice(0,10),count});}
    const months=[...new Set(rows.map(r=>r.month))].sort();
    return {rows,manifest:{_id:ACTIVITY_SEED,version:1,generatedAt:now.toISOString(),preferredMonth:months.at(-1),months,cards:selected,players:[...seenPlayers.values()],buckets}};
}

export function withRealActivity({normal,fixtures,readManifest,allowed=()=>realActivityAllowed()}) {
    const get=async()=>allowed()?await readManifest():null;
    const decorate=(result,manifest)=>({...result,testActivity:activityMetadata(manifest),entries:result.entries?.map(p=>{
        const m=manifest.cards.find(m=>m.matchTPId===p.matchTPId&&m.player1TPId===p.snapshot.players[0].id&&m.player2TPId===p.snapshot.players[1].id);
        return {...p,...(m?{displayMatch:m}:{})};})});
    return {...normal,
        async rules(){const result=await normal.rules();const m=await get();return m?{...result,demo:null,testActivity:activityMetadata(m)}:result;},
        async leaderboard(month,demo=false){const m=await get();return m?decorate(await fixtures.leaderboard(month),m):normal.leaderboard(month,demo);},
        async me(actor,month,demo=false){const m=await get();return m?decorate(await fixtures.me(actor,month),m):normal.me(actor,month,demo);},
        async publicPicks(id,month,demo=false){const m=await get();if(id.startsWith('test-user-')){if(!m)throw competitionError('COMPETITION_PROFILE_UNAVAILABLE',404);return decorate(await fixtures.publicPicks(id,month),m);}return normal.publicPicks(id,month,demo);}
    };
}
export function withRealPopularity({normal,readManifest,allowed=()=>realActivityAllowed(),now=()=>new Date()}){
    return {...normal,async rankings(){if(!allowed())return normal.rankings();const m=await readManifest();if(!m)return normal.rankings();
        const store={async *ranked(kind,day){const scores=new Map();for(const b of m.buckets){const age=(+day-Date.parse(b.day))/DAY_MS;if(b.kind===kind&&age>=0&&age<WINDOW_DAYS)scores.set(b.entityId,(scores.get(b.entityId)||0)+b.count*Math.pow(.5,age/HALF_LIFE_DAYS));}
            for(const[entityId]of[...scores].sort((a,b)=>b[1]-a[1]||a[0]-b[0]))yield{entityId};}};
        const ranking=createPopularity({store,environment:ACTIVITY_ENV,now,resolveEntity:async(kind,id)=>{if(kind==='player')return m.players.find(p=>p.id===id)||null;const card=m.cards.find(c=>c.matchTPId===id);return card?{id,player1:card.player1Name,player2:card.player2Name,tournament:card.tournamentEventName,date:card.dateTime.slice(0,10),match:card}:null;}});
        return {...await ranking.rankings(),testActivity:activityMetadata(m)};
    }};
}
