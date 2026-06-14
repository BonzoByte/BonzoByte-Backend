import transporter from './mailer.js';
import { env } from '../config/env.js';

const sendResetPasswordEmail = async (email, token) => {
    const base = env.FRONTEND_URL || 'http://localhost:4200';
    const normalizedBase = base.replace(/\/+$/, '');
    const link = `${normalizedBase}/reset-password#token=${encodeURIComponent(token)}`;

    await transporter.sendMail({
        from: `"BonzoByte" <${env.EMAIL_USER || 'noreply@bonzobyte.com'}>`,
        to: email,
        subject: 'Reset your password',
        html: `
      <h3>Password reset</h3>
      <p>Click the link to reset your password:</p>
      <p><a href="${link}">${link}</a></p>
      <p>If you didn't request this, you can ignore this email.</p>
    `
    });
};

export default sendResetPasswordEmail;
