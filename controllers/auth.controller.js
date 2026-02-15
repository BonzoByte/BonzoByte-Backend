// controllers/auth.controller.js
import User from '../models/user.model.js';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { generateVerificationToken } from '../utils/generateToken.js';
import sendVerificationEmail from '../utils/sendVerificationEmail.js';
import sendResetPasswordEmail from '../utils/sendResetPasswordEmail.js';
import asyncHandler from 'express-async-handler';
import transporter from '../utils/mailer.js';
import { getEntitlements } from '../utils/entitlements.js';

// ✅ Helper funkcija za slanje odgovora s greškom
const handleError = (res, statusCode, message) => {
  return res.status(statusCode).json({ message });
};

// ✅ REGISTER (auto-login; optional auto-verify when EMAIL_DISABLED=1)
// - sends verification email (best effort)
// - NEVER blocks response if mail fails (prevents frontend "Registering..." forever)
export const registerUser = async (req, res) => {
  try {
    const { email, password, nickname, name, country } = req.body;

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedNickname = nickname ? String(nickname).trim() : '';
    const normalizedName = name ? String(name).trim() : '';

    if (!normalizedEmail || !password) {
      return res.status(400).json({
        status: 'error',
        code: 'VALIDATION_ERROR',
        message: 'Email and password are required.',
      });
    }

    const existingByEmail = await User.findOne({ email: normalizedEmail }).select('+password');
    if (existingByEmail) {
      return res.status(400).json({
        status: 'error',
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'Email is already registered.',
      });
    }

    if (normalizedNickname) {
      const existingByNickname = await User.findOne({ nickname: normalizedNickname });
      if (existingByNickname) {
        return res.status(400).json({
          status: 'error',
          code: 'NICKNAME_ALREADY_EXISTS',
          message: 'Nickname is already taken.',
        });
      }
    }

    const emailDisabled = String(process.env.EMAIL_DISABLED || '') === '1';

    const user = await User.create({
      email: normalizedEmail,
      password,
      nickname: normalizedNickname || undefined,
      name: normalizedName || normalizedNickname || normalizedEmail.split('@')[0],
      country,
      provider: ['local'],
      createdVia: 'manual',

      // ✅ dok nema maila: auto-verify
      isVerified: emailDisabled ? true : false,
      isUser: emailDisabled ? true : false,

      trial: {
        endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        grantedDaysTotal: 7,
        lastGrantedAt: new Date(),
      },
      ads: { enabled: true, disabledReason: 'trial' },
    });

    // ✅ samo ako mail radi
    if (!emailDisabled) {
      try {
        const verificationToken = generateVerificationToken(user._id);
        await sendVerificationEmail(user.email, user, verificationToken);
      } catch (err) {
        console.error('[REGISTER] Verification email failed (new user):', err);
        // ne rušimo registraciju
      }
    }

    // ✅ auto-login: vrati token + user
    const token = jwt.sign(
      { id: user._id.toString() },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
    );

    return res.status(201).json({
      status: 'ok',
      message: emailDisabled
        ? 'Registration successful. You are now logged in.'
        : 'Registration successful. Please check your email to verify your account.',
      token,
      user: {
        _id: user._id.toString(),
        email: user.email,
        name: user.name,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl ?? null,
        isAdmin: !!user.isAdmin,
        isUser: !!user.isUser,
        isVerified: !!user.isVerified,
        provider: Array.isArray(user.provider) ? user.provider : [],
        entitlements: getEntitlements(user),
      }
    });
  } catch (error) {
    if (error?.code === 11000) {
      const key = Object.keys(error.keyPattern || {})[0];
      return res.status(400).json({
        status: 'error',
        code: key === 'nickname' ? 'NICKNAME_ALREADY_EXISTS' : 'EMAIL_ALREADY_EXISTS',
        message: key === 'nickname' ? 'Nickname is already taken.' : 'Email is already registered.',
      });
    }

    console.error('Greška u registerUser:', error);
    return res.status(500).json({
      status: 'error',
      code: 'SERVER_ERROR',
      message: 'Server error during registration.',
    });
  }
};

