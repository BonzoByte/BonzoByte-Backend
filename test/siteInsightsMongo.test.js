import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { createSiteInsightsStore } from '../utils/siteInsightsStore.js';
import { createMailTransport } from '../utils/mailTransport.js';
import { INSIGHTS_COLLECTIONS as names } from '../utils/siteInsightsPolicy.js';

test('isolated MongoDB: exact-once views, private summary, signup reconciliation, durable mail and opt-out',
 { skip: !process.env.SITE_INSIGHTS_TEST_MONGO, timeout: 60000 }, async t => {
 const database='BonzoByte_Insights_Test_'+randomUUID().replaceAll('-','').slice(0,12),nonce=randomUUID();
 assert.match(database,/^BonzoByte_Insights_Test_[a-f0-9]{12}$/);assert.notEqual(database,'BonzoByte_Beta');
 const client=new MongoClient(process.env.SITE_INSIGHTS_TEST_MONGO,{maxPoolSize:3,serverSelectionTimeoutMS:15000});
 let guarded=false;
 try{
  await client.connect();const db=client.db(database);
  assert.equal((await db.listCollections({},{nameOnly:true}).toArray()).length,0,'Test target already exists');
  await db.collection('_site_insights_test_guard').insertOne({_id:'owner',nonce});guarded=true;
  const connection={collection:name=>db.collection(name),transaction:async fn=>{
   const session=client.startSession();try{return await session.withTransaction(()=>fn(session));}finally{await session.endSession();}
  }};
  let clock=new Date('2026-11-20T12:00:00Z'),failMail=false;const messages=[];
  const mailer={provider:'resend',isConfigured:true,sendMail:async(payload,options)=>{messages.push({payload,options});if(failMail)throw new Error('synthetic ambiguous provider response');return{messageId:'synthetic'};}};
  const users=db.collection('users'),memberId=new ObjectId(),pendingId=new ObjectId();
  const store=createSiteInsightsStore({connection,User:{collection:users},config:{secret:'synthetic-separate-secret'.repeat(2),emailEnabled:true,notifyTo:'bonzobyte@gmail.com'},now:()=>new Date(clock),mailer});
  await store.initialize();
  await users.insertMany([
   {_id:memberId,email:'member@example.invalid',isVerified:true,provider:['google'],createdAt:new Date(clock)},
   {_id:pendingId,email:'pending@example.invalid',isVerified:false,provider:['local'],createdAt:new Date(clock)},
   {email:'old@example.invalid',isVerified:true,createdAt:new Date(+clock-86400000)},
   {email:'horvat.stanko@gmail.com',isVerified:true,createdAt:new Date(clock)},
   {email:'bonzobyte@gmail.com',isVerified:true,createdAt:new Date(clock)},
   {email:'fixture@example.invalid',isVerified:true,createdAt:new Date(clock),testAccount:{seedId:'synthetic'}},
  ]);
  const visitorId=randomUUID(),eventId=randomUUID(),event={visitorId,eventId,section:'matches'};
  await Promise.all(Array.from({length:4},()=>store.record(event,{_id:memberId,isVerified:true})));
  let report=await store.summary(7);assert.equal(report.views,1);assert.equal(report.browsers,1);assert.equal(report.activeMembers,1);
  await store.record({...event,eventId:randomUUID(),section:'players'},{_id:memberId,isVerified:true});
  clock=new Date(+clock+86400000);await store.record({...event,eventId:randomUUID()},{_id:memberId,isVerified:true});
  await store.record({visitorId:randomUUID(),eventId:randomUUID(),section:'home'},null);
  report=await store.summary(7);assert.equal(report.views,4);assert.equal(report.browsers,2);assert.equal(report.activeMembers,1);
  assert.equal(report.accounts.all,6);assert.equal(report.accounts.internal,3);assert.equal(report.accounts.external,3);
  const stored=JSON.stringify(await db.collection(names.visits).find({}).toArray());
  assert.equal(stored.includes(visitorId),false);assert.equal(stored.includes(eventId),false);assert.equal(stored.includes('member@example.invalid'),false);
  assert.equal(stored.includes(String(memberId)),false);
  assert.equal(await store.observeRegistrations(),1);assert.equal(await store.observeRegistrations(),0);
  assert.equal((await store.notifications()).length,1);assert.equal((await store.notifications())[0].provider,'google');
  await store.sendRegistrationMail();await store.sendRegistrationMail();assert.equal(messages.length,1);
  assert.equal(messages[0].payload.to,'bonzobyte@gmail.com');assert.equal(messages[0].payload.text.includes('member@example.invalid'),false);
  const first=(await store.notifications())[0];await store.markRead([first.id]);assert.equal((await store.notifications())[0].read,true);
  await users.updateOne({_id:pendingId},{$set:{isVerified:true}});assert.equal(await store.observeRegistrations(),1);
  failMail=true;await store.sendRegistrationMail();assert.equal(messages.length,2);
  clock=new Date(+clock+61000);failMail=false;await store.sendRegistrationMail();assert.equal(messages.length,3);
  assert.equal(messages[1].options.idempotencyKey,messages[2].options.idempotencyKey);
  await store.purge(visitorId);report=await store.summary(7);assert.equal(report.views,1);assert.equal(report.browsers,1);assert.equal(report.activeMembers,0);
  // Expiring the notification row must not turn an existing account into a new signup again.
  await db.collection(names.registrations).deleteOne({userId:memberId});assert.equal(await store.observeRegistrations(),0);
  const indexes=await db.collection(names.visits).indexes();assert.ok(indexes.some(i=>i.expireAfterSeconds===0));
  await t.test('copy activation, parallel workers, independent retries, restart, erasure and no backfill',async()=>{
   const cutoff=new Date(+clock+1000), team='team@example.invalid', owner='owner@example.invalid';
   const copy={start:cutoff,to:team,tag:'synthetic-configuration-fingerprint'};
   const log=[], failures=new Set(), notices=db.collection(names.registrations);
   const fake=createMailTransport({EMAIL_PROVIDER:'resend',RESEND_API_KEY:'synthetic',EMAIL_FROM:'info@bonzobyte.com',
    EMAIL_ROUTING_ENABLED:'true',EMAIL_SENDER_DOMAIN:'bonzobyte.com'}, {createResendClient:()=>({emails:{async send(payload,{idempotencyKey:key}){
     assert.equal(payload.to.length,1);log.push({payload,key});
     if(failures.has(payload.to[0]))throw Error('synthetic timeout after send');
     return {data:{id:'fake-acceptance'}};
   }}})});
   const worker=async signupCopy=>{
    const s=createSiteInsightsStore({connection,User:{collection:users},now:()=>new Date(clock),mailer:fake,
     config:{secret:'synthetic-test-secret',notifyTo:owner,emailEnabled:true,signupCopy}});
    await s.initialize();return s;
   };
   const add=async(createdAt,isVerified=true)=>(await users.insertOne({email:'new@example.invalid',provider:['local'],isVerified,createdAt})).insertedId;
   const deliveries=to=>log.filter(r=>r.payload.to[0]===to);
   // A pending legacy notice and a delayed first observation are not copy work.
   const legacy=await worker(null),legacyId=await add(clock);await legacy.observeRegistrations();
   const delayedId=await add(clock,false);clock=cutoff;
   await users.updateOne({_id:delayedId},{$set:{isVerified:true}});
   const w=await worker(copy);await w.observeRegistrations();
   await w.sendRegistrationMail();await w.sendRegistrationMail();
   for(const id of [legacyId,delayedId])assert.equal((await notices.findOne({userId:id})).copy,undefined);
   assert.deepEqual(log.map(r=>r.payload.to),[[owner],[owner]]);log.length=0;
   const freshId=await add(clock);await Promise.all([w.observeRegistrations(),w.observeRegistrations()]);
   const notice=await notices.findOne({userId:freshId});
   failures.add(team);await Promise.all([w.sendRegistrationMail(),w.sendRegistrationMail()]);
   const firstCopy=deliveries(team)[0],ownerMail=deliveries(owner)[0];
   assert.equal(ownerMail.key,'site-registration-'+notice._id);assert.equal(firstCopy.key,'site-registration-copy-'+notice._id);
   assert.equal(log.length,2);assert.deepEqual(firstCopy.payload,{...ownerMail.payload,to:[team]});
   assert.match(firstCopy.payload.from,/<accounts@bonzobyte\.com>$/);assert.doesNotMatch(firstCopy.payload.text,/new@example\.invalid/);
   assert.equal(JSON.stringify(await notices.findOne({userId:freshId})).includes(team),false);
   clock=new Date(+clock+61000);failures.clear();
   const changed=await worker({...copy,to:'other@example.invalid',tag:'changed'});await changed.sendRegistrationMail();
   await legacy.sendRegistrationMail();assert.equal(log.length,2);
   const restarted=await worker(copy);await restarted.sendRegistrationMail();await restarted.sendRegistrationMail();
   assert.deepEqual(deliveries(team),[firstCopy,firstCopy]);assert.equal(deliveries(owner).length,1);
   assert.equal((await notices.findOne({userId:freshId})).copy.emailState,'accepted');
   // The reverse failure direction must not repeat an accepted copy either.
   log.length=0;failures.add(owner);await add(clock);await w.observeRegistrations();await w.sendRegistrationMail();
   clock=new Date(+clock+61000);failures.clear();await w.sendRegistrationMail();
   assert.equal(deliveries(team).length,1);assert.equal(deliveries(owner).length,2);
   assert.equal(deliveries(owner)[0].key,deliveries(owner)[1].key);
   // Recheck eligibility before each send; a closure between attempts suppresses the copy.
   failures.add(team);const closing=await add(clock);await w.observeRegistrations();await w.sendRegistrationMail();
   await users.updateOne({_id:closing},{$set:{'accountClosure.requestedAt':clock}});
   failures.clear();clock=new Date(+clock+61000);log.length=0;await w.sendRegistrationMail();
   assert.equal(log.length,0);assert.equal((await notices.findOne({userId:closing})).copy.emailState,'suppressed');
   // Five failed copy attempts or an expired idempotency window must stop sending.
   const exhausted=await add(clock);await w.observeRegistrations();failures.add(team);
   for(let n=0;n<6;n++){await w.sendRegistrationMail();clock=new Date(+clock+61000);}
   assert.equal(deliveries(team).length,5);assert.equal(new Set(deliveries(team).map(r=>r.key)).size,1);
   assert.equal(deliveries(owner).length,1);assert.equal((await notices.findOne({userId:exhausted})).copy.emailState,'review');
   const expired=await add(clock);await w.observeRegistrations();await w.sendRegistrationMail();
   failures.clear();log.length=0;clock=new Date(+clock+20*3600000);await w.sendRegistrationMail();
   assert.equal(log.length,0);assert.equal((await notices.findOne({userId:expired})).copy.emailState,'review');
   assert.equal(await w.observeRegistrations(),0);
  });
  console.log(JSON.stringify({siteInsightsMongoPassed:true,isolatedDatabasePrefix:'BonzoByte_Insights_Test_',productionDatabaseTouched:false,
   realMailRequests:0,duplicateViewDeduped:true,internalAccountsExcluded:true,signupNotRepeated:true,providerRetryKeyStable:true,withdrawalPurged:true}));
 }finally{
  if(guarded){
   const db=client.db(database);assert.equal((await db.collection('_site_insights_test_guard').findOne({_id:'owner'}))?.nonce,nonce);
   const allowed=new Set(['users','_site_insights_test_guard',...Object.values(names)]);
   for(const c of await db.listCollections({},{nameOnly:true}).toArray())assert.ok(allowed.has(c.name),'Unexpected test collection; do not delete');
   assert.match(db.databaseName,/^BonzoByte_Insights_Test_[a-f0-9]{12}$/);await db.dropDatabase();
  }
  await client.close();
 }
});
