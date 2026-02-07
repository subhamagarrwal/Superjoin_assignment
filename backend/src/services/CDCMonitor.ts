import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import pool from '../config/database';
import redisClient from '../config/redis';
import pino from 'pino';
import dotenv from 'dotenv';
dotenv.config();    
const logger = pino();

const SHEET_ID = process.env.GOOGLE_SHEET_ID!;
// Minimum 3 seconds to stay well under Google's 300 req/min quota
const POLL_INTERVAL = Math.max(3000, parseInt(process.env.POLL_INTERVAL || '3000'));
const SHEET_RANGE = process.env.SHEET_RANGE || 'Sheet1!A1:H20';

export class CDCMonitor {
    private lastSnapshot: Map<string, string> = new Map();
    private sheets: any;
    private isRunning = false;
    private intervalId: NodeJS.Timeout | null = null;
    private isPollInProgress = false;

    // Rate limit backoff
    private rateLimitedUntil: number = 0;
    private rateLimitBackoffMs: number = 5000; // Start with 5s backoff
    private consecutiveRateLimits: number = 0;

    private syncDebounceTimer: NodeJS.Timeout | null = null;
    private readonly SYNC_DEBOUNCE = 500;

    async initialize() {
        try {
            const jwtClient = new JWT({
                email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
                key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });

            await jwtClient.authorize();
            this.sheets = google.sheets({ version: 'v4', auth: jwtClient });
            await this.loadInitialSnapshot();

            console.log('✅ CDC Monitor initialized');
        } catch (error) {
            console.error('❌ CDC Monitor initialization failed:', error);
            throw error;
        }
    }

    private async loadInitialSnapshot() {
        const data = await this.fetchSheetData();
        if (!data) return;

        for (const [key, value] of data.entries()) {
            this.lastSnapshot.set(key, value);
        }

        await this.syncToDatabase(data);
        console.log(`📊 Initial snapshot loaded: ${data.size} cells`);
    }

