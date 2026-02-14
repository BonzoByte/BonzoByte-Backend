export const BILLING_PLANS = {
    monthly: { priceEur: 4, durationDays: 30 },
    semiannual: { priceEur: 18, durationDays: 182 }, // ili 180
    annual: { priceEur: 24, durationDays: 365 },
    daily: {priceEur: 0.20, durationDays: 1},
    founders: { priceEur: 100, durationDays: null, lifetime: true, limit: 100 },
};  