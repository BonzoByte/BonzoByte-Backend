import mongoose from 'mongoose';
import User from '../models/user.model.js';
import { communityModels, COMMUNITY_COLLECTIONS } from '../models/community.model.js';
import { createDiscussionStore } from './discussionStore.js';
import { createCommunity } from './community.js';
import { communityModerator } from './communityPolicy.js';
const store = createDiscussionStore({ connection: mongoose.connection, User, names: COMMUNITY_COLLECTIONS, models: communityModels, canModerate: communityModerator });
let ready = false;
export const communityEnabled = () => process.env.COMMUNITY_ENABLED === 'true';
export const community = createCommunity({ connection: mongoose.connection, store, available: () => ready });
export async function initializeCommunity() {
    if (!communityEnabled()) return;
    try { await store.initialize(); ready = true; } catch { console.warn('[COMMUNITY] unavailable: indexes/transactions required.'); }
}
