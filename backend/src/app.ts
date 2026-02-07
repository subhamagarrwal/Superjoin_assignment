import express , { Express , Response, Request, NextFunction} from 'express'
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import pino from 'pino'
import { testDatabaseConnection, initializeDatabase } from './utils/dbInit';
import redisClient from './config/redis';
import webhookRoutes from './routes/webhook_routes';
import sqlRoutes from './routes/sqlroutes';
import setupRoutes from './routes/setup.routes';
import './workers/sheetUpdateWorker';
import cdcMonitor from './services/cdcMonitor';

dotenv.config();

const app: Express = express();
const logger = pino();

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

app.use(helmet());
app.use(cors());
app.use(express.json({limit: '10mb'}));
app.use(express.urlencoded({limit: '10mb',extended: true}));

//logger middleware
app.use((req:Request, res:Response, next:NextFunction) => {
    const startTime = Date.now();

    res.on('finish', ()=> {
        const duration = Date.now() - startTime;
        logger.info({
            method: req.method,
            url: req.url,
            status: res.statusCode,
            duration: `${duration}ms`
        });
    });
    next();
});

// Health endpoint
app.get('/health', async (req:Request, res:Response) => {
    const dbConnected = await testDatabaseConnection();
    const redisConnected = redisClient.status === 'ready';
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: NODE_ENV,
        uptime: process.uptime(),
        services: {
            database: dbConnected ? 'connected' : 'disconnected',
            redis: redisConnected ? 'connected' : 'disconnected'
        }
    });
});

app.use('/api/webhook', webhookRoutes); 
app.use('/api/sql', sqlRoutes);
app.use('/api/setup', setupRoutes);

// 404 handler
app.use((req:Request, res:Response) => {
    res.status(404).json({error: 'Not Found'});
});

// Error handler
app.use((err:any, req:Request, res:Response, next:NextFunction)=>{
    logger.error({ err }, 'Internal server error');
    res.status(500).json({error: 'Internal Server Error'});
});

app.listen(PORT, async ()=>{
    logger.info(`Server running in ${NODE_ENV} mode on port ${PORT}`);

    //initialize db
    await initializeDatabase();

    //start CDC monitor
    await cdcMonitor.start();
});

export default app;