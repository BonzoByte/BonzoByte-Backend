import mongoose from 'mongoose';
import User from '../models/user.model.js';
import { createFantasyStore } from './fantasyStore.js';
import { grantFantasyPremium } from './fantasyPremium.js';
const enabled=process.env.FANTASY_ENABLED==='true'||(process.env.NODE_ENV==='development'&&process.env.FANTASY_ENABLED!=='false');
let ready=false;
export const fantasy=createFantasyStore({connection:mongoose.connection,User,
    environment:process.env.NODE_ENV==='production'?'production':'development',
    grantPremium:entry=>grantFantasyPremium(User,entry)});
export const fantasyAvailable=()=>enabled&&ready;
export async function initializeFantasy(){
    if(!enabled||process.env.ARCHIVES_ONLY==='true'||process.env.BILLING_LAB_ENABLED==='true')return;
    try{await fantasy.initialize();ready=true;console.log('[FANTASY] ready; isolated collections, no auto-import or automatic prize grants.');}
    catch{console.warn('[FANTASY] unavailable: verify transaction support and indexes. Existing data is unchanged.');}
}
