import { canonicalTPId } from './popularity.js';
import { publicFinalResult } from './publicFinalResult.js';

// Only fixed public identity/result fields from canonical records. No request labels,
// profile data, HTML, probabilities or private detail fields enter rankings.
export function safePopularityLabel(value) {
    if (typeof value !== 'string') return null;
    const label = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (!label || label.length > 160 || /[<>\p{Cc}\p{Cf}]/u.test(label)
        || /^(?:unknown|n\/a|na|null|undefined|-|0)$/i.test(label)) return null;
    return label;
}

const genderOf = value => ['M', 'W'].includes(value) ? value : null;
const countryOf = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value)
    && !['WLD', 'UNK'].includes(value) ? value : undefined;
const finished = value => value === true || value === 1 || value === 'true' || value === '1';

function matchPlayerIdentity(side, { iso2, iso3, country, rank, seed }) {
    const prefix = `player${side}`, fields = {};
    const code2 = typeof iso2 === 'string' ? iso2.trim().toUpperCase() : '';
    const code3 = typeof iso3 === 'string' ? countryOf(iso3.trim().toUpperCase()) : undefined;
    if (/^[A-Z]{2}$/.test(code2) && !['XX', 'XW', 'WD'].includes(code2)) fields[`${prefix}CountryISO2`] = code2;
    if (code3) fields[`${prefix}CountryISO3`] = code3;
    const label = safePopularityLabel(country);
    if (label) fields[`${prefix}CountryFull`] = label;
    if ((typeof rank === 'number' || typeof rank === 'string') && /^[1-9]\d{0,5}$/.test(String(rank)))
        fields[`${prefix}Rank`] = String(rank);
    const seedLabel = typeof seed === 'number' && Number.isSafeInteger(seed) && seed > 0 ? String(seed) : safePopularityLabel(seed);
    if (seedLabel && seedLabel.length <= 24) fields[`${prefix}Seed`] = seedLabel;
    return fields;
}

export function popularitySourceDate(value, precision) {
    const sourceDate = value instanceof Date && Number.isFinite(+value) ? value.toISOString() : value;
    if (typeof sourceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,7})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(sourceDate)) return null;
    const calendar = new Date(sourceDate.slice(0, 10) + 'T00:00:00Z');
    if (!Number.isFinite(+calendar) || calendar.toISOString().slice(0, 10) !== sourceDate.slice(0, 10)) return null;
    // Match the existing detailsAccessPolicy.parseExpectedStart convention:
    // a timestamp with no explicit offset is normalized by appending Z.
    const date = new Date(sourceDate.length === 10 ? sourceDate + 'T00:00:00Z'
        : /(?:Z|[+-]\d{2}:\d{2})$/.test(sourceDate) ? sourceDate : sourceDate + 'Z');
    if (!Number.isFinite(+date)) return null;
    return { dateTime: date.toISOString(), sourceDate,
        sourceTimePrecision: sourceDate.length === 10 ? 'date'
            : ['minute', 'second', 'date', 'unknown'].includes(precision) ? precision : 'unknown' };
}

function matchItem(id, row, first, second, tournament, source, dateSource) {
    if (!first || !second || !tournament || !source) return null;
    return { id, player1: first, player2: second, tournament, date: source.sourceDate.slice(0, 10),
        match: { matchTPId: id, ...source, dateSource,
            player1TPId: row.player1TPId, player2TPId: row.player2TPId,
            player1Name: first, player2Name: second, tournamentEventName: tournament,
            isFinished: finished(row.isFinished) } };
}

