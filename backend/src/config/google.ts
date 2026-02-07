import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();
const logger = pino();

// Create JWT client for service account authentication
const jwtClient = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});


// Authenticate
jwtClient.authorize((err) => {
    if (err) {
        logger.error({ err }, 'Google Sheets authentication failed');
    } else {
        logger.info('Google Sheets authenticated successfully');
    }
});

// Create sheets API client
export const sheets = google.sheets({ version: 'v4', auth: jwtClient });
export {sheets, jwtClient};
export default sheets;
