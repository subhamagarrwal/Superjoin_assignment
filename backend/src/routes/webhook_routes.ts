import { Router } from 'express';
import { handleWebhook } from '../controllers/webhookControllers';

const router = Router();

router.post('/', handleWebhook);

export default router;