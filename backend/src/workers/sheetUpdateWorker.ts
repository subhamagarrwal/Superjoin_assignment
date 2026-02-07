import { Worker, Job } from 'bullmq';
import redisClient from '../config/redis';
import pool from '../config/database';
import lockService from '../services/lockService';
import cdcMonitor from '../services/cdcMonitor';
import { JobData } from '../types/types';
import pino from 'pino';

const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
        },
    },
});

const sheetUpdateWorker = new Worker(
    'sheet-update',
    async (job: Job<JobData>) => {
        const { row, col, value, sheetId, timestamp } = job.data;
        const lockOwner = `job:${job.id}`;

        console.log(`\n🔄 [Job ${job.id}] Processing cell ${col}${row} = "${value}"`);

        try {
            console.log(`🔒 [Job ${job.id}] Attempting to acquire lock for ${col}${row}...`);
            const locked = await lockService.acquireLock(row, col, lockOwner);

            if (!locked) {
                console.log(`❌ [Job ${job.id}] Failed to acquire lock for ${col}${row}`);
                throw new Error(`Could not acquire lock for ${col}${row}`);
            }

            console.log(`✅ [Job ${job.id}] Lock acquired for ${col}${row}`);

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
                console.log(`📝 [Job ${job.id}] Updated ${col}${row} = "${value}"`);
            } else {
                await pool.query(
                    `INSERT INTO users (row_num, col_name, cell_value, last_modified_by)
                     VALUES (?, ?, ?, ?)`,
                    [row, col, value, 'user']
                );
                console.log(`📝 [Job ${job.id}] Inserted ${col}${row} = "${value}"`);
            }

            await lockService.releaseLock(row, col, lockOwner);
            console.log(`🔓 [Job ${job.id}] Lock released for ${col}${row}`);

            return { success: true, row, col, value };
        } catch (error) {
            await lockService.releaseLock(row, col, lockOwner);
            console.log(`❌ [Job ${job.id}] Error: ${error}`);
            throw error;
        }
    },
    {
        connection: redisClient,
        concurrency: 5,
        limiter: {
            max: 55,        
            duration: 60000, 
        },
    }
);

sheetUpdateWorker.on('completed', (job) => {
    console.log(`✅ [Job ${job?.id}] Completed successfully\n`);
    cdcMonitor.debouncedSyncFromDatabase();
});

sheetUpdateWorker.on('failed', (job, err) => {
    console.log(`❌ [Job ${job?.id}] Failed: ${err.message}\n`);
});

console.log('🚀 Sheet update worker started');

export default sheetUpdateWorker;