    /**
     * Fetches data from the Google Sheets API with rate-limit protection.
     * Uses exponential backoff when rate-limited to avoid flooding the API.
     */
    private async fetchSheetData(): Promise<Map<string, string> | null> {
        // If we're in a rate-limit backoff window, skip this fetch
        const now = Date.now();
        if (now < this.rateLimitedUntil) {
            // Silently skip - don't log every time
            return null;
        }

        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: SHEET_ID,
                range: SHEET_RANGE,
            });

            // Success - reset backoff
            if (this.consecutiveRateLimits > 0) {
                console.log('✅ Rate limit cleared, resuming normal polling');
            }
            this.consecutiveRateLimits = 0;
            this.rateLimitBackoffMs = 5000;

            const rows = response.data.values || [];
            const cellMap = new Map<string, string>();

            rows.forEach((row: string[], rowIndex: number) => {
                row.forEach((value: string, colIndex: number) => {
                    const colName = String.fromCharCode(65 + colIndex);
                    const rowNum = rowIndex + 1;
                    const key = `${rowNum}:${colName}`;
                    cellMap.set(key, value || '');
                });
            });

            return cellMap;
        } catch (error: any) {
            if (error.code === 429 || error.status === 429) {
                this.consecutiveRateLimits++;
                // Exponential backoff: 5s, 10s, 20s, 40s, max 60s
                this.rateLimitBackoffMs = Math.min(60000, this.rateLimitBackoffMs * 2);
                this.rateLimitedUntil = Date.now() + this.rateLimitBackoffMs;
                
                // Only log the first hit and when backoff increases
                if (this.consecutiveRateLimits === 1) {
                    console.warn(`⚠️ Rate limited by Google Sheets API. Backing off for ${this.rateLimitBackoffMs / 1000}s...`);
                } else if (this.consecutiveRateLimits % 5 === 0) {
                    console.warn(`⚠️ Still rate limited (attempt ${this.consecutiveRateLimits}). Backoff: ${this.rateLimitBackoffMs / 1000}s`);
                }
            } else {
                console.error('❌ Failed to fetch sheet data:', error.message || error);
            }
            return null;
        }
    }

    private async syncToDatabase(data: Map<string, string>) {
        for (const [key, value] of data.entries()) {
            const [rowStr, col] = key.split(':');
            const row = parseInt(rowStr);

            if (!value || value.trim() === '') continue;

            try {
                await pool.query(
                    `INSERT INTO users (row_num, col_name, cell_value, last_modified_by)
                     VALUES (?, ?, ?, 'sheet')
                     ON DUPLICATE KEY UPDATE 
                        cell_value = VALUES(cell_value),
                        last_modified_by = 'sheet'`,
                    [row, col, value]
                );
            } catch (error) {
                console.error(`❌ Failed to sync cell ${col}${row}:`, error);
            }
        }
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;

        console.log(`🔄 CDC Monitor started (polling every ${POLL_INTERVAL}ms)`);

        this.intervalId = setInterval(async () => {
            await this.pollForChanges();
        }, POLL_INTERVAL);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        console.log('⏹️ CDC Monitor stopped');
    }

    private async pollForChanges() {
        // Prevent overlapping polls (if a fetch is slow and the next interval fires)
        if (this.isPollInProgress) return;
        this.isPollInProgress = true;

        try {
            const currentData = await this.fetchSheetData();
            if (!currentData) return;

            const changes: { row: number; col: string; oldValue: string; newValue: string }[] = [];

            for (const [key, newValue] of currentData.entries()) {
                const oldValue = this.lastSnapshot.get(key) || '';
                if (oldValue !== newValue) {
                    const [rowStr, col] = key.split(':');
                    changes.push({
                        row: parseInt(rowStr),
                        col,
                        oldValue,
                        newValue,
                    });
                }
            }

            for (const [key, oldValue] of this.lastSnapshot.entries()) {
                if (!currentData.has(key) && oldValue !== '') {
                    const [rowStr, col] = key.split(':');
                    changes.push({
                        row: parseInt(rowStr),
                        col,
                        oldValue,
                        newValue: '',
                    });
                }
            }

            if (changes.length > 0) {
                console.log(`\n📝 Detected ${changes.length} change(s) from Google Sheet:`);

                for (const change of changes) {
                    console.log(`   ${change.col}${change.row}: "${change.oldValue}" → "${change.newValue}"`);

                    const ignoreKey = `ignore:${change.row}:${change.col}`;
                    await redisClient.set(ignoreKey, '1', 'EX', 10).catch(() => {});

                    try {
                        if (change.newValue === '') {
                            await pool.query(
                                'DELETE FROM users WHERE row_num = ? AND col_name = ?',
                                [change.row, change.col]
                            );
                        } else {
                            await pool.query(
                                `INSERT INTO users (row_num, col_name, cell_value, last_modified_by)
                                 VALUES (?, ?, ?, 'sheet')
                                 ON DUPLICATE KEY UPDATE cell_value = VALUES(cell_value), last_modified_by = 'sheet'`,
                                [change.row, change.col, change.newValue]
                            );
                        }
                        console.log(`   ✅ Synced ${change.col}${change.row} to database`);
                    } catch (error) {
                        console.error(`   ❌ Failed to sync ${change.col}${change.row}:`, error);
                    }
                }
            }

            this.lastSnapshot = currentData;
        } finally {
            this.isPollInProgress = false;
        }
    }

    debouncedSyncFromDatabase() {
        if (this.syncDebounceTimer) {
            clearTimeout(this.syncDebounceTimer);
        }
        this.syncDebounceTimer = setTimeout(async () => {
            try {
                await this.syncFromDatabase();
            } catch (err) {
                console.error('❌ Debounced DB → Sheet sync failed:', err);
            }
        }, this.SYNC_DEBOUNCE);
    }

    async syncFromDatabase() {
        try {
            const [dbRows]: any = await pool.query(
                `SELECT row_num, col_name, cell_value, last_modified_by FROM users 
                 ORDER BY row_num, col_name`
            );

            // Fetch FRESH sheet state for accurate comparison
            const sheetData = await this.fetchSheetData();
            if (!sheetData) return;

            const updates: { range: string; values: string[][] }[] = [];
            const cellsToSync: Set<string> = new Set();
            const syncedCells: { row: number; col: string; value: string }[] = [];

            for (const row of dbRows) {
                const key = `${row.row_num}:${row.col_name}`;
                cellsToSync.add(key);
                
                const sheetValue = sheetData.get(key) || '';
                const dbValue = row.cell_value || '';

                if (dbValue !== sheetValue && row.last_modified_by !== 'sheet') {
                    const range = `Sheet1!${row.col_name}${row.row_num}`;
                    updates.push({
                        range,
                        values: [[dbValue]],
                    });
                    syncedCells.push({ row: row.row_num, col: row.col_name, value: dbValue });
                    console.log(`   📤 DB→Sheet: ${row.col_name}${row.row_num} = "${dbValue}"`);
                }
            }

            for (const [key, sheetValue] of sheetData.entries()) {
                if (!cellsToSync.has(key) && sheetValue !== '') {
                    const [rowStr, col] = key.split(':');
                    const range = `Sheet1!${col}${rowStr}`;
                    updates.push({
                        range,
                        values: [['']],
                    });
                    console.log(`   🗑️  DB→Sheet delete: ${col}${rowStr}`);
                }
            }

            if (updates.length === 0) {
                return;
            }

            console.log(`📡 Pushing ${updates.length} update(s) to Google Sheet...`);

            await this.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: SHEET_ID,
                requestBody: {
                    valueInputOption: 'RAW',
                    data: updates,
                },
            });

            // Mark only the SPECIFIC cells we just synced (not a blanket update)
            for (const cell of syncedCells) {
                await pool.query(
                    `UPDATE users SET last_modified_by = 'sheet' 
                     WHERE row_num = ? AND col_name = ? AND last_modified_by != 'sheet'`,
                    [cell.row, cell.col]
                );
            }

            // Update the in-memory snapshot so the next poll doesn't
            // re-detect the values we just pushed as "sheet changes"
            for (const cell of syncedCells) {
                this.lastSnapshot.set(`${cell.row}:${cell.col}`, cell.value);
            }

            console.log(`✅ Synced ${updates.length} cell(s) DB → Google Sheet`);
        } catch (error: any) {
            console.error('❌ DB → Sheet sync failed:', error.message);
            if (error.response) {
                console.error('Google API Error:', error.response.data);
            }
        }
    }
}

export default new CDCMonitor();