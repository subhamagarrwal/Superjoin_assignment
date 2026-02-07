import { Request, Response } from 'express';
import pool from '../config/database';
import cdcMonitor from '../services/cdcMonitor';
import pino from 'pino';

const logger = pino();

export async function executeSQL(req: Request, res: Response) {
    try {
        let { query } = req.body;

        if (!query) {
            res.status(400).json({ success: false, error: 'Query is required' });
            return;
        }

        // Block dangerous queries
        const forbidden = ['DROP DATABASE', 'DROP TABLE', 'TRUNCATE'];
        const upperQuery = query.toUpperCase().trim();

        for (const word of forbidden) {
            if (upperQuery.includes(word)) {
                res.status(403).json({ success: false, error: `Forbidden: ${word} not allowed` });
                return;
            }
        }

        const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(query);

        // Auto-inject last_modified_by for UPDATE queries
        if (/^\s*UPDATE\s+users/i.test(query) && !/last_modified_by/i.test(query)) {
            query = query.replace(
                /(\s+WHERE)/i,
                ", last_modified_by = 'sql_terminal'$1"
            );
            console.log('🔧 Auto-added last_modified_by to UPDATE query');
        }

        // Execute the query
        const [result]: any = await pool.query(query);

        // If write query, sync to Google Sheet
        if (isWrite) {
            console.log('🔄 Write query executed, syncing to Google Sheet...');
            
            setTimeout(async () => {
                try {
                    await cdcMonitor.syncFromDatabase();
                    console.log('✅ DB → Sheet sync completed');
                } catch (err) {
                    console.error('❌ DB → Sheet sync failed:', err);
                }
            }, 1000);
        }

        if (Array.isArray(result)) {
            res.json({
                success: true,
                data: result,
                rowsAffected: result.length,
            });
        } else {
            res.json({
                success: true,
                data: [],
                rowsAffected: result.affectedRows || 0,
            });
        }

        logger.info({ query }, 'SQL executed');
    } catch (error: any) {
        logger.error({ error: error.message }, 'SQL execution failed');
        res.status(400).json({
            success: false,
            error: error.message || 'SQL execution failed',
        });
    }
}