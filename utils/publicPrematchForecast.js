// Apply an independently verified, model-only batch after public archive projection.
// This is not a substitute for a trusted live status nor a result-quality decision.
const calendar = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Zagreb',year:'numeric',month:'2-digit',day:'2-digit'});
const key = instant => {
    const parts=Object.fromEntries(calendar.formatToParts(instant).map(p=>[p.type,p.value]));
    return parts.year+parts.month+parts.day;
};

export function recentForecastKey(day, now=Date.now()) {
    const hour=3_600_000;
    return day>=key(now-48*hour) && day<=key(now+24*hour) ? `analytics/public-prematch-${day}.json` : null;
}

export function overlayPublicPrematchForecasts(matches, batch, day, now = Date.now()) {
    if (batch?.schema !== 'bonzobyte.public-prematch-grid.v1' || batch.day !== day ||
        !Array.isArray(batch.rows) || batch.rows.length > 100) return matches;
    const forecasts = new Map();
    for (const row of batch.rows) {
        const ids = [row.matchTPId, row.matchId, row.player1TPId, row.player2TPId];
        const issued = Date.parse(row.issuedAtUtc), observed = Date.parse(row.sourceObservedAtUtc);
        const start = Date.parse(row.earliestScheduledStartUtc);
        if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || ids[2] === ids[3] || forecasts.has(ids[0]) ||
            !(observed <= issued && issued <= now && issued < start) ||
            !Number.isFinite(row.p1) || row.p1 <= 0 || row.p1 >= 1) return matches;
        forecasts.set(ids[0], row);
    }
    return matches.map(match => {
        const row = forecasts.get(match.matchTPId);
        if (!row || match.matchId !== row.matchId || match.player1TPId !== row.player1TPId || match.player2TPId !== row.player2TPId ||
            match.isFinished !== false || match.result || match.resultDetails || match.qualityStatus !== 'NotAssessed' ||
            match.calculationEligible !== false || match.modelProbabilityPlayer1 != null) return match;
        return { ...match, modelProbabilityPlayer1: row.p1 * 100, modelProbabilityPlayer2: (1 - row.p1) * 100,
            publicForecastIssuedAtUtc: new Date(row.issuedAtUtc).toISOString() };
    });
}
