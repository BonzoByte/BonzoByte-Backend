const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function verificationEmailContent(name, { code, token }, frontendUrl) {
    const url = `${frontendUrl.replace(/\/$/, '')}/verify#token=${encodeURIComponent(token)}`;
    return {
        subject: `${code} — BonzoByte email verification`,
        text: `Your BonzoByte verification code: ${code}\n\nHi ${name || ''},\nEnter this code in the tab where you registered. It expires in 5 minutes.\n\nYou can also confirm your email using this link: ${url}\nBoth work only once. Requesting a new code invalidates this message.\nIf you did not request this, ignore this email.`,
        html: `<p>Your BonzoByte verification code:</p><p style="font-size:32px;letter-spacing:6px;font-weight:bold">${code}</p>
<p>Hi ${escapeHtml(name)},</p><p>Enter this code in the tab where you registered. It expires in <strong>5 minutes</strong>.</p>
<p>Alternatively: <a href="${escapeHtml(url)}">Confirm my email</a>.</p>
<p>Both work only once. Requesting a new code invalidates this message.</p>
<p>If you did not request this, ignore this email.</p>`,
    };
}
