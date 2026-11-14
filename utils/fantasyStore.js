import { randomUUID } from 'node:crypto';
import { buildSeason, FANTASY_COLLECTIONS, FANTASY_RULES, RULES_SHA, need, sha, planTeam, teamView,
    prepareFixture, resultUpdate, settleTeam, utcDay, lineupForDay } from './fantasyPolicy.js';

export function createFantasyStore({connection,User,environment,now=()=>new Date(),names=FANTASY_COLLECTIONS,grantPremium}) {
    need(['development','production','test'].includes(environment),'INVALID_ENVIRONMENT');
    // Collection-scoped timeout (not an operation override): driver 6.15 inherits
    // it when constructing a cursor, so getMore omits the forbidden maxTimeMS.
    // withTransaction rejects per-operation timeoutMS; its own 10s deadline stays.
    // Read cursors get a collection deadline; transactional collections must not
    // inherit it, because the session already owns the transaction deadline.
    const c=(key,session)=>connection.db.collection(names[key],session?{}:{timeoutMS:5000}),query=extra=>({environment,...extra});
    const opts=session=>({maxTimeMS:5000,...(session?{session}:{})});
    const cursorOpts=session=>session?{session}:{};
    const tx=fn=>connection.transaction(fn,{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},maxCommitTimeMS:3000,timeoutMS:10000});
    async function actorAllowed(actor,session,write=false) {
        need(actor?.user&&Number.isInteger(actor.tokenVersion),'AUTH_REQUIRED',401);
        const version=actor.tokenVersion===0?{$or:[{tokenVersion:0},{tokenVersion:null}]}:{tokenVersion:actor.tokenVersion};
        const q={_id:actor.user,...version,'accountClosure.requestedAt':{$exists:false}};
        if(write) {
            need(actor.operation?.id&&actor.operation.tokenVersion===actor.tokenVersion,'AUTH_REQUIRED',401);
            q.isVerified=true;q.accountOperations={$elemMatch:{id:actor.operation.id,expiresAt:{$gt:now()}}};
            need((await User.collection.updateOne(q,{$inc:{'accountOperations.$.fantasyWrites':1}},opts(session))).matchedCount,'AUTH_REQUIRED',401);
        } else need(await User.collection.findOne(q,{...opts(session),projection:{_id:1}}),'AUTH_REQUIRED',401);
    }
    const season=async(month,session)=>c('fantasySeasons',session).findOne(query({month}),opts(session));
    const catalogue=async(month,session)=>c('fantasyPlayers',session).find(query({month}),cursorOpts(session)).sort({playerId:1}).limit(20001).toArray();
    async function lockSeason(s,session) {
        need(s&&s.status==='open'&&s.rulesSha===RULES_SHA,'SEASON_CLOSED',409);
        need((await c('fantasySeasons',session).updateOne(query({month:s.month,status:'open',rulesSha:RULES_SHA}),{$inc:{writeSerial:1}},opts(session))).matchedCount,'SEASON_CLOSED',409);
    }
    return {
        async initialize() {
            const hello=await connection.db.admin().command({hello:1});need(hello.setName||hello.msg==='isdbgrid','TRANSACTIONS_REQUIRED',503);
            const indexes=[['fantasySeasons',{environment:1,month:1},true],['fantasyPlayers',{environment:1,month:1,playerId:1},true],
                ['fantasyPlayers',{environment:1,month:1,tour:1,price:-1},false],['fantasyTeams',{environment:1,month:1,userId:1},true],
                ['fantasyTeams',{environment:1,month:1,publicId:1},true],['fantasyTeams',{environment:1,month:1,'lineups.players':1},false],
                ['fantasyFixtures',{environment:1,month:1,matchId:1},true],['fantasyFixtures',{environment:1,pendingSettlement:1,matchId:1},false],
                ['fantasyLedger',{environment:1,month:1,teamId:1,fixtureId:1},true],['fantasyLedger',{environment:1,userId:1,month:1},false],
                ['fantasyAwards',{environment:1,month:1,userId:1},true]];
            for(const [key,keys,unique] of indexes)await c(key).createIndex(keys,{unique,maxTimeMS:30000});
        },
        async status(month) {
            const rows=await c('fantasySeasons').find(query({}),cursorOpts()).sort({month:-1}).limit(24).toArray();rows.reverse();
            const selected=month?await season(month):rows.find(s=>s.month>=utcDay(now()).slice(0,7))??rows.at(-1)??null;
            return {rules:FANTASY_RULES,months:rows.map(s=>s.month),season:selected?{
                month:selected.month,start:selected.start,end:selected.end,status:selected.status,catalogueSha:selected.catalogueSha,
                sourceAsOf:selected.sourceAsOf,rulesSha:selected.rulesSha,rewardDays:30,rewardsEnabled:selected.rewardsEnabled,
                catalogueCoverage:selected.catalogueCoverage??'reviewed-main-tour',
                finalReviewRequired:true}:null,serverTime:now().toISOString()};
        },
        async players(month,{tour,q='',page=0}={}) {
            const s=await season(month);need(s,'SEASON_UNAVAILABLE',404);
            const filter=query({month,...(tour?{tour}:{})});
            if(q)filter.name={$regex:q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),$options:'i'};
            const total=await c('fantasyPlayers').countDocuments(filter,opts());
            const items=await c('fantasyPlayers').find(filter,{...cursorOpts(),projection:{_id:0,environment:0,month:0}})
                .sort({price:-1,playerId:1}).skip(page*40).limit(40).toArray();
            return {items,total,page,pageSize:40,catalogueSha:s.catalogueSha};
        },
        async mine(actor,month) {
            await actorAllowed(actor);
            const s=await season(month);need(s,'SEASON_UNAVAILABLE',404);
            const team=await c('fantasyTeams').findOne(query({month,userId:actor.user}),opts());
            const ledger=team?await c('fantasyLedger').find(query({month,teamId:team.publicId}),cursorOpts()).sort({day:-1,fixtureId:-1}).limit(1001).toArray():[];
            need(ledger.length<=1000,'LEDGER_LIMIT',503);
            const players=team?(await catalogue(month)).filter(p=>team.lineups.some(r=>r.players.includes(p.playerId))):[];
            const total=ledger.reduce((sum,r)=>sum+r.pointsMinor,0);
            await actorAllowed(actor);
            const visible=ledger.filter(r=>r.entries.length);
            return {team:teamView(team,s,players,now()),players:players.map(({_id,environment,month,...p})=>p),
                pointsMinor:total,results:visible.slice(0,100).map(({_id,userId,environment,month,teamId,...r})=>r),
                resultCount:visible.length,provisional:s.status!=='final',serverTime:now().toISOString()};
        },
        async saveTeam(actor,month,body) {
            return tx(async session=>{
                await actorAllowed(actor,session,true);const s=await season(month,session);await lockSeason(s,session);
                const old=await c('fantasyTeams',session).findOne(query({month,userId:actor.user}),opts(session));
                const players=await catalogue(month,session),planned=planTeam(old,s,players,body,now());
                const entry={...planned,environment,month,userId:actor.user,publicId:old?.publicId??randomUUID()};
                if(old)need((await c('fantasyTeams',session).replaceOne(query({_id:old._id,revision:old.revision}),{...entry,_id:old._id},opts(session))).matchedCount,'TEAM_CHANGED',409);
                else await c('fantasyTeams',session).insertOne(entry,opts(session));
                return {team:teamView(entry,s,players,now())};
            });
        },
        async publicTeam(month,publicId) {
            const s=await season(month);need(s,'SEASON_UNAVAILABLE',404);
            const team=await c('fantasyTeams').findOne(query({month,publicId}),opts());need(team,'TEAM_UNAVAILABLE',404);
            const member=await User.collection.findOne({_id:team.userId,isVerified:true,'accountClosure.requestedAt':{$exists:false},
                ...(environment==='production'?{testAccount:{$exists:false}}:{})},{...opts(),projection:{nickname:1}});
            need(member,'TEAM_UNAVAILABLE',404);
            const ids=lineupForDay(team,utcDay(now()));
            const players=(await catalogue(month)).filter(p=>ids.includes(p.playerId)).map(({_id,environment,month,...p})=>p);
            return {id:publicId,name:team.name,nickname:member.nickname||'Player',players,qualified:team.qualified};
        },
        async board(month) {
            const s=await season(month);need(s,'SEASON_UNAVAILABLE',404);
            const loadGroup=qualified=>c('fantasyTeams').aggregate([
                {$match:query({month,qualified})},
                {$lookup:{from:names.fantasyLedger,let:{team:'$publicId'},pipeline:[{$match:query({month,$expr:{$eq:['$teamId','$$team']}})},
                    {$group:{_id:null,pointsMinor:{$sum:'$pointsMinor'},matches:{$sum:{$cond:[{$gt:[{$size:'$entries'},0]},1,0]}}}}],as:'score'}},
                {$lookup:{from:User.collection.collectionName||User.collection.name||'users',localField:'userId',foreignField:'_id',
                    pipeline:[{$match:{isVerified:true,'accountClosure.requestedAt':{$exists:false}}},{$project:{nickname:1,testAccount:1}}],as:'member'}},
                {$unwind:'$member'},
                ...(environment==='production'?[{$match:{'member.testAccount':{$exists:false}}}]:[]),
                {$project:{_id:0,id:'$publicId',name:1,qualified:1,nickname:{$ifNull:['$member.nickname','Player']},
                    pointsMinor:{$ifNull:[{$arrayElemAt:['$score.pointsMinor',0]},0]},matches:{$ifNull:[{$arrayElemAt:['$score.matches',0]},0]}}},
                {$sort:{pointsMinor:-1,id:1}},{$limit:200}],{...cursorOpts(),allowDiskUse:false}).toArray();
            const qualified=await loadGroup(true),provisional=await loadGroup(false);
            const rank=items=>{let previous,position=0;return items.map((r,i)=>{if(r.pointsMinor!==previous)position=i+1;previous=r.pointsMinor;return {...r,rank:position};});};
            return {qualified:rank(qualified),provisional:rank(provisional),rewardDays:30,
                rewardsEnabled:s.rewardsEnabled,reviewRequired:true,final:s.status==='final'};
        },
        async publishSeason(input) {
            const built=buildSeason(input,now());
            return tx(async session=>{
                const old=await season(input.month,session);
                if(old){need(old.catalogueSha===built.season.catalogueSha&&old.sourceSha===built.season.sourceSha&&old.rulesSha===RULES_SHA
                    &&old.rewardsEnabled===built.season.rewardsEnabled&&(old.catalogueCoverage??'reviewed-main-tour')===built.season.catalogueCoverage,
                    'SEASON_ALREADY_FROZEN',409);return {created:false,players:built.players.length};}
                await c('fantasySeasons',session).insertOne({...built.season,environment},opts(session));
                await c('fantasyPlayers',session).insertMany(built.players.map(p=>({...p,environment,month:input.month})),opts(session));
                return {created:true,players:built.players.length,catalogueSha:built.season.catalogueSha};
            });
        },
        async publishFixture(month,input) {
            return tx(async session=>{
                const s=await season(month,session);need(s,'SEASON_UNAVAILABLE',404);
                const old=await c('fantasyFixtures',session).findOne(query({month,matchId:input.matchId}),opts(session));
                if(old){const repeated=prepareFixture(input,s,new Date(old.capturedAt));need(old.snapshotSha===repeated.snapshotSha,'FIXTURE_ALREADY_FROZEN',409);return {created:false,snapshotSha:old.snapshotSha};}
                await lockSeason(s,session);
                const fixture=prepareFixture(input,s,now());
                const known=(await catalogue(month,session)).filter(p=>[fixture.player1Id,fixture.player2Id].includes(p.playerId));
                need(known.length===2&&known.every(p=>p.tour===fixture.tour),'PLAYER_TOUR_MISMATCH');
                await c('fantasyFixtures',session).insertOne({...fixture,environment,month},opts(session));
                return {created:true,snapshotSha:fixture.snapshotSha};
            });
        },
        async publishResult(month,input) {
            return tx(async session=>{
                const s=await season(month,session);await lockSeason(s,session);
                const old=await c('fantasyFixtures',session).findOne(query({month,matchId:input.matchId}),opts(session));need(old,'FIXTURE_UNAVAILABLE',404);
                if(old.revision===input.revision){const repeated=resultUpdate({...old,revision:old.revision-1},input,now());
                    need(old.resultSourceSha===repeated.resultSourceSha&&old.status===repeated.status&&old.winnerId===repeated.winnerId&&old.result===repeated.result&&old.voidReason===repeated.voidReason,'RESULT_CHANGED',409);return {changed:false};}
                const update=resultUpdate(old,input,now());
                need((await c('fantasyFixtures',session).updateOne(query({_id:old._id,revision:old.revision}),{$set:update},opts(session))).matchedCount,'RESULT_CHANGED',409);
                return {changed:true};
            });
        },
        async reconcile(limit=50,month) {
            need(Number.isInteger(limit)&&limit>=1&&limit<=200,'INVALID_LIMIT');
            const pending=query({...(month?{month}:{}),pendingSettlement:true});
            const fixture=await c('fantasyFixtures').findOne(pending,opts());if(!fixture)return {processed:0,remaining:false};
            const teams=await c('fantasyTeams').find(query({month:fixture.month,'lineups.players':{$in:[fixture.player1Id,fixture.player2Id]}}),cursorOpts()).sort({_id:1}).limit(10000).toArray();
            need(teams.length<10000,'RECONCILIATION_BATCH_REQUIRED',503);
            let processed=0;
            for(const candidate of teams){
                if(processed>=limit)break;
                const old=await c('fantasyLedger').findOne(query({month:fixture.month,teamId:candidate.publicId,fixtureId:fixture.matchId}),opts());
                if(old?.sourceRevision===fixture.revision)continue;
                await tx(async session=>{
                    const s=await season(fixture.month,session);await lockSeason(s,session);
                    const fresh=await c('fantasyFixtures',session).findOne(query({_id:fixture._id,revision:fixture.revision}),opts(session));need(fresh,'RESULT_CHANGED',409);
                    const team=await c('fantasyTeams',session).findOne(query({_id:candidate._id}),opts(session));if(!team)return;
                    const user=await User.collection.findOne({_id:team.userId,'accountClosure.requestedAt':{$exists:false}},{...opts(session),projection:{_id:1}});if(!user)return;
                    const settled=settleTeam(team,fresh);
                    const key=query({month:fixture.month,teamId:team.publicId,fixtureId:fixture.matchId});
                    const previous=await c('fantasyLedger',session).findOne(key,opts(session));
                    const row={...key,...settled,userId:team.userId,updatedAt:now().toISOString(),
                        corrections:[...(previous?.corrections||[]),...(previous&&previous.sourceRevision!==fresh.revision?[{revision:previous.sourceRevision,pointsMinor:previous.pointsMinor}]:[])].slice(-20)};
                    await c('fantasyLedger',session).replaceOne(key,row,{...opts(session),upsert:true});
                    // Serialize scoring against account erasure, not merely a read snapshot.
                    need((await User.collection.updateOne({_id:team.userId,'accountClosure.requestedAt':{$exists:false}},{$inc:{fantasySettlementSerial:1}},opts(session))).matchedCount,'AUTH_REQUIRED',401);
                });processed++;
            }
            const settledCount=await c('fantasyLedger').countDocuments(query({month:fixture.month,fixtureId:fixture.matchId,sourceRevision:fixture.revision}),opts());
            if(settledCount>=teams.length)await c('fantasyFixtures').updateOne(query({_id:fixture._id,revision:fixture.revision}),{$set:{pendingSettlement:false}},opts());
            return {processed,remaining:!!await c('fantasyFixtures').findOne(pending,opts())};
        },
        async finalize(month,reviewer) {
            need(typeof reviewer==='string'&&reviewer.trim().length>=3,'REVIEWER_REQUIRED');
            return tx(async session=>{
                const s=await season(month,session);await lockSeason(s,session);
                need(now().getTime()>=Date.parse(s.end)+72*3600000,'REVIEW_TOO_EARLY',409);
                need(!await c('fantasyFixtures',session).findOne(query({month,$or:[{status:'pending'},{pendingSettlement:true}]}),opts(session)),'RESULTS_PENDING',409);
                const teams=await c('fantasyTeams',session).find(query({month,qualified:true}),cursorOpts(session)).limit(5001).toArray();need(teams.length<=5000,'REVIEW_BATCH_REQUIRED',503);
                const scored=[];
                for(const team of teams){
                    const member=await User.collection.findOne({_id:team.userId,isVerified:true,'accountClosure.requestedAt':{$exists:false},...(environment==='production'?{testAccount:{$exists:false}}:{})},opts(session));if(!member)continue;
                    const rows=await c('fantasyLedger',session).find(query({month,teamId:team.publicId}),cursorOpts(session)).limit(1001).toArray();
                    need(rows.length<=1000,'LEDGER_LIMIT',503);
                    if(rows.some(r=>r.status==='finished'&&r.entries.length))scored.push({teamId:team.publicId,userId:team.userId,pointsMinor:rows.reduce((sum,r)=>sum+r.pointsMinor,0)});
                }
                const maximum=Math.max(...scored.map(r=>r.pointsMinor));
                const winners=scored.filter(r=>r.pointsMinor===maximum),reviewSha=sha(scored.sort((a,b)=>a.teamId.localeCompare(b.teamId)));
                if(s.rewardsEnabled)for(const winner of winners)await c('fantasyAwards',session).updateOne(query({month,userId:winner.userId}),{$setOnInsert:{...winner,environment,month,
                    rewardDays:30,status:'reviewed',reviewSha,reviewer,reviewedAt:now().toISOString()}},{...opts(session),upsert:true});
                await c('fantasySeasons',session).updateOne(query({_id:s._id,status:'open'}),{$set:{status:'final',reviewer,reviewSha,finalizedAt:now().toISOString()}},opts(session));
                return {winners:winners.length,awardsCreated:s.rewardsEnabled,reviewSha};
            });
        },
        async grantAward(month,teamId,reviewer,recipientId) {
            need(typeof grantPremium==='function','REWARD_FULFILMENT_UNAVAILABLE',503);
            return tx(async session=>{
                const s=await season(month,session);need(s?.status==='final'&&s.rewardsEnabled,'AWARD_NOT_REVIEWED',409);
                const award=await c('fantasyAwards',session).findOne(query({month,teamId}),opts(session));need(award&&award.reviewSha===s.reviewSha,'AWARD_NOT_REVIEWED',409);
                if(award.status==='granted')return {granted:false,rewardDays:30};
                need(award.status==='reviewed'&&typeof reviewer==='string'&&reviewer.trim().length>=3,'AWARD_NOT_REVIEWED',409);
                if(recipientId){
                    const winner=await User.collection.findOne({_id:award.userId},opts(session));
                    need(winner&&(winner.vip?.enabled===true||(winner.subscription?.status==='active'&&winner.subscription?.isLifetime===true))&&String(recipientId)!==String(award.userId),'GIFT_NOT_AVAILABLE',409);
                }
                const receipt=await grantPremium({userId:recipientId||award.userId,awardId:`fantasy:${environment}:${month}:${teamId}`,days:30,at:now(),session,reviewer});
                await c('fantasyAwards',session).updateOne(query({_id:award._id,status:'reviewed'}),{$set:{status:'granted',grantedAt:now().toISOString(),grantedBy:reviewer,receipt}},opts(session));
                return {granted:true,rewardDays:30,receipt};
            });
        },
    };
}
