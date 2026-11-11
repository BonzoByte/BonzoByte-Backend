import express from 'express';
import protect from '../middleware/auth.middleware.js';
import upload from '../middleware/upload.middleware.js';
import {
  updateUserProfile,
  getUserProfile
} from '../controllers/user.controller.js';

const router = express.Router();

router.get('/getUserProfile', protect, getUserProfile);
router.patch('/updateUserProfile', protect, upload.single('avatar'), updateUserProfile);

export default router;
