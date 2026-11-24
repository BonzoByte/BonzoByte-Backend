import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createSiteInsightsRouter } from '../routes/siteInsights.routes.js';
import { INSIGHTS_POLICY, insightsOwner, internalInsightsAccount, validateInsightsEvent, siteInsightsConfig, summarizeInsights, insightsDay, insightsHash } from '../utils/siteInsightsPolicy.js';
import { createDeletionCleanup } from '../utils/accountDeletionCleanup.js';

const config={enabled:true,origin:'https://bonzobyte.com',secret:'a'.repeat(40),emailEnabled:false};
const event=()=>({policy:INSIGHTS_POLICY,consent:true,visitorId:randomUUID(),eventId:randomUUID(),section:'matches'});
const owner={_id:'synthetic-owner',email:'horvat.stanko@gmail.com',isVerified:true};
test('owners are verified exact emails; internal markers do not grant administrator access',()=>{
 assert.equal(insightsOwner(owner),true);assert.equal(insightsOwner({...owner,isVerified:false}),false);
 assert.equal(insightsOwner({email:'somebody@example.invalid',isVerified:true,isAdmin:true}),false);
 assert.equal(insightsOwner({email:'somebody@example.invalid',isVerified:true,testAccount:{seedId:'synthetic'}}),false);
 assert.equal(internalInsightsAccount({email:' BonzoByte@gmail.com '}),true);
 assert.equal(internalInsightsAccount({testAccount:{seedId:'synthetic'}}),true);
});
test('local, preview, wrong domain/database and reused secrets cannot activate production recording',()=>{
 const settings={SITE_INSIGHTS_ENABLED:'true',SITE_INSIGHTS_SECRET:'b'.repeat(40),NODE_ENV:'production',APP_STAGE:'beta',
  FRONTEND_URL:config.origin,BETA_PUBLIC_ORIGIN:config.origin,MONGO_DB:'BonzoByte_Beta',JWT_SECRET:'other'};
 assert.equal(siteInsightsConfig(settings).enabled,true);
 for(const patch of [{NODE_ENV:'development'},{FRONTEND_URL:'http://localhost:4200'},{FRONTEND_URL:'https://preview.vercel.app'},
  {MONGO_DB:'BonzoByte'},{SITE_INSIGHTS_SECRET:'short'},{JWT_SECRET:settings.SITE_INSIGHTS_SECRET},
  {BETA_CODE_SECRET:settings.SITE_INSIGHTS_SECRET}])assert.throws(()=>siteInsightsConfig({...settings,...patch}));
 assert.equal(siteInsightsConfig({}).enabled,false);
 assert.throws(()=>siteInsightsConfig({...settings,SITE_INSIGHTS_EMAIL_ENABLED:'true',SITE_INSIGHTS_NOTIFY_TO:'someone@example.invalid'}));
});

