import {PRIVATE_MESSAGE_COLLECTIONS} from '../models/privateMessages.model.js';
/** Inside the same user-fenced erasure transaction. No retained message snapshots. */
export async function erasePrivateMessages(connection,userId,session,names=PRIVATE_MESSAGE_COLLECTIONS){
 const c=key=>connection.collection(names[key]),options={session};
 const owned=await c('pmConversations').find({participants:userId},options).toArray(),ids=owned.map(row=>row._id);
 await c('pmMessages').updateMany({senderId:userId},{$set:{body:'',deleted:true},$unset:{senderId:'',clientRequestId:'',requestHash:''}},options);
 await c('pmReports').deleteMany({$or:[{reporterId:userId},{authorId:userId}]},options);
 await c('pmAudits').deleteMany({reviewerId:userId},options);
 await c('pmConversations').updateMany({_id:{$in:ids}},{$set:{status:'closed'},$pull:{participants:userId},$unset:{pairKey:'',initiatorId:''}},options);
 await c('pmStates').deleteMany({userId},options);
 await c('pmStates').updateMany({conversationId:{$in:ids}},{$set:{inboxUnread:false},$unset:{otherUserId:''}},options);
 await c('pmBlocks').deleteMany({$or:[{ownerId:userId},{targetId:userId}]},options);
 await c('pmPairs').deleteMany({members:userId},options);
 await c('pmSettings').deleteMany({_id:userId},options);await c('pmRates').deleteMany({_id:userId},options);
}
