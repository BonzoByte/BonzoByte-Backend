import mongoose from 'mongoose';
import User from '../models/user.model.js';
import { createCompetitionStore } from './competitionStore.js';
import { createCompetition } from './competition.js';
import { COMPETITION_DEMO_ENV, COMPETITION_DEMO_SEED, withCompetitionDemo } from './competitionDemo.js';
import { ACTIVITY_ENV, ACTIVITY_SEED, ACTIVITY_COLLECTION, withRealActivity, realActivityAllowed, assertRealActivityMode } from './realMatchActivity.js';
assertRealActivityMode();

const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
const allowedSources = (process.env.COMPETITION_TRUSTED_SOURCES || '').split(',').map(s => s.trim()).filter(Boolean);
const store = createCompetitionStore({ connection: mongoose.connection, User, environment, allowedSources });
let ready = false, running = false;
const normal = createCompetition({ store, secret: process.env.JWT_SECRET, allowedSources, available: () => ready });
const demoStore = createCompetitionStore({ connection: mongoose.connection, User, environment: COMPETITION_DEMO_ENV });
const legacy = withCompetitionDemo({ normal,
    demo: createCompetition({ store: demoStore, secret: process.env.JWT_SECRET, available: () => ready }),
    metadata: async () => {
        const row = await mongoose.connection.collection('competitionpicks').findOne({ environment: COMPETITION_DEMO_ENV,
            'fixture.seedId': COMPETITION_DEMO_SEED }, { projection: { 'fixture.window': 1 }, maxTimeMS: 3000, timeoutMS: 3000 });
        return row?.fixture?.window || null;
    },
});
const fixtures=createCompetition({store:createCompetitionStore({connection:mongoose.connection,User,environment:ACTIVITY_ENV}),secret:process.env.JWT_SECRET,available:()=>ready});
export const competition=withRealActivity({normal:legacy,fixtures,allowed:()=>realActivityAllowed(process.env,mongoose.connection.name),
    readManifest:()=>mongoose.connection.collection(ACTIVITY_COLLECTION).findOne({_id:ACTIVITY_SEED},{maxTimeMS:5000})});
export async function initializeCompetition() {
    if (process.env.ARCHIVES_ONLY === 'true' || process.env.BILLING_LAB_ENABLED === 'true') return;
    assertRealActivityMode(process.env,mongoose.connection.name);
    try {
        await store.initialize(); ready = true;
        const run = async () => {
            if (running) return; running = true;
            try { await store.reconcile(); }
            catch { console.warn('[COMPETITION] Settlement paused; durable pending work will retry.'); }
            finally { running = false; }
        };
        const timer = setInterval(() => void run(), 60000); timer.unref(); void run();
        console.log(`[COMPETITION] ready; environment=${environment}; trustedFeed=${allowedSources.length > 0}`);
    } catch {
        console.warn('[COMPETITION] Unavailable: check transaction support and indexes. No data was repaired or removed.');
    }
}
