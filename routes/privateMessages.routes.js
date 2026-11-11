import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/auth.middleware.js';
import User from '../models/user.model.js';
import {beginAccountOperation} from '../utils/accountOperation.js';
import {DISCUSSION_JSON_LIMIT} from '../utils/discussionText.js';
import {pmError,pmId,pmObject,pmBody,pmPage} from '../utils/privateMessages.js';
export const privateMessagesHeaders=(_req,res,next)=>{res.set('Cache-Control','private, no-store');res.vary('Authorization');next();};
export const privateMessagesJsonError=(error,_req,res,next)=>['entity.parse.failed','entity.too.large'].includes(error.type)
 ?res.status(error.type==='entity.too.large'?413:400).json({code:'PM_INVALID'}):next(error);
async function lease(req,res){if(req.accountOperation)return;const claim={method:'POST',baseUrl:req.baseUrl,path:req.path};
 if(!await beginAccountOperation(User,claim,res,req.user._id,req.user.tokenVersion??0))throw pmError('AUTH_REQUIRED',401);req.accountOperation=claim.accountOperation;}
export function createPrivateMessagesRouter({service,auth=protect,readLease=lease,notify=()=>{}}){
 const router=express.Router();router.use(privateMessagesHeaders);
 router.use(rateLimit({windowMs:60000,max:240,standardHeaders:true,legacyHeaders:false,message:{code:'PM_RATE_LIMIT'}}));
 router.use(express.json({limit:DISCUSSION_JSON_LIMIT}),privateMessagesJsonError);
 router.use((req,res,next)=>req.method==='HEAD'?res.set('Allow','GET').status(405).end():next());
 router.use(auth,rateLimit({windowMs:60000,max:120,standardHeaders:true,legacyHeaders:false,keyGenerator:req=>String(req.user._id),message:{code:'PM_RATE_LIMIT'}}));
 const actor=req=>({user:req.user._id,tokenVersion:req.user.tokenVersion??0,operation:req.accountOperation});
 const activity=(kind,conversation=false)=>(req,value)=>({kind,actor:String(req.user._id),id:conversation?value?.conversation?.id:req.params.id});
 const run=(validate,fn,signal)=>async(req,res)=>{try{validate(req);if(['GET','HEAD'].includes(req.method))await readLease(req,res);if(res.writableEnded||res.destroyed)return;
  const value=await fn(actor(req),req);if(!res.headersSent&&!res.destroyed)res.json(value);
  if(signal){try{void Promise.resolve(notify(signal(req,value))).catch(()=>{});}catch{}}
 }catch(error){const known=/^PM_/.test(error.code??'')&&[400,401,403,404,409,429,503].includes(error.status);
  if(known&&error.status===429)res.set('Retry-After','60');if(!res.headersSent&&!res.destroyed)res.status(known?error.status:503).json({code:known?error.code:'PM_UNAVAILABLE'});}};
 const empty=req=>{if(Object.keys(req.query).length)throw pmError('INVALID');};
 const id=req=>{empty(req);pmId(req.params.id);};
 const bool=(req,key)=>{pmObject(req.body,[key],[key]);if(typeof req.body[key]!=='boolean')throw pmError('INVALID');};
 const after=req=>{if(Object.keys(req.query).some(k=>!['after','limit'].includes(k))||(req.query.limit!==undefined&&req.query.limit!=='20'))throw pmError('INVALID');if(req.query.after!==undefined)pmId(req.query.after);};
 router.get('/summary',run(empty,a=>service.summary(a)));
 router.get('/settings',run(empty,a=>service.settings(a)));
 router.put('/settings',run(req=>{empty(req);bool(req,'requestsEnabled');},(a,r)=>service.setSettings(a,r.body.requestsEnabled),activity('private-actor')));
 router.get('/targets/:id',run(id,(a,r)=>service.target(a,r.params.id)));
 router.get('/inbox',run(req=>{req.page=pmPage(req.query,true);},(a,r)=>service.inbox(a,r.page)));
 router.post('/requests',run(req=>{empty(req);pmBody(req.body,true);},(a,r)=>service.request(a,r.body),activity('private-conversation',true)));
 router.get('/conversations/:id',run(req=>{pmId(req.params.id);req.page=pmPage(req.query);},(a,r)=>service.conversation(a,r.params.id,r.page)));
 router.post('/conversations/:id/messages',run(req=>{id(req);pmBody(req.body);},(a,r)=>service.send(a,r.params.id,r.body),activity('private-conversation')));
 router.put('/conversations/:id/decision',run(req=>{id(req);bool(req,'accept');},(a,r)=>service.decision(a,r.params.id,r.body.accept),activity('private-conversation')));
 router.put('/conversations/:id/read',run(req=>{id(req);pmObject(req.body,['through'],['through']);if(!Number.isSafeInteger(req.body.through)||req.body.through<0)throw pmError('INVALID');},(a,r)=>service.read(a,r.params.id,r.body.through),activity('private-actor')));
 router.put('/users/:id/block',run(req=>{id(req);bool(req,'blocked');},(a,r)=>service.block(a,r.params.id,r.body.blocked),activity('private-block')));
 router.get('/blocked',run(after,(a,r)=>service.blocked(a,r.query.after)));
 router.delete('/messages/:id',run(req=>{id(req);if(req.body!==undefined)pmObject(req.body,[]);},(a,r)=>service.remove(a,r.params.id),activity('private-message')));
 router.post('/messages/:id/report',run(req=>{id(req);pmObject(req.body,['reason']);if(req.body.reason!==undefined&&typeof req.body.reason!=='string')throw pmError('INVALID');},(a,r)=>service.report(a,r.params.id,r.body.reason)));
 router.get('/reports',run(after,(a,r)=>service.reports(a,r.query.after)));
 router.get('/reports/:id',run(id,(a,r)=>service.review(a,r.params.id)));
 router.post('/reports/:id/resolve',run(req=>{id(req);pmObject(req.body,[]);},(a,r)=>service.resolve(a,r.params.id)));
 return router;
}
