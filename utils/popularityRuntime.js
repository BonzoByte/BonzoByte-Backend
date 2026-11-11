import mongoose from 'mongoose';
import User from '../models/user.model.js';
import Player from '../models/player.model.js';
import Match from '../models/match.model.js';
import TournamentEvent from '../models/tournamentEvent.model.js';
import Country from '../models/country.model.js';
import { popularityConfig } from '../config/popularity.js';
import { createPopularity } from './popularity.js';
import { createPopularityStore } from './popularityStore.js';
import { createPopularityEntityResolver } from './popularityEntities.js';
import { createPopularityArchiveReader } from './popularityArchives.js';
import { readArchiveBuffer } from '../routes/archives.routes.js';
import { ACTIVITY_SEED, ACTIVITY_COLLECTION, withRealPopularity, realActivityAllowed, assertRealActivityMode } from './realMatchActivity.js';
assertRealActivityMode();

const config = popularityConfig();
let ready = false;
const store = createPopularityStore({ connection: mongoose.connection, User, config });
const normalPopularity = createPopularity({ store, environment: config.environment,
    resolveEntity: createPopularityEntityResolver({ Player, Match, TournamentEvent, Country,
        readArchive: createPopularityArchiveReader(readArchiveBuffer) }),
    available: () => ready && config.enabled, withdrawalAvailable: () => ready });
export const popularity=withRealPopularity({normal:normalPopularity,allowed:()=>ready&&realActivityAllowed(process.env,mongoose.connection.name),
    readManifest:()=>mongoose.connection.collection(ACTIVITY_COLLECTION).findOne({_id:ACTIVITY_SEED},{maxTimeMS:5000})});

export async function initializePopularity() {
    if (process.env.ARCHIVES_ONLY === 'true' || process.env.BILLING_LAB_ENABLED === 'true') return;
    assertRealActivityMode(process.env,mongoose.connection.name);
    try {
        const hello = await mongoose.connection.db.admin().command({ hello: 1 });
        if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Transactions required');
        await store.initialize();
        ready = true;
    } catch {
        // No connection strings, entity IDs or personal details in diagnostics.
        console.warn('[POPULARITY] unavailable: transaction/index initialization required.');
    }
}
