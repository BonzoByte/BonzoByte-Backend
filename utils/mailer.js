import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const hasCreds = Boolean(env.EMAIL_USER && env.EMAIL_PASS);

const transporter = hasCreds
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT || 465),
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : true,
        auth: {
            user: env.EMAIL_USER,
            pass: env.EMAIL_PASS,
        },
        // ✅ da ne visi vječno
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
    })
    : {
        async sendMail() {
            throw new Error('[MAIL] SMTP credentials missing (EMAIL_USER/EMAIL_PASS).');
        },
        async verify() {
            throw new Error('[MAIL] SMTP credentials missing (EMAIL_USER/EMAIL_PASS).');
        },
    };

Promise.resolve()
    .then(() => transporter.verify())
    .then(() => console.log('[MAILER] Transport ready'))
    .catch((err) => console.warn('[MAILER] Transport not ready:', err?.message));

export default transporter;