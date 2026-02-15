// utils/sendVerificationEmail.js
import { env } from '../config/env.js';
import transporter from './mailer.js';

export default async function sendVerificationEmail(toEmail, user, token) {
  const FRONTEND_URL = env.FRONTEND_URL || 'http://localhost:4200';
  const verifyUrl = `${FRONTEND_URL}/verify?token=${encodeURIComponent(token)}`;

  const to = String(toEmail || '').trim();
  if (!to) throw new Error('MAIL_TO_MISSING');

  const fromAddress =
    env.EMAIL_FROM ||
    process.env.EMAIL_FROM ||
    process.env.EMAIL_USER || // fallback
    'noreply@example.com';    // last resort (ali bolje postavi EMAIL_FROM)

  const fromName = env.EMAIL_FROM_NAME || process.env.EMAIL_FROM_NAME || 'BonzoByte';
  const from = `${fromName} <${fromAddress}>`;

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

  console.log('[MAIL] verification sending to:', to);

  try {
    const resp = await transporter.sendMail({
      to,
      from,
      replyTo: fromAddress, // optional
      subject,
      text,
      html,
    });

    console.log('[MAIL] verification sent:', resp?.messageId || resp?.response || 'OK');
    return resp;
  } catch (err) {
    console.warn('[MAIL] verification failed:', err?.code || err?.message || err);
    throw err;
  }
}