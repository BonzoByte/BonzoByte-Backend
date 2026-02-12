export const BILLING_PLANS = {
    monthly: { priceEur: 8, durationDays: 30 },
    semiannual: { priceEur: 36, durationDays: 182 }, // ili 180
    annual: { priceEur: 48, durationDays: 365 },
    founders: { priceEur: 100, durationDays: null, lifetime: true, limit: 100 },
};  