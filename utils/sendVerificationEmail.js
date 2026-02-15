import { env } from '../config/env.js';
import { sendMail } from './mailer.resend.js';

export default async function sendVerificationEmail(toEmail, user, token) {
  const FRONTEND_URL = env.FRONTEND_URL || 'http://localhost:4200';
  const verifyUrl = `${FRONTEND_URL}/verify?token=${encodeURIComponent(token)}`;

  console.log('[MAIL] verification sending to:', toEmail);

  const subject = 'Verify your email';
  const text = `Hi ${user?.name || ''}\n\nClick to verify: ${verifyUrl}`;
  const html = `
    <p>Hi ${user?.name || ''},</p>
    <p>Click to verify your email:</p>
    <p><a href="${verifyUrl}">Verify my email</a></p>
    <p>Or copy &amp; paste:<br/>
      <code style="word-break:break-all">${verifyUrl}</code>
    </p>
  `;

  const resp = await sendMail({
    to: toEmail,
    subject,
    text,
    html,
  });

  console.log('[MAIL] verification sent:', resp?.id || resp);
}