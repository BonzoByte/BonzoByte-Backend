import nodemailer from 'nodemailer';
import { createResendTransport } from './mailer.resend.js';
import { createSenderRouting } from './mailRouting.js';

const value = input => String(input ?? '').trim();
const enabledFlag = input => ['1', 'true'].includes(value(input).toLowerCase());
const mailbox = input => {
    const text = value(input);
    if (/[\r\n]/.test(text)) return '';
    const address = text.match(/^[^<>]*<([^<>]+)>$/)?.[1] ?? text;
    return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) ? text : '';
};
const mailError = (code, message) => Object.assign(new Error(message), { code });

export function createMailTransport(settings, dependencies = {}) {
    const provider = value(settings.EMAIL_PROVIDER) || 'smtp';
    if (!['smtp', 'resend'].includes(provider)) throw mailError('MAIL_PROVIDER_INVALID', 'Unknown mail provider.');
    const address = value(settings.EMAIL_FROM) || (provider === 'smtp' ? value(settings.EMAIL_USER) : '');
    const name = value(settings.EMAIL_FROM_NAME) || 'BonzoByte';
    const from = mailbox(address) && !/[\r\n<>]/.test(name)
        ? (address.includes('<') ? address : `${JSON.stringify(name)} <${address}>`) : '';
    const replyTo = value(settings.EMAIL_REPLY_TO);
    const disabled = enabledFlag(settings.EMAIL_DISABLED);
    const credentialsPresent = provider === 'resend' ? !!value(settings.RESEND_API_KEY)
        : !!value(settings.EMAIL_USER) && !!value(settings.EMAIL_PASS);
    const isConfigured = !disabled && credentialsPresent && !!from && (!replyTo || !!mailbox(replyTo));
    const routing = createSenderRouting(settings, from, provider);
    let transport;

    function prepareMail(mail) {
        if (!from) throw mailError('MAIL_NOT_CONFIGURED', 'Email sender is not configured.');
        const channel = mail.channel ?? 'info';
        const selectedFrom = routing.senderFor(channel);
        const to = (Array.isArray(mail.to) ? mail.to : [mail.to]).map(mailbox);
        const reply = mail.replyTo === undefined ? replyTo : value(mail.replyTo);
        if (!to.length || to.some(address => !address) || (reply && !mailbox(reply)))
            throw mailError('MAIL_ADDRESS_INVALID', 'Invalid mail address.');
        if (!value(mail.subject) || /[\r\n]/.test(mail.subject))
            throw mailError('MAIL_SUBJECT_INVALID', 'Invalid mail subject.');
        return { to, from: selectedFrom, subject: mail.subject, text: mail.text, html: mail.html,
            ...(routing.enabled ? { channel } : {}),
            ...(reply ? { replyTo: reply } : {}) };
    }

    return {
        provider, from, isConfigured, prepareMail, senderFor: routing.senderFor, routingEnabled: routing.enabled,
        async sendMail(mail, options = {}) {
            if (disabled) throw mailError('MAIL_DISABLED', 'Email delivery is disabled.');
            if (!isConfigured) throw mailError('MAIL_NOT_CONFIGURED', 'Email delivery is not configured.');
            if (options.idempotencyKey !== undefined && (provider !== 'resend'
                || !/^[A-Za-z0-9/_-]{1,256}$/.test(options.idempotencyKey)))
                throw mailError('MAIL_IDEMPOTENCY_INVALID', 'Idempotent delivery requires Resend and a valid key.');

            // Resolve only server-owned channels, never a message's arbitrary From.
            const payload = prepareMail(mail);
            if (options.expectedFrom !== undefined && options.expectedFrom !== payload.from)
                throw mailError('MAIL_SENDER_CHANGED', 'Queued sender configuration changed.');
            try {
                transport ??= provider === 'resend'
                    ? createResendTransport(value(settings.RESEND_API_KEY), dependencies.createResendClient)
                    : (dependencies.createSmtpTransport ?? nodemailer.createTransport)({
                        host: value(settings.SMTP_HOST) || 'smtp.gmail.com',
                        port: Number(settings.SMTP_PORT || 587),
                        secure: enabledFlag(settings.SMTP_SECURE),
                        auth: { user: value(settings.EMAIL_USER), pass: settings.EMAIL_PASS },
                        connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000,
                    });
                // Nodemailer's second argument is a callback, not SDK options.
                const result = provider === 'resend' ? await transport.sendMail(payload, options)
                    : await transport.sendMail(payload);
                if (!result?.messageId || !result.accepted?.length || result.rejected?.length)
                    throw mailError('MAIL_DELIVERY_FAILED', 'Mail provider did not confirm acceptance.');
                return { messageId: result.messageId, accepted: result.accepted, rejected: [], provider };
            } catch (error) {
                // No retry or provider fallback: a timeout may occur AFTER acceptance.
                // Do not log/return raw SDK/SMTP errors, credentials or message bodies.
                const failure = mailError('MAIL_DELIVERY_FAILED', 'Mail provider did not confirm acceptance.');
                if (Number.isInteger(error?.statusCode)) failure.statusCode = error.statusCode;
                if (['invalid_idempotent_request', 'concurrent_idempotent_requests'].includes(error?.providerCode))
                    failure.providerCode = error.providerCode;
                throw failure;
            }
        },
    };
}
