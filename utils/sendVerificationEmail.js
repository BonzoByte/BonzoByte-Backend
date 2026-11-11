// utils/sendVerificationEmail.js
import { env } from '../config/env.js';
import transporter from './mailer.js';
import { verificationEmailContent } from './verificationEmailContent.js';

export default async function sendVerificationEmail(toEmail, user, challenge) {
  const FRONTEND_URL = env.FRONTEND_URL || 'http://localhost:4200';

  const to = String(toEmail || '').trim();
  if (!to) throw new Error('MAIL_TO_MISSING');

  const { subject, text, html } = verificationEmailContent(user?.name, challenge, FRONTEND_URL);

  try {
    const resp = await transporter.sendMail({
      to,
      channel: 'accounts',
      subject,
      text,
      html,
    });

    return resp;
  } catch (err) {
    console.warn('[MAIL] verification delivery failed');
    throw err;
  }
}
