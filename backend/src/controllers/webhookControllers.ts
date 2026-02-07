import { Request, Response } from 'express';
import sheetUpdateQueue from '../queues/sheetUpdateQueue';
import redisClient from '../config/redis';
import { WebhookPayload } from '../types/types';
import pino from 'pino';

const logger = pino();

// ── Input validation constants ──
const VALID_COL = /^[A-Z]$/;
const MAX_VALUE_LENGTH = 5000;
const SHEET_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_ROW = 10000;

export async function handleWebhook(req: Request, res: Response) {
    try {
        const { row, col, value, sheetId } = req.body as WebhookPayload;

        // ── Presence check ──
        if (!row || !col || value === undefined || !sheetId) {
            res.status(400).json({
                success: false,
                error: 'Missing required fields: row, col, value, sheetId',
            });
            return;
        }

        // ── Type & range validation ──
        if (typeof row !== 'number' || !Number.isInteger(row) || row < 1 || row > MAX_ROW) {
            res.status(400).json({ success: false, error: `row must be an integer between 1 and ${MAX_ROW}` });
            return;
        }

        if (typeof col !== 'string' || !VALID_COL.test(col)) {
            res.status(400).json({ success: false, error: 'col must be a single uppercase letter A-Z' });
            return;
        }

        if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) {
            res.status(400).json({ success: false, error: `value must be a string (max ${MAX_VALUE_LENGTH} chars)` });
            return;
        }

        if (typeof sheetId !== 'string' || !SHEET_ID_PATTERN.test(sheetId)) {
            res.status(400).json({ success: false, error: 'Invalid sheetId format' });
            return;
        }

        const ignoreKey = `ignore:${row}:${col}`;
        const shouldIgnore = await redisClient.get(ignoreKey);

        if (shouldIgnore) {
            logger.info({ row, col }, 'Ignoring webhook - CDC recently synced this cell');
            res.status(200).json({
                success: true,
                message: 'Change ignored (CDC sync)',
            });
            return;
        }

        await sheetUpdateQueue.add(
            'sheet_update',
            {
                row,
                col,
                value,
                sheetId,
                timestamp: Date.now(),
            },
            {
                attempts: 3,
                backoff: { type: 'exponential', delay: 1000 },
            }
        );

        logger.info({ row, col, value }, 'Webhook job queued');

        res.status(202).json({
            success: true,
            message: 'Update queued for processing',
        });
    } catch (error) {
        logger.error({ error }, 'Webhook processing failed');
        res.status(500).json({
            success: false,
            error: 'Failed to queue update',
        });
    }
}