// utils/sendVerificationEmail.js
import transporter from './mailer.js'; // prilagodi putanju ako ti je drugdje
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4200';

export default async function sendVerificationEmail(toEmail, user, token) {
    // obavezno dodaj token u query string
    const verifyUrl = `${FRONTEND_URL}/verify?token=${encodeURIComponent(token)}`;

    // privremeni log za provjeru
    console.log('[VERIFY LINK]', verifyUrl);

    await transporter.sendMail({
        to: toEmail,
        from: `"BonzoByte" <${process.env.SMTP_USER}>`,
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