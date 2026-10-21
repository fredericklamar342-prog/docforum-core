import express, { Router } from 'express';
import { authenticate } from '../../../middleware/auth';
import * as notificationsController from '../controllers';

export const notificationsRouter = Router();
export const notificationWebhooksRouter = Router();

notificationsRouter.use(authenticate);
notificationsRouter.get('/', notificationsController.list);
notificationsRouter.get('/unread-count', notificationsController.unreadCount);
notificationsRouter.post('/read-all', notificationsController.markAllRead);
notificationsRouter.post('/:id/read', notificationsController.markRead);

notificationWebhooksRouter.post('/resend', express.raw({ type: 'application/json', limit: '64kb' }), notificationsController.resendWebhook);
notificationWebhooksRouter.post(
	'/twilio/status',
	express.urlencoded({ extended: false, limit: '32kb' }),
	notificationsController.twilioStatusWebhook,
);
notificationWebhooksRouter.post(
	'/twilio/inbound',
	express.urlencoded({ extended: false, limit: '32kb' }),
	notificationsController.twilioInboundWebhook,
);
