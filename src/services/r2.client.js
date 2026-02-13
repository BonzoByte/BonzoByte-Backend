// src/services/r2.client.js
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

function streamToString(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
}

export const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
});

export async function r2GetJson(key) {
    const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
    const res = await r2.send(cmd);
    const text = await streamToString(res.Body);
    return JSON.parse(text);
}

export async function r2ListKeys(prefix) {
    const cmd = new ListObjectsV2Command({ Bucket: env.R2_BUCKET, Prefix: prefix });
    const res = await r2.send(cmd);
    return (res.Contents || []).map(x => x.Key);
}