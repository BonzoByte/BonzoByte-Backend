import mailer from './mailer.js';

const transporter = mailer;

const sendEmail = async ({ to, subject, html }) => {
  await transporter.sendMail({
    from: `"BonzoByte" <${process.env.EMAIL_USER || 'noreply@bonzobyte.com'}>`,
    to,
    subject,
    html
  });
};

export default sendEmail;
