import mongoose from 'mongoose';

export default async function connectDB() {
    console.log('MONGO_URI:', process.env.MONGO_URI);
    try {
        mongoose.set('strictQuery', true);
        await mongoose.connect(process.env.MONGO_URI, {
            dbName: process.env.MONGO_DB || undefined,
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 15000
        });
        console.log('MongoDB connected ✅');
    } catch (err) {
        console.error('MongoDB connection failed ❌', err.message);
        throw err; // neka server ne krene bez baze
    }
}