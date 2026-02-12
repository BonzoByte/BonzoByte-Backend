import jwt from 'jsonwebtoken';

/**
 * Issue an access JWT for API auth.
 */
export const generateToken = (userId) => {
    return jwt.sign(
        { id: userId },
        process.env.JWT_SECRET,
        {
            expiresIn: process.env.JWT_EXPIRES_IN || '1d',
            issuer: 'bonzobyte',
            subject: String(userId)
        }
    );
};

/**
 * Issue a short-lived token for email verification.
 */
export const generateVerificationToken = (userId) => {
    return jwt.sign(
        { id: userId },
        process.env.JWT_SECRET,
        {
            expiresIn: process.env.JWT_VERIFICATION_EXPIRES_IN || '1h',
            issuer: 'bonzobyte',
            subject: String(userId)
        }
    );
};

export default generateToken;