import transporter from './mailer.js';
import { env } from '../config/env.js';
const FRONTEND_URL = env.FRONTEND_URL || 'http://localhost:4200';

export default async function sendVerificationEmail(toEmail, user, token) {
  const verifyUrl = `${FRONTEND_URL}/verify?token=${encodeURIComponent(token)}`;

  await transporter.sendMail({
    to: toEmail,
    from: `"BonzoByte" <${env.EMAIL_USER || 'noreply@bonzobyte.com'}>`,
    subject: 'Verify your email',
    text: `Hi ${user?.name || ''}\n\nClick to verify: ${verifyUrl}`,
    html: `
      <p>Hi ${user?.name || ''},</p>
      <p>Click to verify your email:</p>
      <p><a href="${verifyUrl}">Verify my email</a></p>
      <p>Or copy & paste:<br/>
        <code style="word-break:break-all">${verifyUrl}</code>
      </p>
    `,
  });
}