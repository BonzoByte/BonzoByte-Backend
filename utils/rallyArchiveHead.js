export const RALLY_ARCHIVE_HEAD_KEY = 'publisher-staging-v1/rally-recent-head-v1.json';
const HASH = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HEAD = 4096;

export async function readRallyArchiveHead(client, GetObjectCommand, bucket) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    let body;
    try {
        const result = await client.send(new GetObjectCommand({Bucket:bucket,Key:RALLY_ARCHIVE_HEAD_KEY}),
            {abortSignal:controller.signal});
        body=result.Body;
        if (!Number.isInteger(result.ContentLength) || result.ContentLength < 1 || result.ContentLength > MAX_HEAD)
            throw new Error('RALLY_HEAD_SIZE');
        let length=0; const parts=[];
        for await (const part of body) {
            const bytes=Buffer.from(part); length+=bytes.length;
            if(length>MAX_HEAD)throw new Error('RALLY_HEAD_SIZE');
            parts.push(bytes);
        }
        if(length!==result.ContentLength)throw new Error('RALLY_HEAD_SIZE');
        return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch (error) {
        if (error.name==='NoSuchKey' || error.$metadata?.httpStatusCode===404) return null;
        throw error;
    } finally { clearTimeout(timer);body?.destroy?.(); }
}

export function checkedRallyArchiveHead(value, anchor) {
    if(value===null)return null;
    const c=value?.candidate;
    if(value?.schema!=='bonzobyte.rally-recent-head.v1' || value.anchor!==anchor ||
       !HASH.test(c?.sha256??'') || c.key!==`publisher-staging-v1/objects/${c.sha256.slice(0,2)}/${c.sha256}.json` ||
       !Number.isSafeInteger(c.bytes) || c.bytes<1 || c.bytes>8*1024*1024 ||
       !HASH.test(value.release??'') || !ISO.test(value.through??'')) throw new Error('RALLY_HEAD_INVALID');
    return value;
}
