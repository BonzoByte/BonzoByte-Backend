import nodemailer from 'nodemailer';

const host = process.env.SMTP_HOST || 'smtp.gmail.com';
const port = Number(process.env.SMTP_PORT || 465);

console.log('[MAILER] host=', process.env.SMTP_HOST, 'port=', process.env.SMTP_PORT, 'secure=', process.env.SMTP_SECURE);

// ako SMTP_SECURE nije eksplicitno setan, default je TRUE samo za 465
const secure =
    typeof process.env.SMTP_SECURE === 'string'
        ? process.env.SMTP_SECURE === 'true'
        : port === 465;

const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },

    // ✅ spriječi da sendMail visi zauvijek (čest problem na hostovima)
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
});

transporter
    .verify()
    .then(() => console.log('[MAILER] Transport ready:', { host, port, secure }))
    .catch((err) => console.warn('[MAILER] Transport not ready:', err?.message || err));

export default transporter;