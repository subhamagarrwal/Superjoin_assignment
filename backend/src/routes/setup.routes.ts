import { Router } from 'express';
import { Request, Response } from 'express';
import { installAppsScript } from '../services/appsScriptInstaller';
import pino from 'pino';

const logger = pino();
const router = Router();

// POST /api/setup/install-script
router.post('/install-script', async (req: Request, res: Response) => {
    try {
        const { sheetId } = req.body;

        if (!sheetId) {
            res.status(400).json({
                success: false,
                error: 'sheetId is required',
            });
            return;
        }

        const success = await installAppsScript(sheetId);

        if (success) {
            logger.info({ sheetId }, 'Apps Script installed');
            res.status(200).json({
                success: true,
                message: 'Google Apps Script installed and deployed',
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to install Apps Script',
            });
        }
    } catch (error: any) {
        logger.error({ error }, 'Setup failed');
        res.status(500).json({
            success: false,
            error: error.message || 'Setup failed',
        });
    }
});

export default router;