export function getNow() {
    const iso = String(process.env.NOW_OVERRIDE_ISO || '').trim();
    if (iso) {
        const d = new Date(iso);
        if (!isNaN(d.getTime())) return d;
    }
    return new Date();
}