// ✅ LOGIN (robust + radi s password: select:false)
export const loginUser = async (req, res) => {
  try {
    const { identifier, password } = req.body;

    const idf = String(identifier || '').trim().toLowerCase();
    const pwd = String(password || '');

    if (!idf || !pwd) {
      return res.status(400).json({
        status: 'error',
        code: 'VALIDATION_ERROR',
        message: 'Identifier and password are required.',
      });
    }

    // 🔥 KLJUČNO: uzmi password iako je select:false u schemi
    const user = await User.findOne({
      $or: [{ email: idf }, { nickname: idf }],
    }).select('+password');

    if (!user || !user.password) {
      return res.status(401).json({
        status: 'error',
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email/username or password.',
      });
    }

    const isMatch = await bcrypt.compare(pwd, user.password);
    if (!isMatch) {
      return res.status(401).json({
        status: 'error',
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email/username or password.',
      });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        status: 'error',
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email before logging in.',
      });
    }

    const token = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '1d',
    });

    return res.status(200).json({
      status: 'ok',
      token,
      user: {
        _id: user._id.toString(),
        email: user.email,
        name: user.name,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl ?? null,
        isAdmin: !!user.isAdmin,
        isUser: !!user.isUser,
        isVerified: !!user.isVerified,
        provider: Array.isArray(user.provider) ? user.provider : [],
        entitlements: getEntitlements(user),
      },
    });
  } catch (error) {
    console.error('[LOGIN ERROR]:', error);
    return res.status(500).json({
      status: 'error',
      code: 'SERVER_ERROR',
      message: 'Server error during login.',
    });
  }
};

// ✅ LOGOUT
export const logoutUser = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'Korisnik nije pronađen.' });
    }

    user.isOnline = false;
    await user.save();

    return res.status(200).json({ message: 'Odjava uspješna.' });
  } catch (error) {
    console.error('[LOGOUT ERROR]:', error);
    res.status(500).json({ message: 'Greška prilikom odjave.' });
  }
};

// ✅ VERIFY EMAIL
export const verifyEmail = async (req, res) => {
  try {
    const { token } = req.body;

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) return handleError(res, 404, 'Korisnik nije pronađen.');

    user.isVerified = true;
    user.isUser = true;
    await user.save();

    return res.status(200).json({ message: 'Email uspješno verificiran.' });
  } catch (error) {
    console.error('[VERIFY EMAIL ERROR]:', error);
    return handleError(res, 400, 'Token nije ispravan ili je istekao.');
  }
};

// ✅ RESEND VERIFY EMAIL (NE blokira response)
export const resendVerificationEmail = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ message: 'Email is required.' });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Korisnik ne postoji.' });

    if (user.isUser || user.isVerified) {
      return res.status(400).json({ message: 'Račun je već verificiran.' });
    }

    const token = generateVerificationToken(user._id);

    // ✅ fire-and-forget
    sendVerificationEmail(user.email, user, token)
      .then(() => console.log('[RESEND] Verification email sent:', user.email))
      .catch((err) => console.warn('[RESEND] Verification email failed:', err?.message || err));

    return res.status(200).json({ message: 'Verifikacijski email ponovno poslan.', emailStatus: 'queued' });
  } catch (error) {
    console.error('[RESEND VERIFICATION ERROR]:', error);
    return res.status(500).json({ message: 'Greška prilikom slanja verifikacije.' });
  }
};

export async function forgotPassword(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'Korisnik s tom email adresom ne postoji' });

    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 60 * 60 * 1000; // 1 sat
    await user.save();

    // ovdje može ostati await (ili isto fire-and-forget), ali bar neće blokirati register flow
    await sendResetPasswordEmail(email, token);
    return res.json({ message: 'Email za reset lozinke je poslan' });
  } catch (err) {
    console.error('Greška u forgotPassword:', err);
    return res.status(500).json({ message: 'Greška prilikom slanja emaila' });
  }
}

export async function resetPassword(req, res) {
  const { token, email, password } = req.body;

  if (!token || !email || !password) {
    return res.status(400).json({ message: 'Token, email i nova lozinka su obavezni.' });
  }

  try {
    const user = await User.findOne({
      email: String(email).trim().toLowerCase(),
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    }).select('+password');

    if (!user) {
      return res.status(400).json({ message: 'Neispravan ili istekao token.' });
    }

    user.password = password; // plaintext -> pre-save hook hashira
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;

    await user.save();

    return res.json({ message: 'Lozinka uspješno promijenjena.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Došlo je do greške prilikom resetiranja lozinke.' });
  }
}

export const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('country', 'countryShort countryFull');
    if (!user) return res.status(404).json({ message: 'Korisnik nije pronađen.' });

    return res.status(200).json({
      user: {
        _id: user._id.toString(),
        email: user.email,
        name: user.name,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl ?? null,
        isAdmin: !!user.isAdmin,
        isUser: !!user.isUser,
        isVerified: !!user.isVerified,
        provider: Array.isArray(user.provider) ? user.provider : [],
        entitlements: getEntitlements(user),
      },
    });
  } catch (err) {
    console.error('Greška kod dohvaćanja korisnika:', err);
    res.status(500).json({ message: 'Greška na serveru.' });
  }
};

