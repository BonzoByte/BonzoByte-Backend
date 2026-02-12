import jwt from 'jsonwebtoken';
import User from '../models/user.model.js';

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

        const user = await User.findById(decoded.id).select('-password');

        if (!user) {
            return res.status(401).json({ message: 'Korisnik nije pronađen.' });
        }

        req.user = user;
        next();
    } catch (err) {
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