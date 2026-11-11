import mongoose from 'mongoose';
import User from '../models/user.model.js';
import { createPresenceReader } from './presence.js';
import { notifications } from './notificationRuntime.js';
import { isBetaAccountAllowed } from './accessPolicy.js';
import { developmentTestAccountAllowed } from './developmentTestAccounts.js';
export const readPresence = createPresenceReader({ connection: mongoose.connection, User, hub: notifications,
    eligible: user => isBetaAccountAllowed(user.email) && developmentTestAccountAllowed(user) });
