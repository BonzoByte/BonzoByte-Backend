import jwt from 'jsonwebtoken';

// This is NOT an access token (deliberately has no `tv` claim). Issued only after
// a correct password so an unverified, signed-out account can finish verification.
export function generateVerificationSession(user) {
    return jwt.sign({ id: String(user._id), email: user.email, version: user.tokenVersion ?? 0,
        purpose: 'email-verification-session' }, process.env.JWT_SECRET,
    { issuer: 'bonzobyte', expiresIn: '30m', algorithm: 'HS256' });
}
export function readVerificationSession(token) {
    const value = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'bonzobyte', algorithms: ['HS256'] });
    if (typeof value !== 'object' || value.purpose !== 'email-verification-session'
        || typeof value.id !== 'string' || typeof value.email !== 'string' || typeof value.version !== 'number'
        || Object.hasOwn(value, 'tv')) throw new Error('INVALID_VERIFICATION_SESSION');
    return value;
}
