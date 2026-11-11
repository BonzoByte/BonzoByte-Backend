import {Types} from 'mongoose';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {PRIVATE_MESSAGE_COLLECTIONS} from '../models/privateMessages.model.js';
import {discussionText,discussionProfile} from './discussions.js';
export const pmError=(code,status=400)=>Object.assign(new Error('PM_'+code),{code:'PM_'+code,status});
export const pmId=value=>{if(typeof value!=='string'||!/^[a-f0-9]{24}$/.test(value))throw pmError('INVALID');return value;};
export function pmObject(value,keys,required=[]){if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!keys.includes(k))||required.some(k=>!Object.hasOwn(value,k)))throw pmError('INVALID');return value;}
export function pmBody(value,request=false){pmObject(value,request?['body','clientRequestId','recipientId']:['body','clientRequestId'],request?['body','clientRequestId','recipientId']:['body','clientRequestId']);
 if(typeof value.clientRequestId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.clientRequestId))throw pmError('INVALID');
 try{return{body:discussionText(value.body),clientRequestId:value.clientRequestId,...(request?{recipientId:pmId(value.recipientId)}:{})};}catch{throw pmError('INVALID');}}
export function pmPage(query={},inbox=false){if(Object.keys(query).some(k=>!['after','limit'].includes(k))||(query.limit!==undefined&&query.limit!=='20'))throw pmError('INVALID');
 if(inbox){if(query.after===undefined)return{after:null};try{if(typeof query.after!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(query.after))throw 0;
  const value=JSON.parse(Buffer.from(query.after,'base64url'));if(!Array.isArray(value)||value.length!==2||!Number.isSafeInteger(value[0])||value[0]<0||!Number.isFinite(+new Date(value[0]))||Buffer.from(JSON.stringify(value)).toString('base64url')!==query.after)throw 0;
  return{after:{at:new Date(value[0]),id:pmId(value[1])}};}catch{throw pmError('INVALID');}}
 const after=query.after===undefined?0:Number(query.after);if(query.after!==undefined&&(typeof query.after!=='string'||!/^(0|[1-9]\d{0,15})$/.test(query.after))||!Number.isSafeInteger(after)||after<0)throw pmError('INVALID');return{after};}
const oid=value=>new Types.ObjectId(value),same=(a,b)=>String(a)===String(b);
const profileFields={_id:1,nickname:1,avatarUrl:1,accountClosure:1,isVerified:1,isAdmin:1};
const opts=session=>({session,maxTimeMS:20000});
const keyFor=(a,b)=>[String(a),String(b)].sort().join(':');
const cursor=row=>Buffer.from(JSON.stringify([+row.lastActivityAt,String(row.conversationId)])).toString('base64url');

