import { Router, Request, Response } from 'express';
import { initializeDatabase } from '../utils/dbInit';
import cdcMonitor from '../services/cdcMonitor';
import pino from 'pino';

const router = Router();
const logger = pino();

router.post('/init', async (req: Request, res: Response) => {
    try {
        logger.info('Initializing database');
        await initializeDatabase();
        res.json({ success: true, message: 'Database initialized successfully' });
    } catch (error: any) {
        logger.error({ error }, 'Database initialization failed');
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/force-sync-to-sheet', async (req: Request, res: Response) => {
    try {
        logger.info('Forcing DB → Sheet sync');
        await cdcMonitor.syncFromDatabase();
        res.json({ success: true, message: 'Synced database to Google Sheet' });
    } catch (error: any) {
        logger.error({ error }, 'Force sync failed');
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/init-db', async (req: Request, res: Response) => {
    try {
        await initializeDatabase();
        logger.info('Database manually re-initialized');
        res.json({ success: true, message: 'Database re-initialized' });
    } catch (error: any) {
        logger.error({ error }, 'Manual DB init failed');
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;