export const requestResetPassword = async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Korisnik s ovim emailom ne postoji.' });

    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 60 * 60 * 1000;
    await user.save();

    await sendResetPasswordEmail(user.email, token);
    return res.status(200).json({ message: 'Link za resetiranje lozinke poslan.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Greška prilikom slanja linka za resetiranje lozinke.' });
  }
};

export const getMe = (req, res) => {
  const u = req.user;
  if (!u) return res.status(401).json({ message: 'Unauthorized' });

  res.json({
    _id: u._id,
    name: u.name,
    email: u.email,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl,
    isAdmin: u.isAdmin,
    isUser: u.isUser,
    isVerified: u.isVerified,
    provider: u.provider,
  });
};

// ✅ DEV ONLY: force-verify user (for testing trial/login without emails)
export const devVerifyUser = async (req, res) => {
  try {
    const allow =
      String(process.env.DEV_BYPASS_VERIFY || '') === '1' ||
      String(process.env.NODE_ENV || '').toLowerCase() !== 'production';

    if (!allow) {
      return res.status(404).json({ message: 'Not found' });
    }

    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({
        status: 'error',
        code: 'VALIDATION_ERROR',
        message: 'Email is required.',
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        status: 'error',
        code: 'USER_NOT_FOUND',
        message: 'User not found.',
      });
    }

    user.isVerified = true;
    user.isUser = true;
    user.trial = user.trial || { endsAt: null, grantedDaysTotal: 0, lastGrantedAt: null };

    await user.save();

    return res.status(200).json({
      status: 'ok',
      message: 'User verified (DEV).',
      user: {
        _id: user._id.toString(),
        email: user.email,
        nickname: user.nickname,
        name: user.name,
        isVerified: !!user.isVerified,
        isUser: !!user.isUser,
        isAdmin: !!user.isAdmin,
        entitlements: getEntitlements(user),
      },
    });
  } catch (e) {
    console.error('[DEV VERIFY ERROR]:', e);
    return res.status(500).json({
      status: 'error',
      code: 'SERVER_ERROR',
      message: 'Server error.',
    });
  }
};

export const contactUs = asyncHandler(async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) {
    return res.status(400).json({ message: 'Name, email and message are required.' });
  }

  const TO = process.env.SUPPORT_EMAIL || process.env.CONTACT_TO || process.env.EMAIL_USER || 'bonzobyte@gmail.com';

  if (!TO) {
    console.error('[CONTACT] No recipient configured (SUPPORT_EMAIL/CONTACT_TO/EMAIL_USER missing).');
    return res.status(500).json({ message: 'Mail recipient not configured on server.' });
  }

  console.log('[CONTACT] To:', TO, 'From:', email, 'Len:', message?.length);

  try {
    await transporter.sendMail({
      to: TO,
      from: `"BonzoByte Contact" <${process.env.EMAIL_USER || TO}>`,
      replyTo: `${name} <${email}>`,
      subject: `Contact form — ${name} <${email}>`,
      text: message,
      html: `
        <p><b>From:</b> ${name} &lt;${email}&gt;</p>
        <pre style="white-space:pre-wrap;font-family:inherit">${message}</pre>
      `,
    });

    console.log('[CONTACT] Mail sent to', TO);
    return res.json({ message: 'Message sent.' });
  } catch (err) {
    console.error('[CONTACT] sendMail error:', err);
    return res.status(500).json({ message: 'Mail sending failed.' });
  }
});

export const updateUserProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { nickname } = req.body;

    const updatedData = { nickname };

    if (req.file) {
      updatedData.avatarUrl = `${process.env.BASE_URL}/uploads/${req.file.filename}`;
    }

    const updatedUser = await User.findByIdAndUpdate(userId, updatedData, { new: true });

    if (!updatedUser) {
      return res.status(404).json({ message: 'Korisnik nije pronađen' });
    }

    res.status(200).json({ user: updatedUser });
  } catch (err) {
    console.error(err);

    if (err.code === 11000 && err.keyPattern?.nickname) {
      return res.status(409).json({ message: 'Taj nadimak je već zauzet.' });
    }

    res.status(500).json({ message: 'Greška pri ažuriranju profila.' });
  }
};