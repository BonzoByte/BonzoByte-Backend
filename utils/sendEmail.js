import mailer from './mailer.js';

const transporter = mailer;

const sendEmail = async ({ to, subject, html, channel = 'info' }) => {
  await transporter.sendMail({
    to,
    channel,
    subject,
    html
  });
};

export default sendEmail;