test('withdrawal remains available with recording disabled and never falsely acknowledges a failed removal',async()=>{
 let purges=0,connected=true;const disabled={...config,enabled:false};
 const app=express();app.use('/api/site-insights',createSiteInsightsRouter({config:disabled,available:()=>false,
  purgeAvailable:()=>connected,identity:(_req,_res,next)=>next(),store:{purge:async()=>{purges++;}}}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const base='http://127.0.0.1:'+server.address().port+'/api/site-insights';
 const request=(route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:config.origin},body:JSON.stringify(body)});
 try{
  assert.equal((await request('/view',event())).status,503);assert.equal(purges,0);
  assert.equal((await request('/opt-out',{visitorId:randomUUID()})).status,200);assert.equal(purges,1);
  connected=false;assert.equal((await request('/opt-out',{visitorId:randomUUID()})).status,503);assert.equal(purges,1);
  connected=true;disabled.secret='';assert.equal((await request('/opt-out',{visitorId:randomUUID()})).status,503);assert.equal(purges,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('private signup copy config is optional, single-address, and never an access rule',()=>{
 const settings={SITE_INSIGHTS_ENABLED:'true',SITE_INSIGHTS_SECRET:'private-synthetic-test-secret'.repeat(2),NODE_ENV:'production',APP_STAGE:'beta',
  FRONTEND_URL:config.origin,BETA_PUBLIC_ORIGIN:config.origin,MONGO_DB:'BonzoByte_Beta',SITE_INSIGHTS_EMAIL_ENABLED:'true',
  SITE_INSIGHTS_NOTIFY_TO:owner.email};
 const to='team@example.invalid',since='2026-11-24T20:00:00Z';
 const parse=(dest,start)=>siteInsightsConfig({...settings,SITE_INSIGHTS_SIGNUP_COPY_TO:dest,SITE_INSIGHTS_SIGNUP_COPY_SINCE:start});
 const active=parse(to.toUpperCase(),since);
 assert.equal(active.notifyTo,owner.email);assert.equal(active.signupCopy.to,to);
 assert.equal(+active.signupCopy.start,Date.parse(since));assert.equal(insightsOwner({email:to,isVerified:true}),false);
 assert.equal(internalInsightsAccount({email:to}),false);assert.equal(JSON.stringify(active.signupCopy.tag).includes(to),false);
 for(const [dest,start] of [[undefined,undefined],[owner.email,since],['a@b.invalid,c@d.invalid',since],
  ['somebody <team@example.invalid>',since],[to+'\r\nBcc: x@y.invalid',since],[to,'yesterday'],[to,'2026-02-31T00:00:00Z'],[to,undefined]]){
  const inactive=parse(dest,start);assert.equal(inactive.signupCopy,null);assert.equal(inactive.emailEnabled,true);assert.equal(inactive.notifyTo,owner.email);
 }
 assert.notEqual(parse(to,'2026-11-25T20:00:00Z').signupCopy.tag,active.signupCopy.tag);
});
test('events require fresh-purpose consent and never accept arbitrary URLs, emails or IDs',()=>{
 assert.ok(validateInsightsEvent(event()));
 for(const patch of [{consent:false},{policy:'old'},{visitorId:'email@example.invalid'},{section:'/matches?q=private'},
  {email:'private@example.invalid'},{url:'https://private.invalid'},{excluded:'false'}])assert.throws(()=>validateInsightsEvent({...event(),...patch}));
});
test('summaries distinguish browser estimates, active members, current accounts and confirmed signups',()=>{
 const at=new Date('2026-11-20T23:30:00Z');assert.equal(insightsDay(at),'2026-11-21');
 const result=summarizeInsights([{visitorHash:'one',members:['member'],views:2,day:'2026-11-20',sections:{matches:2}},
  {visitorHash:'one',members:['member'],views:1,day:'2026-11-21',sections:{players:1}}],
 [{day:'2026-11-21'}],{all:3,internal:2,external:1,confirmedExternal:1},{startedAt:at},at,7);
 assert.equal(result.browsers,1);assert.equal(result.activeMembers,1);assert.equal(result.views,3);assert.equal(result.confirmed,1);
 assert.equal(JSON.stringify(result).includes('member'),false);
});
test('HTTP: origins, internal exclusion, private reports, opt-out, strict payloads and disabled mode',async()=>{
 let writes=0,purges=0;
 const app=express();app.use('/api/site-insights',createSiteInsightsRouter({config:{...config,signupCopy:{to:'external@example.invalid'}},available:()=>true,
  identity:(req,res,next)=>{const token=req.headers.authorization;if(token==='Bearer owner')req.user=owner;
   else if(token==='Bearer member')req.user={email:'external@example.invalid',isVerified:true};else if(token)return res.status(401).json({code:'AUTH'});next();},
  store:{record:async()=>{writes++;},purge:async()=>{purges++;},summary:async days=>({days}),notifications:async()=>[],markRead:async()=>{writes++;}}
 }));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const base='http://127.0.0.1:'+server.address().port+'/api/site-insights';
 const request=(route,body,origin=config.origin,token)=>fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:origin,...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
 try{
  assert.equal((await request('/view',event(),'http://localhost:4200')).status,403);
  assert.equal((await request('/view',event(),'https://preview.vercel.app')).status,403);assert.equal(writes,0);
  assert.equal((await request('/summary')).status,401);assert.equal((await request('/summary',null,config.origin,'member')).status,403);
  assert.equal((await request('/notifications',null,config.origin,'member')).status,403);
  assert.equal((await request('/notifications/read',{ids:['a'.repeat(24)]},config.origin,'member')).status,403);
  const report=await request('/summary?days=7',null,config.origin,'owner');assert.equal(report.status,200);assert.match(report.headers.get('cache-control'),/no-store/);
  assert.equal((await request('/summary?days=365',null,config.origin,'owner')).status,400);
  assert.equal((await request('/view',event(),config.origin,'owner')).status,200);assert.equal(writes,0);
  await request('/view',{...event(),excluded:true});assert.equal(writes,0);
  await request('/view',event());assert.equal(writes,1);
  assert.equal((await request('/view',{...event(),consent:false})).status,400);
  assert.equal((await request('/view',event(),config.origin,'stale')).status,401);
  assert.equal((await request('/opt-out',{visitorId:randomUUID()})).status,200);assert.equal(purges,1);
  assert.equal((await request('/notifications/read',{ids:['not-an-id']},config.origin,'owner')).status,400);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('account erasure waits for pending owner mail and unlinks all member hashes within its transaction',async()=>{
 const savedSecret=process.env.SITE_INSIGHTS_SECRET,mutations=[],user={_id:'synthetic-erased-member',email:'synthetic@example.invalid'};
 let sending=true,hasMemberRows=true;
 const connection={collection:name=>({
  find:()=>({toArray:async()=>[]}),
  findOne:async query=>name==='siteinsights_registrations'&&sending&&query.$or?.some(q=>
   q['copy.emailState']==='sending'&&q['copy.leaseUntil']?.$gt instanceof Date)?{lease:true}:name==='siteinsights_visits'&&hasMemberRows?{members:['synthetic']}:null,
  updateMany:async(...args)=>{mutations.push({name,args});return{modifiedCount:1};},deleteMany:async()=>({deletedCount:0}),
 })};
 const cleanup=createDeletionCleanup(connection),session={syntheticSession:true};
 try{
  delete process.env.SITE_INSIGHTS_SECRET;
  await assert.rejects(cleanup.check(user,new Date()),{code:'DELETION_WAITING'});
  sending=false;await assert.rejects(cleanup.check(user,new Date()),{code:'DELETION_REVIEW_REQUIRED'});
  hasMemberRows=false;await cleanup.check(user,new Date());
  const key='synthetic-erasure-key-never-for-production';process.env.SITE_INSIGHTS_SECRET=key;
  await cleanup.erase(user,session);
  const registration=mutations.find(row=>row.name==='siteinsights_registrations');
  assert.deepEqual(registration.args[0],{userId:user._id});assert.equal(registration.args[1].$unset.userId,'');
  assert.equal(registration.args[1].$unset.copy,'');
  assert.equal(registration.args[1].$set.emailState,'suppressed');assert.equal(registration.args[2].session,session);
  const visits=mutations.find(row=>row.name==='siteinsights_visits'),hash=insightsHash(key,'member',user._id);
  assert.deepEqual(visits.args[0],{members:hash});assert.deepEqual(visits.args[1],{$pull:{members:hash}});assert.equal(visits.args[2].session,session);
 }finally{if(savedSecret===undefined)delete process.env.SITE_INSIGHTS_SECRET;else process.env.SITE_INSIGHTS_SECRET=savedSecret;}
});
