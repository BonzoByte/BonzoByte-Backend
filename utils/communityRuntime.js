import mongoose from 'mongoose';
import User from '../models/user.model.js';
import { communityModels, COMMUNITY_COLLECTIONS } from '../models/community.model.js';
import { createDiscussionStore } from './discussionStore.js';
import { createCommunity } from './community.js';
import { communityModerator } from './communityPolicy.js';
import { communityFollowingPipeline } from './communityFollowing.js';
import { createCommunityModeration } from './communityModeration.js';
import { notificationDelivery } from './notificationRuntime.js';
const store = createDiscussionStore({ connection: mongoose.connection, User, names: COMMUNITY_COLLECTIONS, models: communityModels, canModerate: communityModerator, followingPipeline: communityFollowingPipeline });
let ready = false;
export const communityEnabled = () => process.env.COMMUNITY_ENABLED === 'true';
export const community = createCommunity({ connection: mongoose.connection, store, available: () => ready });
export const communityModeration = createCommunityModeration({ connection: mongoose.connection, store, available: () => ready, notify: notificationDelivery });
export async function initializeCommunity() {
    if (!communityEnabled()) return;
    try { await store.initialize(); await community.initialize(); ready = true; } catch { console.warn('[COMMUNITY] unavailable: indexes/transactions required.'); }
}
