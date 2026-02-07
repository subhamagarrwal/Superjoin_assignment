import { Router, Request, Response } from 'express';

const router = Router();

router.get('/sheet-id', (req: Request, res: Response) => {
    res.json({
        sheetId: process.env.GOOGLE_SHEET_ID || null,
    });
});

export default router;