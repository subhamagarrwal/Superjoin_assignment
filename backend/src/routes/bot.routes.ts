import { Router } from 'express';
import { runBotSimulation } from '../controllers/botController';

const router = Router();

router.post('/run', runBotSimulation);

export default router;
