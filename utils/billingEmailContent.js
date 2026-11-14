const labels = { daily: 'Daily Pass', monthly: 'Monthly', semiannual: '6 months', annual: 'Annual' };
const escapeHtml = value => String(value).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace(/\.\d{3}Z$/, ' UTC');

// The frozen environment-specific receipt remains truthful after later membership changes.
export function billingEmailContent(kind, payment, rights, at) {
    if (!['purchase', 'refund'].includes(kind) || !Object.hasOwn(labels, payment.plan)
        || !['sandbox', 'live'].includes(payment.environment) || !/^\d+\.\d{2}$/.test(payment.amount)
        || payment.currency !== 'EUR' || !Number.isInteger(payment.durationDays))
        throw new Error('Invalid billing notification snapshot');
    const purchase = kind === 'purchase';
    const live = payment.environment === 'live';
    const title = purchase ? 'Payment confirmed' : 'Refund confirmed';
    const lines = [
        ...(live ? [] : ['SANDBOX — test money only. No real money was transferred.']),
        purchase ? 'Your BonzoByte payment has been confirmed.' : 'PayPal has confirmed the full refund of this BonzoByte payment.',
        `Plan: ${labels[payment.plan]}`,
        `${purchase ? 'Paid' : 'Refunded'}: EUR ${payment.amount}${live ? '' : ' (sandbox money)'}`,
        `Payment reference: ${payment.orderId}`,
        `Confirmation recorded: ${date(at)}`,
    ];
    if (purchase) {
        lines.push(`Purchased access: ${payment.durationDays} ${payment.durationDays === 1 ? 'day' : 'days'}. This is a one-time purchase, with no automatic renewal.`);
        if (rights.subscriptionEndsAt) lines.push(`Premium end at confirmation: ${date(rights.subscriptionEndsAt)}`);
        if (rights.tier === 'premium' && rights.trialRemainingMs > 0) {
            const minutes = Math.ceil(rights.trialRemainingMs / 60000);
            lines.push(`Saved trial at confirmation: ${Math.floor(minutes / 1440)} days, ${Math.floor(minutes % 1440 / 60)} hours, ${minutes % 60} minutes. Remaining trial resumes when Premium ends.`);
        }
    } else {
        lines.push('Access from this payment has been removed. Other purchases and unused trial time are preserved.');
        const tier = { premium: 'Premium', trial: 'Trial', standard: 'Standard', vip: 'VIP', admin: 'Administrator' }[rights.tier] || 'Unchanged';
        lines.push(`Membership at confirmation: ${tier}.`);
    }
    lines.push(live ? 'This is a payment confirmation, not a tax invoice. Your current membership is shown in BonzoByte.'
        : 'This is a test confirmation, not an invoice. Your current membership is shown in BonzoByte.');
    return {
        subject: `BonzoByte — ${title.toLowerCase()}${live ? '' : ' (sandbox)'}`,
        text: [title, '', ...lines].join('\n\n'),
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;line-height:1.5"><h1>${title}</h1>${lines.map(line => `<p>${escapeHtml(line)}</p>`).join('')}</div>`,
    };
}
