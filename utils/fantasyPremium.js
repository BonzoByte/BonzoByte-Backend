import { evaluateMembership } from './membership.js';
import { sandboxMembershipAllowed, liveMembershipLedger } from './paidMembership.js';
import { earnedEnvironment } from './earnedMembership.js';
import { need } from './fantasyPolicy.js';
export async function grantFantasyPremium(User,{userId,awardId,days,at,session}){
    need(days===30&&typeof awardId==='string'&&/^fantasy:(development|production|test):20\d{2}-\d{2}:[a-f0-9-]{36}$/.test(awardId),'INVALID_AWARD');
    const member=await User.collection.findOne({_id:userId,isVerified:true,'accountClosure.requestedAt':{$exists:false}},{session,maxTimeMS:5000});
    need(member,'AUTH_REQUIRED',401);
    const rights=evaluateMembership(member,at);
    need(!rights.isLifetime&&!member.isAdmin,'VIP_GIFT_REVIEW_REQUIRED',409);
    const environment=earnedEnvironment();
    need(awardId.startsWith(`fantasy:${environment}:`),'REWARD_ENVIRONMENT_MISMATCH',409);
    let state=member.earnedMembership;
    if(state)need(state.version===1&&state.environment===environment,'REWARD_ENVIRONMENT_MISMATCH',409);
    else {
        const billing=liveMembershipLedger(member)??(sandboxMembershipAllowed()&&member.billingMembership?.version===1?member.billingMembership:null);
        state={version:1,environment,baselineAt:billing?.baselineAt??at,baselineTrialMs:billing?.baselineTrialMs??rights.trialRemainingMs,
            trialCredits:[],grants:[]};
    }
    if(state.grants.some(g=>g.awardId===awardId))return {awardId,days:30,alreadyGranted:true};
    need(state.grants.length<1200,'REWARD_LEDGER_LIMIT',409);
    const next={...state,grants:[...state.grants,{awardId,grantedAt:at,durationMs:30*86400000,revokedAt:null}]};
    // This User write is the serialization point shared with paid purchases,
    // referral credits and account closure; the caller owns the Mongo transaction.
    need((await User.collection.updateOne({_id:userId,'accountClosure.requestedAt':{$exists:false}},{$set:{earnedMembership:next}},
        {session,maxTimeMS:5000})).matchedCount,'AUTH_REQUIRED',401);
    const after=evaluateMembership({...member,earnedMembership:next},at);
    return {awardId,days:30,membershipEndsAt:after.membershipEndsAt,savedTrialMs:after.trialRemainingMs};
}
