import mongoose from 'mongoose';
import User from '../models/user.model.js';
import Match from '../models/match.model.js';
import FavouriteMatch from '../models/favouriteMatch.model.js';
import { readArchiveBuffer, locateRecoveryArchiveDate } from '../routes/archives.routes.js';
import { createFavourites, createFavouritesAvailability } from './favourites.js';
import { createFavouritesStore } from './favouritesStore.js';
import { createFavouritesResolver } from './favouritesResolver.js';

const store = createFavouritesStore({ connection: mongoose.connection, User, FavouriteMatch });
const availability = createFavouritesAvailability({ store });
export const favourites = createFavourites({ store, available: availability.available,
    resolver: createFavouritesResolver({ Match, readBuffer: readArchiveBuffer, locateDate: locateRecoveryArchiveDate }) });
export async function initializeFavourites() {
    if (process.env.ARCHIVES_ONLY === 'true' || process.env.BILLING_LAB_ENABLED === 'true') return;
    await availability.initialize();
}
