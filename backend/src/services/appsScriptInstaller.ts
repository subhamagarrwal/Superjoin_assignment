import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();
const logger = pino();

const jwtClient = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/script.projects',
    ],
});

function generateAppsScript(backendUrl: string, sheetId: string): string {
    return `
var BACKEND_URL = '${backendUrl}/api/webhook';
var SHEET_ID = '${sheetId}';

function onEdit(e) {
    var range = e.range;
    var row = range.getRow();
    var col = String.fromCharCode(64 + range.getColumn());
    var value = range.getValue().toString();

    var payload = {
        row: row,
        col: col,
        value: value,
        sheetId: SHEET_ID
    };

    var options = {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
    };

    try {
        UrlFetchApp.fetch(BACKEND_URL, options);
    } catch (error) {
        Logger.log('Webhook failed: ' + error);
    }
}

function installTrigger() {
    var triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(function(trigger) {
        ScriptApp.deleteTrigger(trigger);
    });

    ScriptApp.newTrigger('onEdit')
        .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
        .onEdit()
        .create();

    Logger.log('Trigger installed successfully');
}
`;
}

export async function installAppsScript(sheetId: string): Promise<boolean> {
    try {
        const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
        const scriptCode = generateAppsScript(backendUrl, sheetId);

        const script = google.script({ version: 'v1', auth: jwtClient });

        // Step 1: Create a new Apps Script project bound to the sheet
        const createRes = await script.projects.create({
            requestBody: {
                title: 'Superjoin Sync Script',
                parentId: sheetId,
            },
        });

        const scriptId = createRes.data.scriptId;

        if (!scriptId) {
            throw new Error('Failed to create Apps Script project');
        }

        logger.info({ scriptId }, 'Apps Script project created');

        // Step 2: Upload the script code
        await script.projects.updateContent({
            scriptId: scriptId,
            requestBody: {
                files: [
                    {
                        name: 'Code',
                        type: 'SERVER_JS',
                        source: scriptCode,
                    },
                    {
                        name: 'appsscript',
                        type: 'JSON',
                        source: JSON.stringify({
                            timeZone: 'Asia/Kolkata',
                            dependencies: {},
                            exceptionLogging: 'STACKDRIVER',
                            runtimeVersion: 'V8',
                        }),
                    },
                ],
            },
        });

        logger.info({ scriptId, sheetId }, 'Apps Script code uploaded');

        // Step 3: Deploy the script
        await script.projects.deployments.create({
            scriptId: scriptId,
            requestBody: {
                versionNumber: 1,
                description: 'Superjoin webhook trigger',
            },
        });

        logger.info({ scriptId, sheetId }, 'Apps Script deployed');

        return true;
    } catch (error: any) {
        logger.error({ error: error.message, sheetId }, 'Failed to install Apps Script');
        return false;
    }
}