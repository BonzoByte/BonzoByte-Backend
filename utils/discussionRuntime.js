import mongoose from 'mongoose';
import User from '../models/user.model.js';
import Match from '../models/match.model.js';
import { discussionModels } from '../models/discussion.model.js';
import { readArchiveBuffer, locateRecoveryArchiveDate } from '../routes/archives.routes.js';
import { createFavouritesResolver } from './favouritesResolver.js';
import { createDiscussionStore } from './discussionStore.js';
import { createDiscussions, createDiscussionAvailability } from './discussions.js';

const store = createDiscussionStore({ connection: mongoose.connection, User, models: discussionModels,
    diagnostic: event => {
        if (event.outcome === 'failed' && event.category !== 'rejected')
            console.warn('[DISCUSSIONS] ' + JSON.stringify(event));
    } });
const availability = createDiscussionAvailability({ store });
export const discussions = createDiscussions({ store, available: availability.available,
    resolver: createFavouritesResolver({ Match, readBuffer: readArchiveBuffer, locateDate: locateRecoveryArchiveDate }) });
export async function initializeDiscussions() {
    if (process.env.ARCHIVES_ONLY === 'true' || process.env.BILLING_LAB_ENABLED === 'true') return;
    await availability.initialize();
}
