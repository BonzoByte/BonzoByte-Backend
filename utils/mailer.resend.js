import { Resend } from 'resend';

// No environment reads or network traffic on import. The shared mailer chooses
// the provider; keeping this adapter injectable lets tests avoid real delivery.
export function createResendTransport(apiKey, createClient = key => new Resend(key)) {
    const client = createClient(apiKey);
    return {
        async sendMail(mail, options = {}) {
            const { data, error } = await client.emails.send({
                from: mail.from,
                to: mail.to,
                subject: mail.subject,
                text: mail.text,
                html: mail.html,
                // The Node SDK takes camelCase and converts it to reply_to.
                ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
            }, { signal: AbortSignal.timeout(15_000),
                ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) });

            if (error || !data?.id) {
                // Never expose provider messages: they may contain addresses or payloads.
                const failure = new Error('Mail provider did not confirm acceptance.');
                failure.code = 'MAIL_DELIVERY_FAILED';
                if (Number.isInteger(error?.statusCode)) failure.statusCode = error.statusCode;
                if (['invalid_idempotent_request', 'concurrent_idempotent_requests'].includes(error?.name))
                    failure.providerCode = error.name;
                throw failure;
            }
            // Accepted by the provider, not proof of inbox delivery.
            return { messageId: data.id, accepted: mail.to, rejected: [], provider: 'resend' };
        },
    };
}
