import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pino from 'pino';
import webhookRoutes from './routes/webhook_routes';
import sqlRoutes from './routes/sqlroutes';
import setupRoutes from './routes/setup.routes';
import configRoutes from './routes/config.routes';
import { initializeDatabase } from './utils/dbInit';
import cdcMonitor from './services/cdcMonitor';
import './workers/sheetUpdateWorker';

dotenv.config();
const logger = pino();

const app = express();

app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
}));

app.use(express.json());

// Routes
app.use('/api/webhook', webhookRoutes);
app.use('/api/sql', sqlRoutes);
app.use('/api/setup', setupRoutes);
app.use('/api/config', configRoutes);

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;

// Auto-initialize everything on startup
async function startServer() {
    try {
        console.log('🚀 Starting Superjoin Server...\n');

        // Step 1: Initialize database (auto-run)
        console.log('📊 Initializing database...');
        await initializeDatabase();
        console.log('✅ Database initialized\n');

        // Step 2: Initialize CDC Monitor
        console.log('🔄 Initializing CDC Monitor...');
        await cdcMonitor.initialize();
        console.log('✅ CDC Monitor initialized\n');

        // Step 3: Start polling Google Sheet
        console.log('👀 Starting Google Sheet polling...');
        cdcMonitor.start();
        console.log('✅ Polling started (every 3 seconds)\n');

        // Step 4: Start Express server
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

// Auto-start on module load
startServer();

export default app;