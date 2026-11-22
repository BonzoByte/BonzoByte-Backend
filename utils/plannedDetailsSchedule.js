const ORIGIN = 'https://bonzobyte.com/api/match-schedule/';
const MAX_BYTES = 128 * 1024;
const HOUR = 3_600_000;
const fullUtc = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const minuteUtc = /^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/;
const format = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zagreb', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = instant => {
    const parts = Object.fromEntries(format.formatToParts(instant).map(p => [p.type, p.value]));
    return parts.year + parts.month + parts.day;
};
const id = value => Number.isSafeInteger(value) && value > 0;
const utc = (value, pattern) => typeof value === 'string' && pattern.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function decode(packet, day, now) {
    if (packet?.schema !== 'bonzobyte.planned-match-schedule.v1' || packet.day !== day ||
        !utc(packet.observedAt, fullUtc) || Date.parse(packet.observedAt) > now + 120_000 ||
        now - Date.parse(packet.observedAt) > 36 * HOUR || !Array.isArray(packet.slots) ||
        packet.slots.length < 1 || packet.slots.length > 500) throw Error('Invalid planned schedule');
    const result = new Map();
    for (const entry of packet.slots) {
        if (!Array.isArray(entry) || entry.length !== 4) throw Error('Invalid planned slot');
        const [tp, one, two, start] = entry;
        if (!id(tp) || !id(one) || !id(two) || one === two || result.has(tp) ||
            !utc(start, minuteUtc) || dayKey(Date.parse(start)) !== day) throw Error('Invalid planned slot');
        result.set(tp, [one, two, start]);
    }
    return { result, observedAt: Date.parse(packet.observedAt) };
}

export function createDetailsScheduleResolver(fetchImpl = fetch) {
    const loads = new Map();
    async function read(day, now) {
        const response = await fetchImpl(ORIGIN + day, { signal: AbortSignal.timeout(2500), redirect: 'error' });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json') || !response.body) {
            await response.body?.cancel();
            throw Error('Planned schedule unavailable');
        }
        const bytes = [];
        let count = 0;
        for await (const part of response.body) {
            count += part.byteLength;
            if (count > MAX_BYTES) throw Error('Planned schedule too large');
            bytes.push(part);
        }
        return decode(JSON.parse(Buffer.concat(bytes, count)), day, now);
    }
    return async ({ located, match, now }) => {
        const instant = +now;
        const day = located?.day?.replaceAll('-', '');
        if (!Number.isFinite(instant) || !/^\d{8}$/.test(day ?? '')) return { unavailable: true };
        if (day < dayKey(instant)) return {};  // Historical route policy remains unchanged.
        if (day > dayKey(instant + 48 * HOUR) || match.m001 !== located.tp ||
            !id(match.m004) || !id(match.m005) || match.m004 === match.m005) return { unavailable: true };
        try {
            const wall = Date.now();
            let load = loads.get(day);
            if (!load || load.expires <= wall) {
                for (const [key, value] of loads) if (value.expires <= wall) loads.delete(key);
                load = { expires: wall + 30_000, request: read(day, instant) };
                loads.set(day, load);
            }
            const { result, observedAt } = await load.request;
            if (instant - observedAt > 36 * HOUR) return { unavailable: true };
            const slot = result.get(located.tp);
            if (!slot) return { allowUnknownStart: true, expectedStartUtc: match.m003 ?? located.day };
            if (slot[0] !== match.m004 || slot[1] !== match.m005) return { unavailable: true };
            return { plannedStartUtc: slot[2] };
        } catch {
            return { unavailable: true };
        }
    };
}

export const resolveDetailsSchedule = createDetailsScheduleResolver();
