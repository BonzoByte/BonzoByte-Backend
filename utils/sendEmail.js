import mailer from './mailer.js';

const transporter = mailer;

const sendEmail = async ({ to, subject, html }) => {
  await transporter.sendMail({
    from: `"BonzoByte" <${process.env.EMAIL_USER || 'noreply@bonzobyte.com'}>`,
    to,
    subject,
    html
  });

  console.log('[MAILER] Email poslan na:', to);
};

export default sendEmail;