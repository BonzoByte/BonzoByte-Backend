// Narrow public result projection. Canonical quality holds must not be bypassed.
export function publicFinalResult(row) {
    const fields = {};
    if (row.isFinished != null) fields.isFinished = [true, 1, '1', 'true'].includes(row.isFinished);
    const status = row.q != null ? (row.q.status ?? 'NotAssessed') : row.qualityStatus;
    if (status != null) fields.qualityStatus = typeof status === 'string' && /^[A-Za-z]{1,40}$/.test(status) ? status : 'NotAssessed';
    if (!fields.isFinished || (fields.qualityStatus &&
        !['Validated', 'Incomplete', 'NonRatedOutcome'].includes(fields.qualityStatus))) return fields;
    const result = typeof row.result === 'string' ? row.result.trim() : '';
    if (result && result.length <= 32 && !/[<>\p{Cc}\p{Cf}]/u.test(result)
        && !/^(?:unknown|n\/a|null|undefined|-|0)$/i.test(result)) fields.result = result;
    return fields;
}
