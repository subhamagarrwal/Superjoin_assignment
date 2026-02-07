import { Router, Request, Response } from 'express';
import { initializeDatabase } from '../utils/dbInit';
import pino from 'pino';

const router = Router();
const logger = pino();

// Optional manual re-init endpoint (backup only)
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