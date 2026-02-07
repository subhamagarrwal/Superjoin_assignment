import { google } from 'googleapis';
import pool from '../config/database';
import redisClient from '../config/redis';
import pino from 'pino';
import path from 'path';

const logger = pino();

const SHEET_ID = process.env.GOOGLE_SHEET_ID!;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '3000');
const SHEET_RANGE = process.env.SHEET_RANGE || 'Sheet1!A1:H20';

export class CDCMonitor {
    private lastSnapshot: Map<string, string> = new Map();
    private sheets: any;
    private isRunning = false;
    private intervalId: NodeJS.Timeout | null = null;

    async initialize() {
        try {
            const credentialsPath = path.join(
                __dirname, '..', '..', 'credentials', 'service-account.json'
            );

            const auth = new google.auth.GoogleAuth({
                keyFile: credentialsPath,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });

            this.sheets = google.sheets({ version: 'v4', auth });
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

    private async fetchSheetData(): Promise<Map<string, string> | null> {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: SHEET_ID,
                range: SHEET_RANGE,
            });

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
        } catch (error) {
            console.error('❌ Failed to fetch sheet data:', error);
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
    }

    async syncFromDatabase() {
        try {
            console.log('🔍 Checking for DB changes to sync to Google Sheet...');
            
            // Get all current cells in DB
            const [dbRows]: any = await pool.query(
                `SELECT row_num, col_name, cell_value, last_modified_by FROM users 
                 ORDER BY row_num, col_name`
            );

            // Get current sheet data
            const sheetData = await this.fetchSheetData();
            if (!sheetData) return;

            const updates: { range: string; values: string[][] }[] = [];
            const cellsToSync: Set<string> = new Set();

            // 1. Sync updates/inserts from DB
            for (const row of dbRows) {
                const key = `${row.row_num}:${row.col_name}`;
                cellsToSync.add(key);
                
                const sheetValue = sheetData.get(key) || '';
                const dbValue = row.cell_value || '';

                // Only sync if DB value differs from sheet AND was modified by SQL
                if (dbValue !== sheetValue && row.last_modified_by !== 'sheet') {
                    const range = `Sheet1!${row.col_name}${row.row_num}`;
                    updates.push({
                        range,
                        values: [[dbValue]],
                    });
                    console.log(`   📤 Update: ${row.col_name}${row.row_num} = "${dbValue}"`);
                }
            }

            // 2. Sync deletes (cells in sheet but not in DB)
            for (const [key, sheetValue] of sheetData.entries()) {
                if (!cellsToSync.has(key) && sheetValue !== '') {
                    const [rowStr, col] = key.split(':');
                    const range = `Sheet1!${col}${rowStr}`;
                    updates.push({
                        range,
                        values: [['']],  // Clear the cell
                    });
                    console.log(`   🗑️  Delete: ${col}${rowStr}`);
                }
            }

            if (updates.length === 0) {
                console.log('ℹ️  No changes to sync');
                return;
            }

            console.log(`📡 Sending ${updates.length} updates to Google Sheet...`);

            await this.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: SHEET_ID,
                requestBody: {
                    valueInputOption: 'RAW',
                    data: updates,
                },
            });

            // Mark synced rows
            await pool.query(
                `UPDATE users SET last_modified_by = 'sheet' 
                 WHERE last_modified_by != 'sheet'`
            );

            console.log(`✅ Synced ${updates.length} cell(s) from DB → Google Sheet`);
        } catch (error: any) {
            console.error('❌ DB → Sheet sync failed:', error.message);
            if (error.response) {
                console.error('Google API Error:', error.response.data);
            }
        }
    }
}

export default new CDCMonitor();