import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as FacebookStrategy } from 'passport-facebook';
import User from '../models/user.model.js';
import { grantInitialTrialIfMissing } from '../utils/trial.js';

// Ensure the providers array contains the authenticated provider exactly once.
function ensureProvider(user, providerName) {
    if (!Array.isArray(user.provider)) user.provider = [];
    if (!user.provider.includes(providerName)) user.provider.push(providerName);
}

passport.use(new GoogleStrategy(
    {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback'
    },
    async (_accessToken, _refreshToken, profile, done) => {
        try {
            const email = profile.emails?.[0]?.value?.toLowerCase();
            const googleId = profile.id;
            const name = profile.displayName || '';
            const avatarUrl = profile.photos?.[0]?.value;

        // Match by email, or by googleId when the provider supplies no email.
            let user = await User.findOne(
                email ? { $or: [{ email }, { googleId }] } : { googleId }
            );

            if (user) {
            // Fill fields that were unavailable during an earlier sign-in.
                if (!user.googleId) user.googleId = googleId;
                if (email && !user.email) user.email = email;
                if (avatarUrl && !user.avatarUrl) user.avatarUrl = avatarUrl;
                ensureProvider(user, 'google');
                user.isUser = true;
                user.isVerified = true;
                grantInitialTrialIfMissing(user, 7);
                await user.save();
                return done(null, user);
            }

        // Create a new user when no linked identity exists.
            const newUser = await User.create({
                name,
                email,
                googleId,
                avatarUrl,
                provider: ['google'],
                createdVia: 'google',
                isUser: true,
                isVerified: true,
                trial: {
                    endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                    grantedDaysTotal: 7,
                    lastGrantedAt: new Date(),
                },
                ads: { enabled: true, disabledReason: 'trial' },
                plan: 'free',
                subscription: { provider: 'none', status: 'none' },
            });

            return done(null, newUser);
        } catch (err) {
            return done(err);
        }
    }
));

passport.use(new FacebookStrategy(
    {
        clientID: process.env.FACEBOOK_CLIENT_ID,
        clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
        callbackURL: process.env.FACEBOOK_CALLBACK_URL || '/api/auth/facebook/callback',
        profileFields: ['id', 'emails', 'name', 'picture.type(large)']
    },
    async (_accessToken, _refreshToken, profile, done) => {
        try {
            const email = profile.emails?.[0]?.value?.toLowerCase();
            const facebookId = profile.id;
            const name = [profile.name?.givenName, profile.name?.familyName].filter(Boolean).join(' ');
            const avatarUrl = profile.photos?.[0]?.value;

        // Match by email when present; otherwise use facebookId.
            let user = await User.findOne(
                email ? { $or: [{ email }, { facebookId }] } : { facebookId }
            );

            if (user) {
                if (!user.facebookId) user.facebookId = facebookId;
                if (email && !user.email) user.email = email;
                if (avatarUrl && !user.avatarUrl) user.avatarUrl = avatarUrl;
                ensureProvider(user, 'facebook');
                user.isUser = true;
                user.isVerified = true;
                grantInitialTrialIfMissing(user, 7);
                await user.save();
                return done(null, user);
            }

            const newUser = await User.create({
                name,
                email,
                facebookId,
                avatarUrl,
                provider: ['facebook'],
                createdVia: 'facebook',
                isUser: true,
                isVerified: true,
                trial: {
                    endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                    grantedDaysTotal: 7,
                    lastGrantedAt: new Date(),
                },
                ads: { enabled: true, disabledReason: 'trial' },
                plan: 'free',
                subscription: { provider: 'none', status: 'none' },
            });

            return done(null, newUser);
        } catch (err) {
            return done(err);
        }
    }
));
