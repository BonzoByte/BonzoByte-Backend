import transporter from './mailer.js';

const sendResetPasswordEmail = async (email, token) => {
    const base = process.env.FRONTEND_URL || 'http://localhost:4200';
    const link = `${base}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email).replace(/&/g, '&amp;')}`;

    await transporter.sendMail({
        from: `"BonzoByte" <${process.env.EMAIL_USER || 'noreply@bonzobyte.com'}>`,
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