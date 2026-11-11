import jwt from 'jsonwebtoken';

/**
 * Issue an access JWT for API auth.
 */
export const generateToken = (userId, tokenVersion = 0) => {
    const tv = Number.isFinite(Number(tokenVersion)) ? Number(tokenVersion) : 0;

    return jwt.sign(
        { id: userId, tv },
        process.env.JWT_SECRET,
        {
            expiresIn: process.env.JWT_EXPIRES_IN || '1d',
            issuer: 'bonzobyte',
            subject: String(userId)
        }
    );
};

export default generateToken;
