import { Router, Request, Response } from 'express';
import cdcMonitor from '../services/cdcMonitor';

const router = Router();

router.get('/sheet-id', (req: Request, res: Response) => {
    res.json({
        sheetId: process.env.GOOGLE_SHEET_ID || null,
    });
});

/**
 * Get system status including connectivity and cache info
 */
router.get('/status', (req: Request, res: Response) => {
    const status = cdcMonitor.getStatus();
    res.json({
        ...status,
        timestamp: new Date().toISOString(),
        pollInterval: parseInt(process.env.POLL_INTERVAL || '3000'),
    });
});

/**
 * Get cached snapshot data (for offline reads)
 */
router.get('/cached-data', (req: Request, res: Response) => {
    const snapshot = cdcMonitor.getCachedSnapshot();
    const data: Record<string, string> = {};
    
    for (const [key, value] of snapshot.entries()) {
        data[key] = value;
    }
    
    res.json({
        fromCache: true,
        cellCount: snapshot.size,
        data,
        timestamp: new Date().toISOString(),
    });
});

export default router;