import { Worker, Job } from 'bullmq';
import redisClient from '../config/redis';
import pool from '../config/database';
import { JobData } from '../types/types';
import pino from 'pino';

const logger = pino();

const sheetUpdateWorker = new Worker(
    'sheet-update',
    async (job: Job<JobData>) => {
        const { row, col, value, sheetId, timestamp } = job.data;

        try {
            logger.info({ row, col, value }, 'Processing sheet update job');

            const [existing] = await pool.query<any[]>(
                'SELECT * FROM users WHERE row_num = ? AND col_name = ?',
                [row, col]
            );

            if (existing.length > 0) {
                await pool.query(
                    `UPDATE users 
                     SET cell_value = ?, last_modified_by = ?, updated_at = NOW()
                     WHERE row_num = ? AND col_name = ?`,
                    [value, 'user', row, col]
                );
                logger.info({ row, col }, 'Cell updated');
            } else {
                await pool.query(
                    `INSERT INTO users (row_num, col_name, cell_value, last_modified_by)
                     VALUES (?, ?, ?, ?)`,
                    [row, col, value, 'user']
                );
                logger.info({ row, col }, 'Cell inserted');
            }

            return { success: true, row, col, value };
        } catch (error) {
            logger.error({ error }, 'Job processing failed');
            throw error;
        }
    },
    {
        connection: redisClient,
        concurrency: 5,
        limiter: {
            max: 10,
            duration: 1000,
        },
    }
);

sheetUpdateWorker.on('completed', (job) => {
    logger.info({ jobId: job?.id }, 'Job completed');
});

sheetUpdateWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, error: err }, 'Job failed');
});

sheetUpdateWorker.on('error', (err) => {
    logger.error({ error: err }, 'Worker error');
});

logger.info('Sheet update worker started');

export default sheetUpdateWorker;

