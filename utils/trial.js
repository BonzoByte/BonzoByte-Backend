export function grantInitialTrialIfMissing(user, days = 7) {
    // Never recreate a trial once one has been active or expired.
    if (user?.trial?.endsAt) return false;
  
    const now = new Date();
    user.trial = {
      endsAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
      grantedDaysTotal: days,
      lastGrantedAt: now,
    };
  
    // Ads are metadata only; entitlement rules make the effective access decision.
    user.ads = user.ads || { enabled: true, disabledReason: 'manual' };
    user.ads.disabledReason = 'trial';
  
    return true;
}