export function popularityArchiveEntity(kind, id, row) {
    if (!row || !canonicalTPId(id)) return null;
    if (kind === 'player') {
        const name = safePopularityLabel(row.d002), country = countryOf(row.d004);
        if (row.d001 !== id || !name) return null;
        const gender = genderOf(row.gender ?? row.playerGender);
        return { id, name, ...(country ? { country } : {}), ...(gender ? { gender } : {}) };
    }
    if (kind !== 'match' || row.m001 !== id || !canonicalTPId(row.m004) || !canonicalTPId(row.m005)
        || row.m004 === row.m005 || !canonicalTPId(row.m002) || row.p1?.p01 !== row.m004
        || row.p2?.p01 !== row.m005 || row.t?.t01 !== row.m002) return null;
    const item = matchItem(id, { player1TPId: row.m004, player2TPId: row.m005, isFinished: row.m656 },
        safePopularityLabel(row.p1.p02), safePopularityLabel(row.p2.p02), safePopularityLabel(row.t.t02),
        popularitySourceDate(row.m003, row.sourceTimePrecision), 'archive');
    if (item) Object.assign(item.match,
        publicFinalResult({ isFinished: row.m656, result: row.m010, qualityStatus: row.qualityStatus, q: row.q }),
        matchPlayerIdentity(1, { iso2: row.p1.p05, iso3: row.p1.p04, country: row.p1.p06, rank: row.m006, seed: row.m008 }),
        matchPlayerIdentity(2, { iso2: row.p2.p05, iso3: row.p2.p04, country: row.p2.p06, rank: row.m007, seed: row.m009 }));
    return item;
}

export function createPopularityEntityResolver({ Player, Match, TournamentEvent, Country, readArchive }) {
    const read = (Model, id, projection) => Model.findById(id).select(projection).maxTimeMS(5000).lean();
    async function player(id) {
        if (!canonicalTPId(id)) return null;
        const row = await read(Player, id, '_id playerName countryTPId gender');
        const name = safePopularityLabel(row?.playerName);
        if (row?._id !== id || !name) return null;
        let country;
        if (canonicalTPId(row.countryTPId)) {
            const item = await read(Country, row.countryTPId, '_id countryShort');
            if (item?._id === row.countryTPId && typeof item.countryShort === 'string'
                && /^[A-Z]{3}$/.test(item.countryShort) && !['WLD', 'UNK'].includes(item.countryShort)) country = item.countryShort;
        }
        const gender = genderOf(row.gender);
        return { id, name, ...(country ? { country } : {}), ...(gender ? { gender } : {}) };
    }
    return async function resolve(kind, id) {
        if (!canonicalTPId(id)) return null;
        if (!['match', 'player'].includes(kind)) return null;
        if (readArchive) {
            const archived = await readArchive(kind, id);
            if (archived !== null) {
                const entity = popularityArchiveEntity(kind, id, archived);
                // Legacy player archives omit gender. Only supplement from a
                // canonical record with an explicit M/W value, never from names.
                if (entity && kind === 'player' && !entity.gender) {
                    const row = await read(Player, id, '_id gender');
                    if (row?._id === id && genderOf(row.gender)) entity.gender = row.gender;
                }
                return entity;
            }
        }
        if (kind === 'player') return player(id);
        if (kind !== 'match') return null;
        const row = await read(Match, id, '_id player1TPId player2TPId player1Seed player2Seed tournamentEventTPId dateTime sourceTimePrecision isFinished result qualityStatus');
        if (row?._id !== id || !canonicalTPId(row.player1TPId) || !canonicalTPId(row.player2TPId)
            || row.player1TPId === row.player2TPId || !canonicalTPId(row.tournamentEventTPId)
            || !(row.dateTime instanceof Date) || !Number.isFinite(+row.dateTime)) return null;
        const [first, second, tournament] = await Promise.all([player(row.player1TPId), player(row.player2TPId),
            read(TournamentEvent, row.tournamentEventTPId, '_id tournamentEventName')]);
        const label = safePopularityLabel(tournament?.tournamentEventName);
        if (!first || !second || tournament?._id !== row.tournamentEventTPId || !label) return null;
        const item = matchItem(id, row, first.name, second.name, label,
            popularitySourceDate(row.dateTime, row.sourceTimePrecision), 'mongo');
        if (item) Object.assign(item.match,
            publicFinalResult(row),
            matchPlayerIdentity(1, { iso3: first.country, seed: row.player1Seed }),
            matchPlayerIdentity(2, { iso3: second.country, seed: row.player2Seed }));
        return item;
    };
}
