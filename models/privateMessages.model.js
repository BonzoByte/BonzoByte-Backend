import {Schema,model} from 'mongoose';
export const PRIVATE_MESSAGE_COLLECTIONS=Object.freeze({pmConversations:'pmconversations',pmMessages:'pmmessages',pmStates:'pmstates',
 pmBlocks:'pmblocks',pmSettings:'pmsettings',pmRates:'pmrates',pmReports:'pmreports',pmAudits:'pmaudits',pmPairs:'pmpairs'});
const id=Schema.Types.ObjectId,options={autoIndex:false,autoCreate:false,versionKey:false};
const conversation=new Schema({pairKey:String,participants:[id],initiatorId:id,status:String,lastSequence:Number,lastActivityAt:Date,lastMessageId:id,revision:Number},options);
conversation.index({pairKey:1},{unique:true,partialFilterExpression:{pairKey:{$type:'string'}}});conversation.index({participants:1});
const message=new Schema({conversationId:id,sequence:Number,senderId:id,body:String,createdAt:Date,deleted:Boolean,clientRequestId:String,requestHash:String},options);
message.index({conversationId:1,sequence:1},{unique:true});message.index({senderId:1,clientRequestId:1},{unique:true,partialFilterExpression:{senderId:{$type:'objectId'},clientRequestId:{$type:'string'}}});
message.index({senderId:1});
const state=new Schema({conversationId:id,userId:id,otherUserId:id,readThrough:Number,fetchedThrough:Number,inboxUnread:Boolean,lastActivityAt:Date},options);
state.index({userId:1,conversationId:1},{unique:true});state.index({userId:1,lastActivityAt:-1,conversationId:1});state.index({userId:1,inboxUnread:1});state.index({otherUserId:1});
const block=new Schema({ownerId:id,targetId:id,createdAt:Date},options);block.index({ownerId:1,targetId:1},{unique:true});block.index({targetId:1});
const settings=new Schema({_id:id,requestsEnabled:Boolean,revision:Number},options);
const rates=new Schema({_id:id,requests:[Date],posts:[Date],reports:[Date]},options);
const report=new Schema({conversationId:id,messageId:id,reporterId:id,authorId:id,reason:String,createdAt:Date,resolved:Boolean},options);
report.index({reporterId:1,messageId:1},{unique:true});report.index({authorId:1});
const audit=new Schema({reviewerId:id,reportId:id,viewedAt:Date},options);audit.index({reviewerId:1});
const pair=new Schema({_id:String,members:[id],revision:Number},options);pair.index({members:1});
export const privateMessageModels=[['pmConversations',conversation],['pmMessages',message],['pmStates',state],['pmBlocks',block],
 ['pmSettings',settings],['pmRates',rates],['pmReports',report],['pmAudits',audit],['pmPairs',pair]]
 .map(([key,schema])=>model('PrivateMessages_'+key,schema,PRIVATE_MESSAGE_COLLECTIONS[key]));
