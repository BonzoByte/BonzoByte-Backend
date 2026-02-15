import transporter from './mailer.js';
import { env } from '../config/env.js';

export default async function sendVerificationEmail(toEmail, user, token) {
  const frontendUrl = env.FRONTEND_URL || 'http://localhost:4200';
  const verifyUrl = `${frontendUrl}/verify?token=${encodeURIComponent(token)}`;

  // ✅ From MUST match SMTP account (anti-spoof / DMARC)
  const fromAddress = env.EMAIL_USER; // npr. tvoj Gmail ili pravi SMTP user
  if (!fromAddress) {
    throw new Error('[MAIL] EMAIL_USER is missing (cannot send verification email).');
  }

  const info = await transporter.sendMail({
    to: toEmail,
    from: `"BonzoByte" <${fromAddress}>`,
    replyTo: `"BonzoByte" <${fromAddress}>`,
    subject: 'Verify your email',
    text: `Hi ${user?.name || ''}\n\nClick to verify: ${verifyUrl}`,
    html: `
      <p>Hi ${user?.name || ''},</p>
      <p>Click to verify your email:</p>
      <p><a href="${verifyUrl}">Verify my email</a></p>
      <p>Or copy & paste:<br/>
        <code style="word-break:break-all">${verifyUrl}</code>
      </p>`,
  });

  console.log('[MAIL] Verification sent', {
    to: toEmail,
    messageId: info?.messageId,
    accepted: info?.accepted,
    rejected: info?.rejected,
  });

  return info;
}