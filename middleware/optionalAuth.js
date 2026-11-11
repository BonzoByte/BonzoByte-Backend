// middleware/optionalAuth.js
import jwt from 'jsonwebtoken';
import User from '../models/user.model.js';

export async function optionalAuth(req, res, next) {
    req.user = null;
    req.userId = null;

    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return next();

    try {
        const token = h.slice(7);
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (typeof decoded.tv !== 'number') return next();

        const user = await User.findById(decoded.id).select('-password');
        if (!user) return next();

        if (decoded.tv !== (user.tokenVersion ?? 0)) return next();

        req.user = user;
        req.userId = user._id;
    } catch {
        // Public archive routes continue anonymously when optional auth fails.
    }

    next();
}
