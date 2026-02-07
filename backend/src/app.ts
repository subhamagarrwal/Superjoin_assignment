import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pino from 'pino';
import webhookRoutes from './routes/webhook_routes';
import sqlRoutes from './routes/sqlroutes';
import setupRoutes from './routes/setup.routes';
import configRoutes from './routes/config.routes';
import botRoutes from './routes/bot.routes';
import { initializeDatabase } from './utils/dbInit';
import cdcMonitor from './services/cdcMonitor';
import sheetUpdateWorker from './workers/sheetUpdateWorker';
import pool from './config/database';
import redisClient from './config/redis';

dotenv.config();
const logger = pino();

const app = express();

app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:3000', process.env.FRONTEND_URL],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
}));

app.use(express.json());

app.use('/api/webhook', webhookRoutes);
app.use('/api/sql', sqlRoutes);
app.use('/api/setup', setupRoutes);
app.use('/api/config', configRoutes);
app.use('/api/bots', botRoutes);

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        console.log('🚀 Starting Superjoin Server...\n');

        console.log('📊 Initializing database...');
        await initializeDatabase();
        console.log('✅ Database initialized\n');

        console.log('🔄 Initializing CDC Monitor...');
        await cdcMonitor.initialize();
        console.log('✅ CDC Monitor initialized\n');

        console.log('👀 Starting Google Sheet polling...');
        cdcMonitor.start();
        console.log('✅ Polling started (every 3 seconds)\n');

        app.listen(PORT, () => {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`✅ Server running on http://localhost:${PORT}`);
            console.log(`🌐 Frontend: http://localhost:5173`);
            console.log(`📊 Google Sheet ID: ${process.env.GOOGLE_SHEET_ID}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            console.log('Ready to sync! 🚀\n');
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
    console.log(`\n⏹️ ${signal} received, shutting down gracefully...`);
    
    console.log('🔄 Stopping CDC Monitor...');
    cdcMonitor.stop();
    
    console.log('🔄 Closing Sheet Update Worker...');
    await sheetUpdateWorker.close();
    
    console.log('🔄 Closing database pool...');
    await pool.end();
    
    console.log('🔄 Closing Redis connection...');
    await redisClient.quit();
    
    console.log('✅ All services stopped. Goodbye!\n');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', async (error) => {
    console.error('❌ Uncaught exception:', error);
    await gracefulShutdown('UNCAUGHT_EXCEPTION');
});

startServer();

export default app;