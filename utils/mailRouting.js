// Server-owned sender allowlist. A client-supplied From address is never used.
export const MAIL_CHANNELS = Object.freeze(['contact', 'support', 'accounts', 'billing', 'info']);
const suffixes = Object.freeze({ contact: 'Contact', support: 'Support', accounts: 'Accounts', billing: 'Billing' });
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function createSenderRouting(settings, legacyFrom, provider) {
    const enabled = ['1', 'true'].includes(String(settings.EMAIL_ROUTING_ENABLED ?? '').trim().toLowerCase());
    let senders = {};
    if (enabled) {
        const domain = String(settings.EMAIL_SENDER_DOMAIN ?? '').trim().toLowerCase();
        const address = (legacyFrom.match(/<([^<>]+)>$/)?.[1] ?? legacyFrom).toLowerCase();
        const brand = String(settings.EMAIL_FROM_NAME || 'BonzoByte').trim();
        // Require the already configured info sender on this exact domain.
        // Merely entering a new domain here must not authorize an unrelated sender.
        if (provider !== 'resend' || domain.length > 253
            || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
            || address !== `info@${domain}` || !brand || /[\r\n<>]/.test(brand))
            fail('MAIL_ROUTING_CONFIG_INVALID');
        senders = Object.fromEntries(Object.entries(suffixes)
            .map(([channel, suffix]) => [channel, `${JSON.stringify(brand + ' ' + suffix)} <${channel}@${domain}>`]));
        // Preserve the legacy info sender exactly, including its display name.
        // Existing queued notifications retain the sender stored in their snapshot.
        senders.info = legacyFrom;
        Object.freeze(senders);
    }
    function senderFor(channel = 'info') {
        if (!MAIL_CHANNELS.includes(channel)) fail('MAIL_CHANNEL_INVALID');
        return enabled ? senders[channel] : legacyFrom;
    }
    return Object.freeze({ enabled, senderFor });
}

