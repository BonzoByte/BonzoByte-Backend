export function getNow() {
    const forced = process.env.ARCHIVES_NOW_ISO;
    if (!forced) return new Date();

    const d = new Date(forced);
    if (isNaN(d.getTime())) return new Date();
    return d;
}

export function getNowDebug() {
    const forced = process.env.ARCHIVES_NOW_ISO || null;
    const real = new Date();
    const used = getNow();

    return {
        realNowIso: real.toISOString(),
        forcedNowIso: forced,
        usedNowIso: used.toISOString(),
        isForced: !!forced,
    };
}  