export function createPrivateMessages({connection,User,models=[],names=PRIVATE_MESSAGE_COLLECTIONS,now=()=>new Date(),available=()=>true,clock=()=>performance.now()}){
 const c=key=>connection.collection(names[key]);
 async function initialize(){const start=clock(),remaining=()=>{const ms=Math.ceil(90000-(clock()-start));if(ms<=0)throw pmError('UNAVAILABLE',503);return ms;};
  const hello=await connection.db.admin().command({hello:1,maxTimeMS:5000},{timeoutMS:Math.min(5000,remaining())});if(!hello.setName&&hello.msg!=='isdbgrid')throw pmError('UNAVAILABLE',503);
  for(const model of models){const indexes=model.schema.indexes().map(([key,settings])=>{const{_autoIndex,...rest}=settings;return{key,...rest};});
   if(!indexes.length)indexes.push({key:{_id:1},name:'_id_'});
   const ms=Math.min(30000,remaining());await connection.db.collection(model.collection.name).createIndexes(indexes,{maxTimeMS:ms,timeoutMS:ms});}remaining();}
 async function tx(actor,fn,admin=false){if(!available())throw pmError('UNAVAILABLE',503);
  if(!actor?.user||!actor.operation?.id||!Number.isInteger(actor.tokenVersion)||actor.tokenVersion<0||actor.tokenVersion!==actor.operation.tokenVersion)throw pmError('AUTH_REQUIRED',401);
  const start=clock();for(let attempt=0;;attempt++){const remaining=Math.ceil(20000-(clock()-start));if(remaining<=0)throw pmError('UNAVAILABLE',503);
   try{return await connection.transaction(async session=>{const at=now();
    const user=await User.collection.findOneAndUpdate({_id:actor.user,...(actor.tokenVersion===0?{$or:[{tokenVersion:0},{tokenVersion:null}]}:{tokenVersion:actor.tokenVersion}),
     'accountClosure.requestedAt':{$exists:false},accountOperations:{$elemMatch:{id:actor.operation.id,expiresAt:{$gt:at}}}},
     {$set:{'accountOperations.$.expiresAt':new Date(+at+120000)},$inc:{'accountOperations.$.privateMessageWrites':1}},
     {...opts(session),returnDocument:'after',includeResultMetadata:false,projection:profileFields});
    if(!user)throw pmError('AUTH_REQUIRED',401);if(user.isVerified!==true)throw pmError('VERIFICATION_REQUIRED',403);if(admin&&user.isAdmin!==true)throw pmError('FORBIDDEN',403);
    return fn(session,at,user);
   },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},timeoutMS:remaining,maxCommitTimeMS:20000});}
   catch(error){if(error.code!==11000||attempt>=2)throw error;}}
 }
 async function profile(id,session){if(!id)return null;const row=await User.collection.findOne({_id:id}, {...opts(session),projection:profileFields});return row?.isVerified?discussionProfile(row):null;}
 async function pairLock(a,b,session){await c('pmPairs').updateOne({_id:keyFor(a,b)},{$inc:{revision:1},$setOnInsert:{members:[a,b]}},{...opts(session),upsert:true});}
 async function blocks(a,b,session){return c('pmBlocks').find({$or:[{ownerId:a,targetId:b},{ownerId:b,targetId:a}]},opts(session)).limit(2).toArray();}
 async function member(actor,id,session){const row=await c('pmConversations').findOne({_id:oid(id),participants:actor.user},opts(session));if(!row)throw pmError('NOT_FOUND',404);return row;}
 async function state(actor,id,session){const row=await c('pmStates').findOne({conversationId:id,userId:actor.user},opts(session));if(!row)throw pmError('NOT_FOUND',404);return row;}
 const peerId=(row,actor)=>row.participants.find(id=>!same(id,actor.user));
 function conversationView(actor,row,me,peerProfile,flags){const peer=peerId(row,actor);
  return{id:String(row._id),peer:peerProfile,status:row.status,requestedByMe:same(row.initiatorId,actor.user),
   blocked:flags.length>0,blockedByMe:flags.some(flag=>same(flag.ownerId,actor.user)),canSend:row.status==='accepted'&&flags.length===0&&!!peer&&!!peerProfile,
   canAccept:row.status==='pending'&&!same(row.initiatorId,actor.user)&&flags.length===0&&!!peer&&!!peerProfile,
   unread:me.inboxUnread===true,lastActivityAt:row.lastActivityAt};}
 async function view(actor,row,session,supplied){const peer=peerId(row,actor);return conversationView(actor,row,supplied??await state(actor,row._id,session),await profile(peer,session),peer?await blocks(actor.user,peer,session):[]);}
 async function consume(user,kind,at,session){const row=await c('pmRates').findOne({_id:user},opts(session)),span=kind==='requests'?86400000:3600000,max=kind==='requests'?5:kind==='posts'?60:20;
  const recent=(row?.[kind]??[]).filter(date=>+date>+at-span);if(recent.length>=max||(recent.length&&+at-+recent.at(-1)<(kind==='posts'?1000:500)))throw pmError('RATE_LIMIT',429);
  await c('pmRates').updateOne({_id:user},{$set:{[kind]:[...recent,at]}},{...opts(session),upsert:true});}
 async function recipientFence(id,session){const result=await User.collection.updateOne({_id:id,isVerified:true,'accountClosure.requestedAt':{$exists:false}},{$inc:{privateMessagesRevision:1}},opts(session));if(!result.matchedCount)throw pmError('TARGET_UNAVAILABLE',403);}
 async function messageDTO(rows,actor,session){const ids=[...new Map(rows.filter(row=>!row.deleted&&row.senderId).map(row=>[String(row.senderId),row.senderId])).values()];
  const profiles=ids.length?await User.collection.find({_id:{$in:ids}},{...opts(session),projection:profileFields}).limit(50).toArray():[];
  const byId=new Map(profiles.map(row=>[String(row._id),discussionProfile(row)]));
  return rows.map(row=>({id:String(row._id),sequence:row.sequence,body:row.deleted?'':row.body,createdAt:row.createdAt,
   author:row.deleted?null:byId.get(String(row.senderId))??null,mine:same(row.senderId,actor.user),deleted:row.deleted===true,canReport:!row.deleted&&!same(row.senderId,actor.user)}));}
 async function createMessage(actor,row,body,hash,session,at){const peer=peerId(row,actor);if(!peer)throw pmError('NOT_AVAILABLE',403);
  const message={_id:new Types.ObjectId(),conversationId:row._id,sequence:row.lastSequence+1,senderId:actor.user,body:body.body,createdAt:at,deleted:false,clientRequestId:body.clientRequestId,requestHash:hash};
  await c('pmMessages').insertOne(message,opts(session));
  await c('pmConversations').updateOne({_id:row._id},{$set:{lastSequence:message.sequence,lastActivityAt:at,lastMessageId:message._id},$inc:{revision:1}},opts(session));
  for(const userId of row.participants)await c('pmStates').updateOne({conversationId:row._id,userId},{$set:{lastActivityAt:at,...(!same(userId,actor.user)?{inboxUnread:true}:{})}},opts(session));
  const current={...row,lastSequence:message.sequence,lastActivityAt:at,lastMessageId:message._id};return{conversation:await view(actor,current,session),message:(await messageDTO([message],actor,session))[0],replayed:false};}
 async function replay(actor,input,hash,session){const message=await c('pmMessages').findOne({senderId:actor.user,clientRequestId:input.clientRequestId},opts(session));if(!message)return null;
  if(message.requestHash!==hash)throw pmError('CONFLICT',409);const row=await member(actor,String(message.conversationId),session);
  return{conversation:await view(actor,row,session),message:(await messageDTO([message],actor,session))[0],replayed:true};}
 const hash=(kind,target,body)=>createHash('sha256').update(JSON.stringify([kind,String(target),body])).digest('hex');
 return{initialize,
  summary:actor=>tx(actor,async(session)=>({unreadCount:await c('pmStates').countDocuments({userId:actor.user,inboxUnread:true},opts(session))})),
  settings:actor=>tx(actor,async session=>({requestsEnabled:(await c('pmSettings').findOne({_id:actor.user},opts(session)))?.requestsEnabled!==false})),
  setSettings:(actor,enabled)=>tx(actor,async session=>{await c('pmSettings').updateOne({_id:actor.user},{$set:{requestsEnabled:enabled},$inc:{revision:1}},{...opts(session),upsert:true});return{requestsEnabled:enabled};}),
  target:(actor,target)=>tx(actor,async session=>{const id=oid(pmId(target));if(same(id,actor.user))throw pmError('INVALID');
   const row=await c('pmConversations').findOne({pairKey:keyFor(actor.user,id),participants:actor.user},opts(session));
   if(!row&&!await connection.collection('discussioncomments').findOne({userId:id,deleted:false,hidden:false},opts(session)))throw pmError('NOT_FOUND',404);
   const peer=await profile(id,session);if(!peer)throw pmError('NOT_FOUND',404);
   const enabled=(await c('pmSettings').findOne({_id:id},opts(session)))?.requestsEnabled!==false;
   return{peer,conversation:row?await view(actor,row,session):null,canRequest:!row&&enabled&&!(await blocks(actor.user,id,session)).length};}),
  inbox:(actor,page={after:null})=>tx(actor,async session=>{const rows=await c('pmStates').find({userId:actor.user,...(page.after?{$or:[{lastActivityAt:{$lt:page.after.at}},{lastActivityAt:page.after.at,conversationId:{$gt:oid(page.after.id)}}]}:{})},opts(session))
   .sort({lastActivityAt:-1,conversationId:1}).limit(21).toArray();const shown=rows.slice(0,20),ids=shown.map(row=>row.conversationId);
   const owned=ids.length?await c('pmConversations').find({_id:{$in:ids},participants:actor.user},opts(session)).limit(20).toArray():[];
   const peers=owned.map(row=>peerId(row,actor)).filter(Boolean);
   const profiles=peers.length?await User.collection.find({_id:{$in:peers}},{...opts(session),projection:profileFields}).limit(20).toArray():[];
   const flags=peers.length?await c('pmBlocks').find({$or:[{ownerId:actor.user,targetId:{$in:peers}},{targetId:actor.user,ownerId:{$in:peers}}]},opts(session)).limit(40).toArray():[];
   const lastIds=owned.map(row=>row.lastMessageId).filter(Boolean),lasts=lastIds.length?await c('pmMessages').find({_id:{$in:lastIds}},opts(session)).limit(20).toArray():[];
   const conversations=shown.flatMap(own=>{const row=owned.find(row=>same(row._id,own.conversationId));if(!row)return[];const peer=peerId(row,actor),person=profiles.find(p=>same(p._id,peer));
    const dto=conversationView(actor,row,own,person?.isVerified?discussionProfile(person):null,flags.filter(flag=>same(flag.ownerId,peer)||same(flag.targetId,peer)));
    const last=lasts.find(message=>same(message._id,row.lastMessageId)&&same(message.conversationId,row._id));return[{...dto,lastPreview:last&&!last.deleted?last.body:null}];});
   return{conversations,hasMore:rows.length>20,nextAfter:rows.length>20?cursor(shown.at(-1)):null};}),
  request:(actor,input)=>{input=pmBody(input,true);return tx(actor,async(session,at)=>{const id=oid(input.recipientId);if(same(id,actor.user))throw pmError('INVALID');
   const digest=hash('request',id,input.body),old=await replay(actor,input,digest,session);if(old)return old;
   await pairLock(actor.user,id,session);await recipientFence(id,session);
   if(await c('pmConversations').findOne({pairKey:keyFor(actor.user,id)},opts(session)))throw pmError('CONFLICT',409);
   if(!await connection.collection('discussioncomments').findOne({userId:id,deleted:false,hidden:false},opts(session)))throw pmError('TARGET_UNAVAILABLE',403);
   if((await blocks(actor.user,id,session)).length)throw pmError('TARGET_UNAVAILABLE',403);
   const preferences=await c('pmSettings').findOneAndUpdate({_id:id},{$inc:{revision:1},$setOnInsert:{requestsEnabled:true}},{...opts(session),upsert:true,returnDocument:'after',includeResultMetadata:false});
   if(preferences.requestsEnabled===false)throw pmError('TARGET_UNAVAILABLE',403);
   await consume(actor.user,'requests',at,session);await consume(actor.user,'posts',at,session);
   const row={_id:new Types.ObjectId(),pairKey:keyFor(actor.user,id),participants:[actor.user,id],initiatorId:actor.user,status:'pending',lastSequence:0,lastActivityAt:at,revision:0};
   await c('pmConversations').insertOne(row,opts(session));
   for(const userId of row.participants)await c('pmStates').insertOne({conversationId:row._id,userId,otherUserId:same(userId,actor.user)?id:actor.user,readThrough:0,fetchedThrough:0,inboxUnread:false,lastActivityAt:at},opts(session));
   return createMessage(actor,row,input,digest,session,at);});},
  send:(actor,id,input)=>{pmId(id);input=pmBody(input);return tx(actor,async(session,at)=>{const digest=hash('message',id,input.body),old=await replay(actor,input,digest,session);if(old)return old;
   const row=await member(actor,id,session),peer=peerId(row,actor);if(!peer||row.status!=='accepted')throw pmError('NOT_ACCEPTED',409);
   await pairLock(actor.user,peer,session);await recipientFence(peer,session);if((await blocks(actor.user,peer,session)).length)throw pmError('TARGET_UNAVAILABLE',403);
   await consume(actor.user,'posts',at,session);return createMessage(actor,row,input,digest,session,at);});},
  conversation:(actor,id,page={after:0})=>tx(actor,async session=>{const row=await member(actor,pmId(id),session),own=await state(actor,row._id,session);
   const rows=await c('pmMessages').find({conversationId:row._id,sequence:{$gt:page.after}},opts(session)).sort({sequence:1}).limit(21).toArray(),shown=rows.slice(0,20);
   if(page.after<=own.fetchedThrough){const through=shown.at(-1)?.sequence??own.fetchedThrough;if(through>own.fetchedThrough)await c('pmStates').updateOne({_id:own._id},{$set:{fetchedThrough:through}},opts(session));}
   return{conversation:await view(actor,row,session,own),messages:await messageDTO(shown,actor,session),readThrough:own.readThrough,
    total:row.lastSequence,latestSequence:row.lastSequence,hasMore:rows.length>20,nextAfter:shown.at(-1)?.sequence??page.after};}),
  decision:(actor,id,accept)=>tx(actor,async session=>{const row=await member(actor,pmId(id),session),peer=peerId(row,actor);
   if(row.status!=='pending'||same(row.initiatorId,actor.user)||!peer)throw pmError('NOT_AVAILABLE',409);await pairLock(actor.user,peer,session);
   await recipientFence(peer,session);if((await blocks(actor.user,peer,session)).length)throw pmError('NOT_AVAILABLE',403);
   await c('pmConversations').updateOne({_id:row._id},{$set:{status:accept?'accepted':'declined'},$inc:{revision:1}},opts(session));
   if(!accept)await c('pmStates').updateMany({conversationId:row._id},{$set:{inboxUnread:false}},opts(session));
   return{conversation:await view(actor,{...row,status:accept?'accepted':'declined'},session)};}),
  read:(actor,id,through)=>tx(actor,async session=>{const row=await member(actor,pmId(id),session),own=await state(actor,row._id,session);
   if(!Number.isSafeInteger(through)||through<0)throw pmError('INVALID');if(through>own.fetchedThrough)throw pmError('NOT_FETCHED',409);
   const readThrough=Math.max(through,own.readThrough),peer=peerId(row,actor);
   const pending=row.status!=='declined'&&peer&&!(await blocks(actor.user,peer,session)).length&&!!await c('pmMessages').findOne({conversationId:row._id,sequence:{$gt:readThrough},senderId:{$ne:actor.user},deleted:false},opts(session));
   await c('pmStates').updateOne({_id:own._id},{$set:{readThrough,inboxUnread:!!pending}},opts(session));return{readThrough};}),
  block:(actor,target,blocked)=>tx(actor,async(session,at)=>{const id=oid(pmId(target));if(same(id,actor.user))throw pmError('INVALID');
   if(!blocked&&!await User.collection.findOne({_id:id,'accountClosure.requestedAt':{$exists:false}},opts(session))){await c('pmBlocks').deleteOne({ownerId:actor.user,targetId:id},opts(session));return{blocked:false};}
   await recipientFence(id,session);await pairLock(actor.user,id,session);
   const owned=await c('pmConversations').findOne({pairKey:keyFor(actor.user,id),participants:actor.user},opts(session));
   const previous=await c('pmBlocks').findOne({ownerId:actor.user,targetId:id},opts(session));if(!owned&&!previous&&!await connection.collection('discussioncomments').findOne({userId:id,deleted:false,hidden:false},opts(session)))throw pmError('NOT_FOUND',404);
   if(blocked)await c('pmBlocks').updateOne({ownerId:actor.user,targetId:id},{$setOnInsert:{createdAt:at}},{...opts(session),upsert:true});
   else await c('pmBlocks').deleteOne({ownerId:actor.user,targetId:id},opts(session));
   if(owned){await c('pmConversations').updateOne({_id:owned._id},{$inc:{revision:1}},opts(session));if(blocked)await c('pmStates').updateMany({conversationId:owned._id},{$set:{inboxUnread:false}},opts(session));}
   return{blocked};}),
  blocked:(actor,after=null)=>tx(actor,async session=>{const rows=await c('pmBlocks').find({ownerId:actor.user,...(after?{targetId:{$gt:oid(pmId(after))}}:{})},opts(session)).sort({targetId:1}).limit(21).toArray();
   const users=[];for(const row of rows.slice(0,20))users.push({id:String(row.targetId),profile:await profile(row.targetId,session)});
   return{users,hasMore:rows.length>20,nextAfter:rows.length>20?String(rows[19].targetId):null};}),
  remove:(actor,id)=>tx(actor,async session=>{const message=await c('pmMessages').findOne({_id:oid(pmId(id))},opts(session));if(!message)throw pmError('NOT_FOUND',404);
   const row=await member(actor,String(message.conversationId),session);if(!same(message.senderId,actor.user))throw pmError('FORBIDDEN',403);
   await c('pmMessages').updateOne({_id:message._id},{$set:{deleted:true,body:''}},opts(session));
   for(const userId of row.participants){const own=await state({user:userId},row._id,session),peer=peerId(row,{user:userId});
    const unread=row.status!=='declined'&&peer&&!(await blocks(userId,peer,session)).length&&!!await c('pmMessages').findOne({conversationId:row._id,sequence:{$gt:own.readThrough},senderId:{$ne:userId},deleted:false},opts(session));
    await c('pmStates').updateOne({_id:own._id},{$set:{inboxUnread:!!unread}},opts(session));}return{deleted:true};}),
  report:(actor,id,reason='')=>tx(actor,async(session,at)=>{try{reason=discussionText(reason,500,true);}catch{throw pmError('INVALID');}
   const message=await c('pmMessages').findOne({_id:oid(pmId(id))},opts(session));if(!message)throw pmError('NOT_FOUND',404);await member(actor,String(message.conversationId),session);
   if(message.deleted||!message.senderId||same(message.senderId,actor.user))throw pmError('NOT_AVAILABLE',403);
   const query={reporterId:actor.user,messageId:message._id};if(await c('pmReports').findOne(query,opts(session)))return{reported:true};
   await consume(actor.user,'reports',at,session);await c('pmMessages').updateOne({_id:message._id},{$inc:{reportRevision:1}},opts(session));
   await c('pmReports').insertOne({...query,authorId:message.senderId,conversationId:message.conversationId,reason,createdAt:at,resolved:false},opts(session));return{reported:true};}),
  reports:(actor,after=null)=>tx(actor,async session=>{const rows=await c('pmReports').find(after?{_id:{$lt:oid(pmId(after))}}:{},opts(session)).sort({_id:-1}).limit(21).toArray();
   return{reports:rows.slice(0,20).map(row=>({id:String(row._id),createdAt:row.createdAt,resolved:row.resolved===true})),hasMore:rows.length>20,nextAfter:rows.length>20?String(rows[19]._id):null};},true),
  review:(actor,id)=>tx(actor,async(session,at)=>{const report=await c('pmReports').findOne({_id:oid(pmId(id))},opts(session));if(!report)throw pmError('NOT_FOUND',404);
   const message=await c('pmMessages').findOne({_id:report.messageId,conversationId:report.conversationId},opts(session));
   const rows=message?await c('pmMessages').find({conversationId:report.conversationId,sequence:{$gte:message.sequence-1,$lte:message.sequence+1}},opts(session)).sort({sequence:1}).limit(3).toArray():[];
   await c('pmAudits').insertOne({reviewerId:actor.user,reportId:report._id,viewedAt:at},opts(session));
   return{report:{id:String(report._id),createdAt:report.createdAt,reason:report.reason,resolved:report.resolved===true,messageId:String(report.messageId)},messages:await messageDTO(rows,actor,session)};},true),
  resolve:(actor,id)=>tx(actor,async(session,at)=>{const row=await c('pmReports').findOne({_id:oid(pmId(id))},opts(session));if(!row)throw pmError('NOT_FOUND',404);
   await c('pmReports').updateOne({_id:row._id},{$set:{resolved:true}},opts(session));await c('pmAudits').insertOne({reviewerId:actor.user,reportId:row._id,viewedAt:at},opts(session));return{resolved:true};},true),
 };
}
