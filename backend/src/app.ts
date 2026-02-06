import express , { Express , Response, Request, NextFunction} from 'express'
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import pino from 'pino'

dotenv.config();

const app: Express = express();
const logger = pino();

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

app.use(helmet());
app.use(cors());
app.use(express.json({limit: '10mb'}));
app.use(express.urlencoded({limit: '10mb',extended: true}));

//logg middleware
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

app.use('/api/webhook', (req:Request, res:Response) => {
    res.status(200).json({message: 'Webhook received'});
});
app.use('/api/sql/execute', (req:Request, res:Response) => {
    res.status(200).json({message: 'SQL executed'});
});

app.use((req:Request, res:Response) => {
    res.status(404).json({error: 'Not Found'});
});
app.use((err:any, req:Request, res:Response,next:NextFunction)=>{
    logger.error(err);
    res.status(500).json({error: 'Internal Server Error'});
});
app.listen(PORT, ()=>{
    logger.info(`Server running in ${NODE_ENV} mode on port ${PORT}`);
});
export default app;




