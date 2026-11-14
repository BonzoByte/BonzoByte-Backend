import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/auth.middleware.js';
import { monthBounds } from '../utils/fantasyPolicy.js';
export const fantasyHeaders=(_req,res,next)=>{res.set('Cache-Control','private, no-store');res.vary('Authorization');next();};
export function fantasyJsonError(error,_req,res,next){
    if(['entity.too.large','entity.parse.failed'].includes(error.type))return res.status(error.type==='entity.too.large'?413:400).json({code:'FANTASY_INVALID_BODY'});
    next(error);
}
export function createFantasyRouter({store,auth=protect,available=()=>true}){
    const router=express.Router();router.use(fantasyHeaders);
    router.use(rateLimit({windowMs:60000,max:100,standardHeaders:true,legacyHeaders:false,message:{code:'FANTASY_RATE_LIMIT'}}));
    router.use(express.json({limit:'8kb'}),fantasyJsonError);
    const actor=req=>({user:req.user._id,tokenVersion:req.user.tokenVersion??0,operation:req.accountOperation});
    const handle=fn=>async(req,res)=>{try{
        if(!available())return res.status(503).json({code:'FANTASY_UNAVAILABLE'});
        await fn(req,res);
    }catch(error){const known=/^FANTASY_/.test(error.code||'')&&[400,401,403,404,409,503].includes(error.status);
        if(!res.headersSent)res.status(known?error.status:503).json({code:known?error.code:'FANTASY_UNAVAILABLE'});
    }};
    const month=(req,required=true)=>{const value=req.query.month;if(!required&&value===undefined)return undefined;monthBounds(value);return value;};
    const only=(req,keys)=>{if(Object.keys(req.query).some(k=>!keys.includes(k)))throw Object.assign(Error(),{code:'FANTASY_INVALID_QUERY',status:400});};
    const writeLimit=rateLimit({windowMs:60000,max:15,keyGenerator:req=>String(req.user._id),standardHeaders:true,legacyHeaders:false,message:{code:'FANTASY_RATE_LIMIT'}});
    router.get('/status',handle(async(req,res)=>{only(req,['month']);res.json(await store.status(month(req,false)));}));
    router.get('/players',handle(async(req,res)=>{
        only(req,['month','tour','q','page']);const {tour,q='',page='0'}=req.query;
        if((tour!==undefined&&!['ATP','WTA'].includes(tour))||typeof q!=='string'||q.length>80||typeof page!=='string'||!/^\d{1,3}$/.test(page)||+page>500)
            return res.status(400).json({code:'FANTASY_INVALID_QUERY'});
        res.json(await store.players(month(req),{tour,q,page:+page}));
    }));
    router.get('/leaderboard',handle(async(req,res)=>{only(req,['month']);res.json(await store.board(month(req)));}));
    router.get('/teams/:id',handle(async(req,res)=>{only(req,['month']);if(!/^[a-f0-9-]{36}$/.test(req.params.id))return res.status(400).json({code:'FANTASY_INVALID_QUERY'});res.json(await store.publicTeam(month(req),req.params.id));}));
    router.get('/me',auth,handle(async(req,res)=>{only(req,['month']);res.json(await store.mine(actor(req),month(req)));}));
    router.put('/team',auth,writeLimit,handle(async(req,res)=>{
        only(req,['month']);if(req.user.isVerified!==true)return res.status(403).json({code:'FANTASY_VERIFICATION_REQUIRED'});
        res.json(await store.saveTeam(actor(req),month(req),req.body));
    }));
    return router;
}
