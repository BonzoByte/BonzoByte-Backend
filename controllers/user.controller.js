import User from '../models/user.model.js';
import FavouritePlayer from '../models/favouritePlayer.model.js';
import FavouriteMatch from '../models/favouriteMatch.model.js';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// ✅ GET PROFILE
export const getUserProfile = async (req, res) => {
    try {
        console.log('bla');
      const user = await User.findById(req.user.id).populate('country', 'countryShort countryFull');
  
      if (!user) return res.status(404).json({ message: 'Korisnik nije pronađen.' });
  
      res.status(200).json({
        id: user._id,
        name: user.name,
        nickname: user.nickname,
        email: user.email,
        avatarUrl: user.avatarUrl || null,
        country: user.country || null,
      });
    } catch (err) {
      console.error('Greška kod dohvaćanja profila:', err);
      res.status(500).json({ message: 'Nešto je pošlo po zlu.' });
    }
  };
  
export const updateUserProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: 'Korisnik nije pronađen.' });

        const nickname = typeof req.body.nickname === 'string' ? req.body.nickname.trim() : undefined;
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : undefined;
        if (name) user.name = name;
        if (nickname) user.nickname = nickname;
        if (req.body.country) user.country = req.body.country;

        // ✅ AVATAR — jedan file po useru
        if (req.file) {
            const avatarsDir = path.resolve('uploads/avatars');
            fs.mkdirSync(avatarsDir, { recursive: true });

            const outName = `${req.user.id}.webp`; // fiksno ime po userId
            const outPath = path.join(avatarsDir, outName);

            // preradi u 256x256 webp (ako želiš bez sharp-a, vidi varijantu #2)
            await sharp(req.file.path)
                .resize(256, 256, { fit: 'cover' })
                .webp({ quality: 82 })
                .toFile(outPath);

            // obriši privremeni upload
            try { fs.unlinkSync(req.file.path); } catch { }

            // URL + cache-bust
            const baseUrl = `${req.protocol}://${req.get('host')}`; // npr. http://localhost:5000
            user.avatarUrl = `${baseUrl}/uploads/avatars/${outName}?v=${Date.now()}`;
        } else if (req.body.avatarUrl) {
            user.avatarUrl = req.body.avatarUrl;
        }

        await user.save();
        const updatedUser = await User.findById(req.user.id).populate('country', 'countryShort countryFull');

        return res.status(200).json({
            message: 'Profil ažuriran.',
            user: {
                _id: updatedUser._id, // zgodno za frontend normalizeUser
                id: updatedUser._id,
                name: updatedUser.name,
                nickname: updatedUser.nickname,
                email: updatedUser.email,
                avatarUrl: updatedUser.avatarUrl || null,
                country: updatedUser.country || null,
                createdVia: updatedUser.createdVia,
                googleId: updatedUser.googleId,
                facebookId: updatedUser.facebookId,
            },
        });
    } catch (err) {
        console.error('Greška kod ažuriranja profila:', err);
        return res.status(500).json({ message: 'Nešto je pošlo po zlu.' });
    }
};