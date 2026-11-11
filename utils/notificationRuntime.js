import mongoose, { Types } from 'mongoose';
import User from '../models/user.model.js';
import { isBetaAccountAllowed } from './accessPolicy.js';
import { developmentTestAccountAllowed } from './developmentTestAccounts.js';
import { createNotificationHub } from './notificationHub.js';
import { createNotificationDelivery } from './notificationRecipients.js';

export const notifications = createNotificationHub({ validate: async ids => {
    const rows = await User.collection.find({ _id: { $in: ids.map(id => new Types.ObjectId(id)) } }, {
        projection: { _id: 1, tokenVersion: 1, isVerified: 1, accountClosure: 1, email: 1, testAccount: 1 }, maxTimeMS: 2000, timeoutMS: 2500
    }).limit(ids.length).toArray();
    return new Map(rows.map(user => [String(user._id), { tokenVersion: user.tokenVersion ?? 0, closed: !!user.accountClosure?.requestedAt,
        eligible: user.isVerified === true && isBetaAccountAllowed(user.email) && developmentTestAccountAllowed(user) }]));
} });
export const notificationDelivery = createNotificationDelivery({ connection: mongoose.connection, hub: notifications });
export const notificationsAvailable = () => mongoose.connection.readyState === 1;
