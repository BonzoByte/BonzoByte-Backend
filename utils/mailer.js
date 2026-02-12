import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

transporter.verify()
    .then(() => console.log('[MAILER] Transport ready'))
    .catch(err => console.warn('[MAILER] Transport not ready:', err?.message));

export default transporter;