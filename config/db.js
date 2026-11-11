import mongoose from 'mongoose';
import dns from 'node:dns';
import { assertBillingLabEnvironment, assertBillingLabDatabase } from '../utils/billingLabSafety.js';

export default async function connectDB() {
    const billingLab = assertBillingLabEnvironment();
    console.log('Mongo URI configured:', process.env.MONGO_URI ? 'yes' : 'no');
    try {
        const configuredDnsServers = String(process.env.DNS_SERVERS || '')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean);
        if (configuredDnsServers.length > 0) {
            dns.setServers(configuredDnsServers);
        }

        mongoose.set('strictQuery', true);
        await mongoose.connect(process.env.MONGO_URI, {
            dbName: process.env.MONGO_DB || undefined,
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 15000
        });
        if (billingLab) assertBillingLabDatabase(mongoose.connection);
        console.log('MongoDB connected ✅');
    } catch (err) {
        console.error('MongoDB connection failed ❌', err.message);
        throw err; // Do not start the server without a database connection.
    }
}
