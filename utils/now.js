import { env, ARCHIVES_NOW_ISO } from '../config/env.js';

function resolveNow() {
    // ✅ ručni override (super za test)
    const forced = process.env.NOW_ISO && String(process.env.NOW_ISO).trim();
    if (forced) return { date: new Date(forced), source: 'NOW_ISO' };

    // ✅ archives-only default (tvoj “zamrznuti” datum)
    if (String(process.env.ARCHIVES_ONLY || '').toLowerCase() === 'true') {
        return { date: new Date(ARCHIVES_NOW_ISO), source: 'ARCHIVES_NOW_ISO' };
    }

    return { date: new Date(), source: 'system' };
}

export function getNow() {
    return resolveNow().date;
}

export function getNowDebug() {
    const r = resolveNow();
    return { nowIso: r.date.toISOString(), source: r.source };
}