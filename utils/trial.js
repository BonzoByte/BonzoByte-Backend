export function grantInitialTrialIfMissing(user, days = 7) {
    // ako već ima trial (aktivan ili istekao) -> ne diraj
    if (user?.trial?.endsAt) return false;
  
    const now = new Date();
    user.trial = {
      endsAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
      grantedDaysTotal: days,
      lastGrantedAt: now,
    };
  
    // ads: metapodatak (stvarna odluka ide preko entitlements)
    user.ads = user.ads || { enabled: true, disabledReason: 'manual' };
    user.ads.disabledReason = 'trial';
  
    return true;
  }  