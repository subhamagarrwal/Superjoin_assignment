import pool from '../config/database';
import pino from 'pino';

const logger = pino();

export async function testDatabaseConnection(): Promise<boolean> {
    try {
        await pool.query('SELECT 1');
        logger.info('Database connection successful');
        return true;
    } catch (error) {
        logger.error({ error }, 'Database connection failed');
        return false;
    }
}

export async function initializeDatabase(): Promise<void> {
    try {
        // Create users table if not exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                row_num INT NOT NULL,
                col_name VARCHAR(10) NOT NULL,
                cell_value TEXT,
                last_modified_by VARCHAR(50) DEFAULT 'system',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_cell (row_num, col_name)
            )
        `);

        logger.info('✅ Database initialized - users table ready');
    } catch (error) {
        logger.error({ error }, '❌ Failed to initialize database');
        throw error;
    }
}