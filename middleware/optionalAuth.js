// middleware/optionalAuth.js
import jwt from 'jsonwebtoken';

export function optionalAuth(req, res, next) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return next();

    try {
        const token = h.slice(7);
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.id;
    } catch {
        // ignore invalid token
    }

    next();
}