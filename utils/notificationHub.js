const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const scopes = new Set(['public', 'private', 'all']);
export function createNotificationHub({ maxClients = 256, maxPerUser = 3, heartbeatMS = 20000,
    lifetimeMS = 180000, coalesceMS = 200, validate = null, now = Date.now, presenceGraceMS = 45000 } = {}) {
    const users = new Map(), pending = new Map();
    // Bounded disconnect grace, not a persistent last-seen/activity history.
    const recentlyDisconnected = new Map();
    function prunePresence() {
        for (const [user, expiry] of recentlyDisconnected) if (expiry <= now()) recentlyDisconnected.delete(user);
        while (recentlyDisconnected.size > 1024) recentlyDisconnected.delete(recentlyDisconnected.keys().next().value);
    }
    let size = 0, heartbeat, flushTimer, checking = false;
    const fail = (code, status) => Object.assign(new Error(code), { code, status });
    function remove(client, immediate = client.immediatePresence === true) {
        if (client.closed) return;
        client.closed = true; clearTimeout(client.expiry);
        client.res.off('close', client.cleanup); client.req.off('aborted', client.cleanup);
        client.res.off('error', client.cleanup);
        const group = users.get(client.userId); group?.delete(client); size--;
        if (!group?.size) {
            users.delete(client.userId); pending.delete(client.userId);
            if (immediate) recentlyDisconnected.delete(client.userId);
            else recentlyDisconnected.set(client.userId, now() + presenceGraceMS);
            prunePresence();
        }
        if (!size) { clearInterval(heartbeat); heartbeat = undefined; clearTimeout(flushTimer); flushTimer = undefined; pending.clear(); }
    }
    function close(client, reason) {
        if (client.closed) return;
        client.immediatePresence = reason === 'auth' || reason === 'disabled';
        try {
            if (reason && !client.res.destroyed && client.res.writableLength < 32768)
                client.res.write(`event: end\ndata: ${JSON.stringify({ v: 1, reason })}\n\n`);
            client.res.end();
        } catch { client.res.destroy(); }
        finally { remove(client, reason === 'auth' || reason === 'disabled'); }
    }
    function write(client, frame) {
        if (client.closed) return;
        if (client.res.destroyed || client.res.writableEnded || client.res.writableLength > 32768) { remove(client); client.res.destroy(); return; }
        try {
            if (!client.res.write(frame)) { remove(client); client.res.destroy(); return; }
            client.res.flush?.();
        } catch { remove(client); client.res.destroy(); }
    }
    async function beat() {
        if (checking || !size) return;
        checking = true;
        try {
            // Connections added during the database read belong to the next validation batch.
            const clients = [...users.values()].flatMap(group => [...group]);
            const current = validate ? await validate([...new Set(clients.map(client => client.userId))]) : null;
            for (const client of clients) {
                if (client.closed) continue;
                if (client.expiresAt <= now()) { close(client, 'auth'); continue; }
                if (current) {
                    const account = current.get(client.userId);
                    if (!account || account.closed || account.tokenVersion !== client.tokenVersion) { close(client, 'auth'); continue; }
                    if (!account.eligible) { close(client, 'disabled'); continue; }
                }
                write(client, ': keepalive\n\n');
            }
        } catch {
            // Database uncertainty is not evidence of logout. Disconnect and let the client retry.
            for (const group of [...users.values()]) for (const client of [...group]) close(client, 'retry');
        } finally { checking = false; }
    }
    function attach(req, res, { userId, tokenVersion, expiresAt }) {
        if (!id(userId) || !Number.isSafeInteger(tokenVersion) || tokenVersion < 0 || !Number.isFinite(expiresAt) || expiresAt <= now())
            throw fail('NOTIFICATIONS_AUTH_REQUIRED', 401);
        if (size >= maxClients || (users.get(userId)?.size ?? 0) >= maxPerUser) throw fail('NOTIFICATIONS_CAPACITY', 429);
        res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform',
            'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive' });
        res.vary('Authorization'); res.flushHeaders(); res.setTimeout?.(0); res.socket?.setNoDelay(true);
        const client = { req, res, userId, tokenVersion, expiresAt, closed: false };
        client.cleanup = () => remove(client);
        if (!users.has(userId)) users.set(userId, new Set()); users.get(userId).add(client); size++;
        recentlyDisconnected.delete(userId);
        res.once('close', client.cleanup); res.once('error', client.cleanup); req.once('aborted', client.cleanup);
        client.expiry = setTimeout(() => close(client, expiresAt <= now() ? 'auth' : 'retry'), Math.min(lifetimeMS, expiresAt - now())); client.expiry.unref?.();
        if (!heartbeat) { heartbeat = setInterval(() => { void beat(); }, heartbeatMS); heartbeat.unref?.(); }
        write(client, 'event: ready\ndata: {"v":1,"scope":"all"}\n\n');
        return () => close(client);
    }
    function notify(userIds, scope) {
        if (!scopes.has(scope)) return;
        for (const userId of new Set(userIds)) if (id(userId) && users.has(userId)) {
            const old = pending.get(userId); pending.set(userId, old && old !== scope ? 'all' : scope);
        }
        if (!pending.size || flushTimer) return;
        flushTimer = setTimeout(() => {
            flushTimer = undefined; const batch = [...pending]; pending.clear();
            for (const [userId, scope] of batch) for (const client of [...(users.get(userId) ?? [])])
                write(client, `event: change\ndata: ${JSON.stringify({ v: 1, scope })}\n\n`);
        }, coalesceMS); flushTimer.unref?.();
    }
    return { attach, notify, connectedUsers: () => [...users.keys()], size: () => size, beat,
        isPresent: user => { prunePresence(); return users.has(user) || (recentlyDisconnected.get(user) ?? 0) > now(); },
        close: () => { for (const group of [...users.values()]) for (const client of [...group]) close(client, 'retry'); recentlyDisconnected.clear(); } };
}
