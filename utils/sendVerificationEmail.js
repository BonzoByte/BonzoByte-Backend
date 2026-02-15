import transporter from './mailer.js';

export default async function sendVerificationEmail(toEmail, user, token) {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4200';
  const fromEmail = process.env.EMAIL_USER || 'noreply@bonzobyte.com';

  const verifyUrl = `${FRONTEND_URL}/verify?token=${encodeURIComponent(token)}`;

  console.log('[MAIL] sending verification to', toEmail);
  await transporter.sendMail({
    to: toEmail,
    from: `"BonzoByte" <${fromEmail}>`,
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
  console.log('[MAIL] verification sent to', toEmail);
}