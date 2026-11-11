export const BILLING_PLANS = {
    monthly: { priceEur: 10, durationDays: 30 },
    semiannual: { priceEur: 45, durationDays: 182 },
    annual: { priceEur: 60, durationDays: 365 },
    daily: {priceEur: 0.50, durationDays: 1},
    founders: { priceEur: 100, durationDays: null, lifetime: true, limit: 100 },
};  