import bcrypt from 'bcryptjs';

export function createPasswordResetConsumer({ User, now = () => Date.now(),
    hashPassword = password => bcrypt.hash(password, 10) }) {
    return async (tokenHash, password) => {
        // Do not spend bcrypt work on a missing/expired token, or load the old
        // password. lean() also preserves missing legacy tokenVersion fields.
        const user = await User.findOne({ resetPasswordToken: tokenHash,
            'accountClosure.requestedAt': { $exists: false },
            resetPasswordExpires: { $gt: new Date(now()) },
        }).select('_id tokenVersion').lean();
        if (!user) return false;

        // Query updates do not run the document pre-save hash hook.
        const passwordHash = await hashPassword(password);
        const result = await User.updateOne({ _id: user._id,
            'accountClosure.requestedAt': { $exists: false },
            resetPasswordToken: tokenHash, resetPasswordExpires: { $gt: new Date(now()) },
            tokenVersion: user.tokenVersion ?? null,
        }, {
            $set: { password: passwordHash, tokenVersion: (user.tokenVersion ?? 0) + 1 },
            $unset: { resetPasswordToken: '', resetPasswordExpires: '' },
        });
        // Exactly one concurrent request can consume this proof. A replaced,
        // expired or already-used proof cannot overwrite a newer password.
        return result.modifiedCount === 1;
    };
}
