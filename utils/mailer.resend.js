// utils/mailer.resend.js
import { Resend } from 'resend';
import { env } from '../config/env.js';

const apiKey = env.RESEND_API_KEY || process.env.RESEND_API_KEY;
if (!apiKey) {
    console.warn('[MAILER] RESEND_API_KEY missing. Emails will fail.');
}

export const resend = apiKey ? new Resend(apiKey) : null;

export async function sendMail({ to, subject, text, html, from, replyTo }) {
    if (!resend) {
        throw new Error('RESEND_NOT_CONFIGURED');
    }

    const FROM =
        from ||
        env.EMAIL_FROM ||
        process.env.EMAIL_FROM ||
        'onboarding@resend.dev';

    const REPLY_TO =
        replyTo ||
        env.EMAIL_REPLY_TO ||
        process.env.EMAIL_REPLY_TO ||
        undefined;

    const payload = {
        from: FROM,
        to: Array.isArray(to) ? to : [to],
        subject,
        text,
        html,
        ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
    };

    const { data, error } = await resend.emails.send(payload);

    if (error) {
        const msg = error?.message || 'RESEND_SEND_FAILED';
        throw new Error(msg);
    }

    return data;
}