import { evaluateMembershipTimeline, liveMembershipLedger } from './paidMembership.js';
const time=value=>new Date(value??NaN).getTime();
export const earnedEnvironment=()=>process.env.NODE_ENV==='production'?'production':'development';
export function evaluateEarnedMembership(user,now,{allowSandbox=false,environment=earnedEnvironment()}={}){
    const earned=user?.earnedMembership;
    if(earned?.version!==1||earned.environment!==environment||!Array.isArray(earned.grants)||!earned.grants.length
        ||!Number.isFinite(time(earned.baselineAt))||time(earned.baselineAt)>+now)return null;
    const billing=liveMembershipLedger(user)??(allowSandbox&&user.billingMembership?.version===1&&user.billingMembership.environment==='sandbox'?user.billingMembership:null);
    const base=billing&&time(billing.baselineAt)<=time(earned.baselineAt)?billing:earned;
    const grants=[...(billing?.grants||[]),...earned.grants.map(g=>({paymentId:'earned:'+g.awardId,paidAt:g.grantedAt,durationMs:g.durationMs,revokedAt:g.revokedAt}))];
    const subscription=user.subscription;
    if(!billing&&subscription?.status==='active'&&!subscription.isLifetime&&time(subscription.validUntil)>time(base.baselineAt))
        grants.push({paymentId:'legacy-subscription',paidAt:base.baselineAt,durationMs:time(subscription.validUntil)-time(base.baselineAt)});
    return evaluateMembershipTimeline({version:1,baselineAt:base.baselineAt,baselineTrialMs:base.baselineTrialMs,
        trialCredits:[...(billing?.trialCredits||[]),...(earned.trialCredits||[])],grants},now);
}
