import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import { communityModels, COMMUNITY_COLLECTIONS as names } from '../models/community.model.js';
import { DISCUSSION_COLLECTIONS as match } from '../models/discussion.model.js';
import { createCommunity, communityEditInput, eraseCommunity } from '../utils/community.js';
import { createDiscussionStore } from '../utils/discussionStore.js';
import { communityFollowingPipeline } from '../utils/communityFollowing.js';
import { createCommunityRouter } from '../routes/community.routes.js';
import { communityModerator } from '../utils/communityPolicy.js';
import User from '../models/user.model.js';

test('edit input is strict plain text and requires a bounded optimistic revision', () => {
    assert.deepEqual(communityEditInput({body:'  Corrected\r\ntext  ',version:0}),{body:'Corrected\ntext',version:0});
    for(const bad of [{body:'x'},{body:'x',version:-1},{body:'x',version:1.1},{body:'x',version:'0'},
        {body:'x',version:1000000001},{body:'',version:0},{body:'<b>x</b>',version:0},{body:'x'.repeat(1001),version:0},
        {body:'x',version:0,userId:'forged'},{body:'x',version:0,hidden:false}]) assert.throws(()=>communityEditInput(bad));
});

test('Mongo/JWT: own visible forum edits, replay, conflict, rate limits and erasure',
    {skip:!process.env.COMMUNITY_TEST_MONGO,timeout:180000},async()=>{
    const database=`BonzoByte_Community_Test_${randomUUID().replaceAll('-','').slice(0,12)}`,nonce=randomUUID();
    let server,guarded=false,clock=new Date();
    Object.assign(process.env,{JWT_SECRET:randomUUID(),APP_STAGE:'development',NODE_ENV:'test',COMMUNITY_OWNER_MODERATION:'true',FRONTEND_URL:'http://localhost:4206'});
    try{
        await mongoose.connect(process.env.COMMUNITY_TEST_MONGO,{dbName:database,maxPoolSize:10,serverSelectionTimeoutMS:15000});
        const connection=mongoose.connection;
        assert.equal((await connection.db.listCollections().toArray()).length,0);
        await connection.collection('_community_test_guard').insertOne({_id:'owner',nonce});guarded=true;
        const store=createDiscussionStore({connection,User,names,models:communityModels,now:()=>clock,canModerate:communityModerator,followingPipeline:communityFollowingPipeline});
        await store.initialize(); const service=createCommunity({connection,store});
        const ids=Array.from({length:4},()=>new mongoose.Types.ObjectId());
        await User.collection.insertMany(ids.map((_id,n)=>({_id,nickname:`Edit fixture ${n}`,email:n===0?'horvat.stanko@gmail.com':`edit${n}@example.invalid`,
            tokenVersion:0,isVerified:n!==2,isAdmin:n===3})));
        const tokens=ids.map(id=>jwt.sign({id:String(id),tv:0},process.env.JWT_SECRET,{expiresIn:'10m'}));
        const app=express();app.use('/api/community',createCommunityRouter({service,enabled:()=>true,limits:{ip:1000}}));
        server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
        const base=`http://127.0.0.1:${server.address().port}/api/community`;
        const call=async(path,method='GET',body,user=1)=>{
            const res=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(user===null?{}:{Authorization:'Bearer '+tokens[user]})},...(body?{body:JSON.stringify(body)}:{})});
            return {status:res.status,data:await res.json()};
        };
        const created=await call('/topics','POST',{title:'Editable topic',category:'play',language:'en',body:'Original post',clientRequestId:randomUUID()});
        assert.equal(created.status,200);const topic=created.data.topic.id;
        let page=(await call(`/topics/${topic}`)).data;const first=page.comments[0].id;
        const payload={body:'Corrected post',version:0},endpoint=`/comments/${first}`;
        assert.equal((await call(endpoint,'PATCH',payload,null)).status,401);
        assert.equal((await call(endpoint,'PATCH',payload,0)).status,403,'moderator cannot edit another author');
        assert.equal((await call(endpoint,'PATCH',payload,3)).status,403,'administrator cannot edit another author');
        assert.equal((await call(endpoint,'PATCH',payload,2)).status,403);
        assert.equal((await call(endpoint,'PATCH',{...payload,isAdmin:true})).status,400);
        const unchanged=await call(endpoint,'PATCH',{body:'Original post',version:0});assert.equal(unchanged.data.comment.editedAt,null);
        await call(`/topics/${topic}/follow`,'PUT',{following:true},0);
        clock=new Date(+clock+6000);
        const reply=await call(`/topics/${topic}`,'POST',{body:'Reply referencing original',replyToId:first,clientRequestId:randomUUID()},0);
        assert.equal(reply.status,200);
        const stateBefore=await connection.collection(names.states).find({}).sort({_id:1}).toArray();
        const threadBefore=await connection.collection(names.threads).findOne({_id:topic});
        const countBefore=await connection.collection(names.comments).countDocuments({});
        const edited=await call(endpoint,'PATCH',payload);assert.equal(edited.status,200);
        assert.equal(edited.data.comment.editVersion,1);assert.equal(edited.data.comment.body,payload.body);
        assert.equal((await call(endpoint,'PATCH',payload)).data.comment.editedAt,edited.data.comment.editedAt,'lost-response retry is idempotent');
        assert.equal((await call(endpoint,'PATCH',{body:'Stale overwrite',version:0})).status,409);
        assert.equal((await call(endpoint,'PATCH',{body:'Too fast',version:1})).status,429);
        assert.deepEqual(await connection.collection(names.states).find({}).sort({_id:1}).toArray(),stateBefore);
        const threadAfter=await connection.collection(names.threads).findOne({_id:topic});delete threadAfter.editFence;
        assert.deepEqual(threadAfter,threadBefore,'editing never bumps topic activity/sequence');
        assert.equal(await connection.collection(names.comments).countDocuments({}),countBefore);
        page=(await call(`/topics/${topic}`,'GET',undefined,null)).data;
        assert.equal(page.comments[0].editedAt,edited.data.comment.editedAt);assert.equal(page.comments[0].createdAt,threadBefore.createdAt.toISOString());
        assert.equal(page.comments[1].replyTo.body,payload.body);assert.equal(page.comments[1].replyTo.editedAt,edited.data.comment.editedAt);
        clock=new Date(+clock+6000);
        const race=await Promise.all([call(endpoint,'PATCH',{body:'Tab A',version:1}),call(endpoint,'PATCH',{body:'Tab B',version:1})]);
        assert.deepEqual(race.map(x=>x.status).sort(),[200,409]);
        const current=await connection.collection(names.comments).findOne({_id:new mongoose.Types.ObjectId(first)});
        await call(`/comments/${first}/hide`,'POST',{hidden:true},0);
        assert.equal((await call(endpoint,'PATCH',{body:'Cannot undo moderation',version:2})).status,404);
        page=(await call(`/topics/${topic}`,'GET',undefined,null)).data;
        assert.equal(page.comments[0].body,'');assert.equal(page.comments[0].editedAt,undefined);assert.equal(page.comments[1].replyTo.body,null);
        await call(`/comments/${first}/hide`,'POST',{hidden:false},0);
        await User.collection.updateOne({_id:ids[1]},{$set:{isVerified:false}});
        assert.equal((await call(endpoint,'PATCH',{body:'Unverified author',version:2})).status,403);
        await User.collection.updateOne({_id:ids[1]},{$set:{isVerified:true}});
        clock=new Date(+clock+6000);
        const disposable=await call(`/topics/${topic}`,'POST',{body:'Remove this comment',clientRequestId:randomUUID()});
        assert.equal(disposable.status,200);
        await call(`/comments/${disposable.data.comment.id}`,'DELETE');
        assert.equal((await call(`/comments/${disposable.data.comment.id}`,'PATCH',{body:'Deleted comment',version:0})).status,404);
        const moderatorOwn=await call(`/comments/${reply.data.comment.id}`,'PATCH',{body:'Moderator can edit their own reply',version:0},0);
        assert.equal(moderatorOwn.status,200);
        await User.collection.updateOne({_id:ids[1]},{$set:{accountClosure:{requestedAt:clock}}});
        assert.equal((await call(endpoint,'PATCH',{body:'Closing account',version:2})).status,401);
        await User.collection.updateOne({_id:ids[1]},{$unset:{accountClosure:''}});
        clock=new Date(+clock+6000);
        await call(`/topics/${topic}`,'DELETE',undefined,0);
        assert.equal((await call(endpoint,'PATCH',{body:'Removed topic',version:2})).status,404);
        await connection.transaction(session=>eraseCommunity(connection,ids[1],session));
        const erased=await connection.collection(names.comments).findOne({_id:current._id});
        assert.equal(erased.body,'');assert.equal(erased.userId,undefined);assert.equal(erased.requestHash,undefined);
        assert.equal(await connection.collection(names.spam).countDocuments({_id:ids[1]}),0);
        assert.equal(await connection.collection(match.comments).countDocuments({}),0,'canonical match comments are unchanged');
    }finally{
        if(server)await new Promise(resolve=>server.close(resolve));
        if(guarded){const db=mongoose.connection.db;assert.match(db.databaseName,/^BonzoByte_Community_Test_[a-f0-9]{12}$/);
            assert.equal((await db.collection('_community_test_guard').findOne({_id:'owner'}))?.nonce,nonce);
            const allowed=new Set(['_community_test_guard','users',...Object.values(names),...Object.values(match)]);
            for(const collection of await db.listCollections().toArray())assert.ok(allowed.has(collection.name));
            await db.dropDatabase();}
        await mongoose.disconnect();
    }
});
