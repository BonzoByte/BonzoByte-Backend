import jwt from 'jsonwebtoken';
import User from '../models/user.model.js';
import { isBetaAccountAllowed } from '../utils/accessPolicy.js';
import { beginAccountOperation } from '../utils/accountOperation.js';
import { developmentTestAccountAllowed } from '../utils/developmentTestAccounts.js';

// --------------------
// JWT protect middleware
// --------------------
export default async function protect(req, res, next) {
    try {
        const auth = req.headers.authorization || '';
        const [type, token] = auth.split(' ');

        if (type !== 'Bearer' || !token) {
            return res.status(401).json({ message: 'Nema tokena. Prijava potrebna.' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (typeof decoded.tv !== 'number') {
            return res.status(401).json({ message: 'Token nije ispravan ili je istekao.' });
        }

        const user = await User.findById(decoded.id).select('-password');
        if (res.writableEnded || res.destroyed) return;

        if (!user || user.accountClosure?.requestedAt) {
            return res.status(401).json({ message: 'Korisnik nije pronađen.' });
        }

        if (decoded.tv !== (user.tokenVersion ?? 0)) {
            return res.status(401).json({ message: 'Token nije ispravan ili je istekao.' });
        }

        if (!developmentTestAccountAllowed(user)) return res.status(403).json({ code: 'DEVELOPMENT_ACCOUNT_ONLY' });

        if (!isBetaAccountAllowed(user.email)) return res.status(403).json({ code: 'BETA_EMAIL_NOT_ALLOWED' });

        if (!await beginAccountOperation(User, req, res, user._id, decoded.tv)) {
            if (res.writableEnded || res.destroyed) return;
            return res.status(401).json({ code: 'ACCOUNT_CLOSED' });
        }
        req.user = user;
        req.authExpiresAt = typeof decoded.exp === 'number' ? decoded.exp * 1000 : null;
        next();
    } catch (err) {
        if (res.headersSent || res.destroyed) return;
        const notificationRead = req.method === 'GET' && ['/api/discussions/notification-summary', '/api/private-messages/summary', '/api/presence']
            .includes((req.originalUrl || '').split('?')[0].replace(/\/$/, ''));
        if ((req.isNotificationStream || notificationRead) && !['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(err?.name))
            return res.status(503).json({ code: 'NOTIFICATIONS_UNAVAILABLE' });
        return res.status(401).json({ message: 'Token nije ispravan ili je istekao.' });
    }
}

// --------------------
// Role guards
// --------------------
export function isUser(req, res, next) {
    if (!req.user || !req.user.isUser) {
        return res.status(403).json({ message: 'User access required.' });
    }
    next();
}

export function isAdmin(req, res, next) {
    if (!req.user || !req.user.isAdmin) {
        return res.status(403).json({ message: 'Admin access required.' });
    }
    next();
}
