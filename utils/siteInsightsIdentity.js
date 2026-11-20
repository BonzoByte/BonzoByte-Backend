import jwt from 'jsonwebtoken';

/** Read-only identity resolution: no account-operation lease or profile mutation for telemetry. */
export function createInsightsIdentity({ User, secret, eligible = () => false }) {
    return async (req, res, next) => {
        const header = req.headers.authorization;
        if (!header) { req.user = null; return next(); }
        try {
            if (!/^Bearer \S+$/.test(header)) throw new Error();
            const claims = jwt.verify(header.slice(7), secret(), { algorithms: ['HS256'] });
            if (!claims || typeof claims.tv !== 'number' || !/^[a-f0-9]{24}$/.test(String(claims.id))) throw new Error();
            const user = await User.findById(claims.id).select('_id email isVerified tokenVersion accountClosure testAccount').lean();
            if (!user || user.accountClosure?.requestedAt || (user.tokenVersion ?? 0) !== claims.tv || !eligible(user)) throw new Error();
            req.user = user; next();
        } catch { res.status(401).json({ code: 'SITE_INSIGHTS_AUTH_REQUIRED' }); }
    };
}
