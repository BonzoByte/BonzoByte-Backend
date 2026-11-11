import mongoose from 'mongoose';
import User from '../models/user.model.js';
import {privateMessageModels} from '../models/privateMessages.model.js';
import {createPrivateMessages} from './privateMessages.js';
let ready=false;
export const privateMessages=createPrivateMessages({connection:mongoose.connection,User,models:privateMessageModels,available:()=>ready});
export async function initializePrivateMessages(){
 if(process.env.ARCHIVES_ONLY==='true'||process.env.BILLING_LAB_ENABLED==='true')return;
 ready=false;try{await privateMessages.initialize();ready=true;}catch{console.warn('[PRIVATE_MESSAGES] unavailable: initialization required.');}
}
