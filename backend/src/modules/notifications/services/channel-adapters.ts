import { config } from '../../../config';
import * as usersService from '../../users/services';
import * as notificationsRepo from '../repositories';
import { registerChannelAdapter, type NotificationChannelAdapter, type NotificationDispatch } from './index';
import { emailTemplates } from './email-templates';
import { normalizeE164 } from './phone-numbers';
import { smsTemplates } from './sms-templates';
import { sendResendEmail, sendTwilioSms } from './provider-clients';

type EmailSender = typeof sendResendEmail;
type SmsSender = typeof sendTwilioSms;

function deliveryErrorCode(error: unknown): string {
	if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message)) return error.message;
	return 'DELIVERY_FAILED';
}

async function markSkipped(notification: NotificationDispatch, channel: 'email' | 'sms', provider: string, errorCode: string) {
	await notificationsRepo.upsertNotificationDelivery({
		notificationId: notification.notificationId,
		channel,
		provider,
		status: 'skipped',
		errorCode,
	});
}

export function createEmailAdapter(send: EmailSender = sendResendEmail): NotificationChannelAdapter {
	return {
		channel: 'email',
		async send(notification) {
			const contact = await usersService.getNotificationContact(notification.userId);
			if (!contact || contact.emailUndeliverableAt) {
				await markSkipped(notification, 'email', 'resend', 'EMAIL_UNDELIVERABLE');
				return;
			}

			const configured = Boolean(config.notifications.email.resendApiKey && config.notifications.email.from);
			if (!configured && process.env.NODE_ENV === 'production') {
				await notificationsRepo.upsertNotificationDelivery({
					notificationId: notification.notificationId,
					channel: 'email',
					provider: 'resend',
					status: 'failed',
					errorCode: 'EMAIL_PROVIDER_NOT_CONFIGURED',
				});
				throw new Error('EMAIL_PROVIDER_NOT_CONFIGURED');
			}

			const provider = configured ? 'resend' : 'console';
			await notificationsRepo.upsertNotificationDelivery({
				notificationId: notification.notificationId,
				channel: 'email',
				provider,
				status: 'queued',
			});

			try {
				if (configured) {
					const template = emailTemplates[notification.type];
					const providerMessageId = await send({
						to: contact.email,
						subject: template.subject,
						text: template.text,
						html: template.html,
					});
					await notificationsRepo.upsertNotificationDelivery({
						notificationId: notification.notificationId,
						channel: 'email',
						provider,
						providerMessageId,
						status: 'sent',
					});
				} else {
					console.info(`[notifications] local email adapter accepted notification ${notification.notificationId}`);
					await notificationsRepo.upsertNotificationDelivery({
						notificationId: notification.notificationId,
						channel: 'email',
						provider,
						status: 'sent',
					});
				}
			} catch (error) {
				await notificationsRepo.upsertNotificationDelivery({
					notificationId: notification.notificationId,
					channel: 'email',
					provider,
					status: 'failed',
					errorCode: deliveryErrorCode(error),
				});
				throw error;
			}
		},
	};
}

export function createSmsAdapter(send: SmsSender = sendTwilioSms): NotificationChannelAdapter {
	return {
		channel: 'sms',
		async send(notification) {
			const contact = await usersService.getNotificationContact(notification.userId);
			const phoneNumber = contact?.phone ? normalizeE164(contact.phone) : null;
			const consent = contact?.smsConsent;
			if (
				!contact ||
				!phoneNumber ||
				!consent ||
				consent.phoneNumber !== phoneNumber ||
				!consent.grantedAt ||
				consent.optedOutAt
			) {
				await markSkipped(notification, 'sms', 'twilio', 'SMS_CONSENT_REQUIRED');
				return;
			}

			const configured = Boolean(
				config.notifications.sms.twilioAccountSid &&
					config.notifications.sms.twilioAuthToken &&
					(config.notifications.sms.twilioFromNumber || config.notifications.sms.twilioMessagingServiceSid),
			);
			if (!configured && process.env.NODE_ENV === 'production') {
				await notificationsRepo.upsertNotificationDelivery({
					notificationId: notification.notificationId,
					channel: 'sms',
					provider: 'twilio',
					status: 'failed',
					errorCode: 'SMS_PROVIDER_NOT_CONFIGURED',
				});
				throw new Error('SMS_PROVIDER_NOT_CONFIGURED');
			}

			const provider = configured ? 'twilio' : 'console';
			const dailyCap = config.notifications.sms.dailySendCap;
			if (!Number.isInteger(dailyCap) || dailyCap < 1) {
				await notificationsRepo.upsertNotificationDelivery({
					notificationId: notification.notificationId,
					channel: 'sms',
					provider,
					status: 'failed',
					errorCode: 'SMS_DAILY_CAP_INVALID',
				});
				throw new Error('SMS_DAILY_CAP_INVALID');
			}
			const now = new Date();
			const utcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
			if (!(await notificationsRepo.reserveSmsSend(notification.userId, utcDay, dailyCap))) {
				await markSkipped(notification, 'sms', provider, 'SMS_DAILY_CAP_REACHED');
				return;
			}

			await notificationsRepo.upsertNotificationDelivery({
				notificationId: notification.notificationId,
				channel: 'sms',
				provider,
				status: 'queued',
			});

			try {
				if (configured) {
					const providerMessageId = await send({
						to: phoneNumber,
						body: smsTemplates[notification.type],
					});
					await notificationsRepo.upsertNotificationDelivery({
						notificationId: notification.notificationId,
						channel: 'sms',
						provider,
						providerMessageId,
						status: 'sent',
					});
				} else {
					console.info(`[notifications] local SMS adapter accepted notification ${notification.notificationId}`);
					await notificationsRepo.upsertNotificationDelivery({
						notificationId: notification.notificationId,
						channel: 'sms',
						provider,
						status: 'sent',
					});
				}
			} catch (error) {
				await notificationsRepo.upsertNotificationDelivery({
					notificationId: notification.notificationId,
					channel: 'sms',
					provider,
					status: 'failed',
					errorCode: deliveryErrorCode(error),
				});
				throw error;
			}
		},
	};
}

export function registerExternalChannelAdapters(): () => void {
	const unregisterEmail = registerChannelAdapter(createEmailAdapter());
	const unregisterSms = registerChannelAdapter(createSmsAdapter());
	return () => {
		unregisterEmail();
		unregisterSms();
	};
}
