import User from '../models/user.model.js';
import FavouritePlayer from '../models/favouritePlayer.model.js';
import FavouriteMatch from '../models/favouriteMatch.model.js';
import fs from 'fs';
import sharp from 'sharp';
import { deleteAvatar, getPublicUrl, saveAvatar } from '../services/avatarStorage/index.js';

function getRequestBaseUrl(req) {
    return `${req.protocol}://${req.get('host')}`;
}

function getUserAvatarUrl(user, baseUrl) {
    return getPublicUrl(user?.avatarKey, { baseUrl }) || user?.avatarUrl || null;
}

// ✅ GET PROFILE
export const getUserProfile = async (req, res) => {
    try {
      const user = await User.findById(req.user.id).populate('country', 'countryShort countryFull');
  
      if (!user) return res.status(404).json({ message: 'Korisnik nije pronađen.' });
  
      res.status(200).json({
        id: user._id,
        name: user.name,
        nickname: user.nickname,
        email: user.email,
        avatarUrl: getUserAvatarUrl(user, getRequestBaseUrl(req)),
        country: user.country || null,
      });
    } catch (err) {
      console.error('Greška kod dohvaćanja profila:', err);
      res.status(500).json({ message: 'Nešto je pošlo po zlu.' });
    }
  };
  
export const updateUserProfile = async (req, res) => {
    let oldAvatarKey = null;
    let newAvatarKey = null;
    let userSaveCompleted = false;

    try {
        const user = await User.findById(req.user.id);
        oldAvatarKey = user?.avatarKey || null;
        let shouldDeleteOldAvatar = false;
        if (!user) return res.status(404).json({ message: 'Korisnik nije pronađen.' });

        const nickname = typeof req.body.nickname === 'string' ? req.body.nickname.trim() : undefined;
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : undefined;
        if (name) user.name = name;
        if (nickname) user.nickname = nickname;
        if (req.body.country) user.country = req.body.country;

        if (req.file) {
            const version = Date.now();
            const baseUrl = getRequestBaseUrl(req);

            // Decode and re-encode uploads so the public avatar is always a small WebP.
            try {
                const avatarBuffer = await sharp(req.file.path, {
                    failOn: 'warning',
                    limitInputPixels: 4096 * 4096,
                })
                    .rotate()
                    .resize(512, 512, { fit: 'cover' })
                    .webp({ quality: 82 })
                    .toBuffer();

                const savedAvatar = await saveAvatar(avatarBuffer, {
                    userId: req.user.id,
                    version,
                    baseUrl,
                });

                newAvatarKey = savedAvatar.key;
                user.avatarKey = newAvatarKey;
                user.avatarUpdatedAt = new Date(version);
                // avatarKey is the new source of truth for uploaded avatars; avatarUrl stays for compatibility.
                user.avatarUrl = savedAvatar.publicUrl;
                shouldDeleteOldAvatar = Boolean(oldAvatarKey && oldAvatarKey !== newAvatarKey);
            } catch {
                return res.status(400).json({ message: 'Invalid avatar image.' });
            } finally {
                try { fs.unlinkSync(req.file.path); } catch { }
            }
        }

        await user.save();
        userSaveCompleted = true;

        if (shouldDeleteOldAvatar) {
            await deleteAvatar(oldAvatarKey);
        }
        const updatedUser = await User.findById(req.user.id).populate('country', 'countryShort countryFull');
        const responseBaseUrl = getRequestBaseUrl(req);

        return res.status(200).json({
            message: 'Profil ažuriran.',
            user: {
                _id: updatedUser._id, // zgodno za frontend normalizeUser
                id: updatedUser._id,
                name: updatedUser.name,
                nickname: updatedUser.nickname,
                email: updatedUser.email,
                avatarUrl: getUserAvatarUrl(updatedUser, responseBaseUrl),
                country: updatedUser.country || null,
                createdVia: updatedUser.createdVia,
                googleId: updatedUser.googleId,
                facebookId: updatedUser.facebookId,
            },
        });
    } catch (err) {
        if (!userSaveCompleted && newAvatarKey && newAvatarKey !== oldAvatarKey) {
            try { await deleteAvatar(newAvatarKey); } catch { }
        }

        console.error('Greška kod ažuriranja profila:', err);
        return res.status(500).json({ message: 'Nešto je pošlo po zlu.' });
    }
};
