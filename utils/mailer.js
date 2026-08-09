import nodemailer from 'nodemailer';

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true'; // 587 => false, 465 => true

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn('[MAILER] EMAIL_USER/EMAIL_PASS missing. Emails will fail.');
}

const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: EMAIL_USER && EMAIL_PASS ? { user: EMAIL_USER, pass: EMAIL_PASS } : undefined,

    // Keep mail delivery from hanging for 120 seconds.
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 12000,
});

  // Report delivery status without terminating the application.
transporter
    .verify()
    .then(() => console.log('[MAILER] Transport ready'))
    .catch((err) => console.warn('[MAILER] Transport not ready:', err?.message || err));

export default transporter;
