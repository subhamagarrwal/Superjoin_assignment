import { Request, Response } from 'express';
import pool from '../config/database';
import lockService from '../services/lockService';
import cdcMonitor from '../services/cdcMonitor';
import pino from 'pino';

const logger = pino();

const BOT_NAMES = [
    'Bot-Alpha', 'Bot-Bravo', 'Bot-Charlie', 'Bot-Delta',
    'Bot-Echo', 'Bot-Foxtrot', 'Bot-Golf', 'Bot-Hotel',
];

const COLUMNS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const WORDS = [
    'apple', 'banana', 'cherry', 'grape', 'mango',
    'kiwi', 'lemon', 'peach', 'plum', 'melon',
    'orange', 'papaya', 'fig', 'lime', 'pear',
    'zen', 'nova', 'flux', 'apex', 'vibe',
];

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomWord(): string {
    return WORDS[randomInt(0, WORDS.length - 1)];
}

interface BotTask {
    botName: string;
    row: number;
    col: string;
    value: string;
}

interface BotResult {
    botName: string;
    cell: string;
    value: string;
    status: 'success' | 'lock_conflict' | 'error';
    message: string;
    lockWaitMs?: number;
}

async function executeBotTask(task: BotTask): Promise<BotResult> {
    const { botName, row, col, value } = task;
    const cellRef = `${col}${row}`;
    const startTime = Date.now();

    // Try to acquire lock
    const locked = await lockService.acquireLock(row, col, botName);
    const lockWaitMs = Date.now() - startTime;

    if (!locked) {
        const lockInfo = await lockService.isLocked(row, col);
        return {
            botName,
            cell: cellRef,
            value,
            status: 'lock_conflict',
            message: `Lock denied on ${cellRef} — held by ${lockInfo.owner || 'unknown'}`,
            lockWaitMs,
        };
    }

    try {
        // Simulate a small processing delay to increase contention window
        await new Promise(resolve => setTimeout(resolve, randomInt(50, 200)));

        await pool.query(
            `INSERT INTO users (row_num, col_name, cell_value, last_modified_by)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE cell_value = VALUES(cell_value), last_modified_by = VALUES(last_modified_by)`,
            [row, col, value, botName]
        );

        return {
            botName,
            cell: cellRef,
            value,
            status: 'success',
            message: `Wrote "${value}" to ${cellRef}`,
            lockWaitMs,
        };
    } catch (err: any) {
        return {
            botName,
            cell: cellRef,
            value,
            status: 'error',
            message: err.message,
            lockWaitMs,
        };
    } finally {
        await lockService.releaseLock(row, col, botName);
    }
}

export async function runBotSimulation(req: Request, res: Response) {
    try {
        const rawCount = req.body.botCount;
        if (rawCount !== undefined && (typeof rawCount !== 'number' || !Number.isInteger(rawCount) || rawCount < 1)) {
            res.status(400).json({ success: false, error: 'botCount must be a positive integer' });
            return;
        }
        const botCount = Math.min(Math.max(rawCount || 8, 2), 50);
        const contestedCell = {
            row: randomInt(1, 5),
            col: COLUMNS[randomInt(0, 3)],
        };

        logger.info(`🤖 Starting bot simulation: ${botCount} bots, contested cell = ${contestedCell.col}${contestedCell.row}`);

        const tasks: BotTask[] = [];

        for (let i = 0; i < botCount; i++) {
            const botName = BOT_NAMES[i % BOT_NAMES.length] + (i >= BOT_NAMES.length ? `-${Math.floor(i / BOT_NAMES.length) + 1}` : '');

            if (i < Math.ceil(botCount / 2)) {
                // Group A: Multiple bots fight over the SAME cell
                tasks.push({
                    botName,
                    row: contestedCell.row,
                    col: contestedCell.col,
                    value: `${botName}-${randomWord()}`,
                });
            } else {
                // Group B: Random cells (some may still collide)
                tasks.push({
                    botName,
                    row: randomInt(1, 6),
                    col: COLUMNS[randomInt(0, 5)],
                    value: `${botName}-${randomWord()}`,
                });
            }
        }

        // Fire ALL tasks at once (simultaneously)
        const startTime = Date.now();
        const results = await Promise.all(tasks.map(t => executeBotTask(t)));
        const totalMs = Date.now() - startTime;

        // Sync to Google Sheet after all bots finish
        try {
            await cdcMonitor.syncFromDatabase();
        } catch (err) {
            logger.error({ err }, 'Bot sync to sheet failed');
        }

        const summary = {
            totalBots: botCount,
            contestedCell: `${contestedCell.col}${contestedCell.row}`,
            totalTimeMs: totalMs,
            successes: results.filter(r => r.status === 'success').length,
            lockConflicts: results.filter(r => r.status === 'lock_conflict').length,
            errors: results.filter(r => r.status === 'error').length,
        };

        logger.info({ summary }, '🤖 Bot simulation complete');

        res.json({
            success: true,
            summary,
            results: results.sort((a, b) => {
                // Show lock conflicts first
                if (a.status === 'lock_conflict' && b.status !== 'lock_conflict') return -1;
                if (b.status === 'lock_conflict' && a.status !== 'lock_conflict') return 1;
                return 0;
            }),
        });
    } catch (error: any) {
        logger.error({ error: error.message }, 'Bot simulation failed');
        res.status(500).json({ success: false, error: error.message });
    }
}
