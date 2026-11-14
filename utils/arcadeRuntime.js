import mongoose from 'mongoose';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import User from '../models/user.model.js';
import { createArcadeCatalog } from './arcadeCatalog.js';
import { createArcadeStore } from './arcadeStore.js';
import { createArcade } from './arcade.js';
import { arcadeRuntimeSettings } from './arcadeRuntimeSettings.js';
const settings = arcadeRuntimeSettings();
const enabled = settings.enabled;
let ready = false;
const store = createArcadeStore({ connection: mongoose.connection, User });
const catalog = createArcadeCatalog({ load: async () => {
    const file=settings.file,expected=settings.digest;
    if(!file)throw Error('Verified game catalogue required');
    if(!/^[a-f0-9]{64}$/.test(expected||''))throw Error('Verified game catalogue digest required');
    const bytes=await readFile(file);
    if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Game catalogue changed');
    return {bytes,version:expected,encoding:'json'};
} });
export const arcade = createArcade({ store, catalog, available: () => enabled && ready });
export async function initializeArcade() {
    if (!enabled || process.env.ARCHIVES_ONLY === 'true' || process.env.BILLING_LAB_ENABLED === 'true') return;
    try {
        if (settings.beta && mongoose.connection.name !== 'BonzoByte_Beta') throw Error('Beta database required');
        await catalog.search(''); await store.initialize(); ready = true;
        console.log('[ARCADE] private trial ready; rewards disabled.');
    }
    catch { console.warn('[ARCADE] trial unavailable: check verified catalogue, transaction support and indexes. Nothing was repaired or deleted.'); }
}
