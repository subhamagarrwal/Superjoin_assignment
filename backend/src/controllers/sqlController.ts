import { Request, Response } from 'express';
import pool from '../config/database';
import cdcMonitor from '../services/cdcMonitor';
import lockService from '../services/lockService';
import pino from 'pino';

const logger = pino();

function parseAffectedCells(query: string): { row: number; col: string }[] {
    const cells: { row: number; col: string }[] = [];
    const upper = query.toUpperCase().trim();

    // INSERT INTO users (row_num, col_name, ...) VALUES (2, 'B', ...)
    const insertMatch = query.match(/VALUES\s*\(\s*(\d+)\s*,\s*'([A-Za-z])'/i);
    if (insertMatch) {
        cells.push({ row: parseInt(insertMatch[1]), col: insertMatch[2].toUpperCase() });
        return cells; // INSERT only affects one cell
    }

    // UPDATE/DELETE with WHERE row_num = X AND col_name = 'Y'
    // Must have BOTH row_num AND col_name to identify a specific cell
    const rowMatch = query.match(/row_num\s*=\s*(\d+)/i);
    const colMatch = query.match(/col_name\s*=\s*'([A-Za-z])'/i);
    
    if (rowMatch && colMatch) {
        cells.push({ row: parseInt(rowMatch[1]), col: colMatch[1].toUpperCase() });
    }
    // If only row_num is specified (no col_name), we can't lock a specific cell
    // This means the query affects multiple cells - let it run without cell-level locking
    // The DB will handle row-level consistency

    return cells;
}

export async function executeSQL(req: Request, res: Response) {
    const owner = req.body.owner || `user_${Date.now()}`;

    try {
        let { query } = req.body;

        if (!query || typeof query !== 'string') {
            res.status(400).json({ success: false, error: 'Query is required' });
            return;
        }

        // NOTE: Comprehensive SQL injection protection is handled by sqlGuard middleware
        // (keyword blocklist, dangerous-function detection, table restriction, length limit).
        // This controller trusts that the middleware has already filtered malicious input.

        const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(query);

        const affectedCells = isWrite ? parseAffectedCells(query) : [];
        const acquiredLocks: { row: number; col: string }[] = [];

        if (isWrite && affectedCells.length > 0) {
            for (const cell of affectedCells) {
                // Validate cell coordinates before attempting lock
                if (!cell.row || !cell.col) {
                    console.warn('⚠️ Skipping lock for invalid cell:', cell);
                    continue;
                }

                const locked = await lockService.acquireLock(cell.row, cell.col, owner);
                if (!locked) {
                    for (const acquired of acquiredLocks) {
                        await lockService.releaseLock(acquired.row, acquired.col, owner);
                    }
                    const cellName = `${cell.col}${cell.row}`;
                    res.status(409).json({
                        success: false,
                        error: `Cell ${cellName} is locked by another user. Try again.`,
                        lockConflict: true,
                        cell: cellName,
                        owner,
                    });
                    return;
                }
                acquiredLocks.push(cell);
            }
        }

        try {
            // Check if UPDATE targets an empty cell (cell that doesn't exist)
            const isUpdate = /^\s*UPDATE\s+users/i.test(query);
            if (isUpdate && affectedCells.length > 0) {
                for (const cell of affectedCells) {
                    const [rows]: any = await pool.query(
                        'SELECT id FROM users WHERE row_num = ? AND col_name = ?',
                        [cell.row, cell.col]
                    );
                    if (!rows || rows.length === 0) {
                        // Release any acquired locks before returning error
                        for (const acquired of acquiredLocks) {
                            await lockService.releaseLock(acquired.row, acquired.col, owner);
                        }
                        const cellName = `${cell.col}${cell.row}`;
                        res.status(400).json({
                            success: false,
                            error: `Cannot update an empty cell. Cell ${cellName} does not exist. Use INSERT to create it first.`,
                        });
                        return;
                    }
                }
            }

            if (isUpdate && !/last_modified_by/i.test(query)) {
                query = query.replace(
                    /(\s+WHERE)/i,
                    ", last_modified_by = 'sql_terminal'$1"
                );
            }

            const [result]: any = await pool.query(query);

            if (isWrite) {
                cdcMonitor.debouncedSyncFromDatabase();
            }

            if (Array.isArray(result)) {
                res.json({
                    success: true,
                    data: result,
                    rowsAffected: result.length,
                    fromCache: false,
                });
            } else {
                res.json({
                    success: true,
                    data: [],
                    rowsAffected: result.affectedRows || 0,
                    fromCache: false,
                });
            }

            if (isWrite) {
                logger.info({ query, owner }, 'SQL write executed');
            }
        } finally {
            for (const cell of acquiredLocks) {
                await lockService.releaseLock(cell.row, cell.col, owner);
            }
        }
    } catch (error: any) {
        // Check if DB is offline - try to serve from cache for SELECT queries
        const isDbOffline = isDbOfflineError(error);
        const isSelect = /^\s*SELECT/i.test(req.body.query);
        
        if (isDbOffline && isSelect) {
            // Return cached data for SELECT queries
            const cachedSnapshot = cdcMonitor.getCachedSnapshot();
            if (cachedSnapshot.size > 0) {
                // Convert snapshot to rows format
                const rows: any[] = [];
                for (const [key, value] of cachedSnapshot.entries()) {
                    const [rowNum, colName] = key.split(':');
                    rows.push({
                        row_num: parseInt(rowNum),
                        col_name: colName,
                        cell_value: value,
                        last_modified_by: 'cached'
                    });
                }
                
                res.json({
                    success: true,
                    data: rows,
                    rowsAffected: rows.length,
                    fromCache: true,
                    warning: 'Database is offline. Showing cached data.',
                });
                return;
            }
        }
        
        logger.error({ error: error.message, owner }, 'SQL execution failed');
        res.status(isDbOffline ? 503 : 400).json({
            success: false,
            error: isDbOffline 
                ? 'Database is currently unavailable. Please try again later.'
                : (error.message || 'SQL execution failed'),
            dbOffline: isDbOffline,
        });
    }
}

/**
 * Check if an error indicates DB is offline
 */
function isDbOfflineError(error: any): boolean {
    const offlineErrors = [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'PROTOCOL_CONNECTION_LOST',
        'ECONNRESET'
    ];
    return offlineErrors.some(e => 
        error.code === e || 
        error.message?.includes(e) ||
        error.errno === e
    );
}