import { ArchiveError } from './reader.mjs';

/** Supply an already configured, read-only, fixed-account client server-side. */
export function createS3Transport({ enabled = false, client, bucket, GetObjectCommand }) {
  if (!enabled) throw new ArchiveError('ONLINE_READER_DISABLED');
  if (!client || typeof client.send !== 'function' || typeof GetObjectCommand !== 'function' ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket || '')) throw new ArchiveError('READER_CONFIGURATION_INVALID');
  return async (key, { signal }) => {
    if (!/^publisher-staging-v1\/objects\/[a-f0-9]{2}\/[a-f0-9]{64}\.(?:br|json)$/.test(key))
      throw new ArchiveError('INVALID_OBJECT_KEY', 400);
    const result = await client.send(new GetObjectCommand({ Bucket:bucket, Key:key }), { abortSignal:signal });
    return { body:result.Body };
  };
}
