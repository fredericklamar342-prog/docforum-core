import { z } from 'zod';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import * as usersService from '../../users/services';
import * as notificationsRepo from '../repositories';
import { normalizeE164 } from './phone-numbers';
import { verifyResendSignature, verifyTwilioSignature } from './provider-signatures';

const resendEventSchema = z.object({ type: z.string(), data: z.unknown() }).passthrough();
const resendDeliverySchema = z.object({
	email_id: z.string().min(1),
	to: z.union([z.string().email(), z.array(z.string().email()).min(1)]),
});
const twilioParamsSchema = z.record(z.string(), z.string());
const twilioStatusSchema = z.object({
	MessageSid: z.string().min(1),
	MessageStatus: z.enum(['accepted', 'scheduled', 'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed']),
});
const twilioInboundSchema = z.object({ From: z.string(), Body: z.string() });

export async function processResendWebhook(input: {
	rawBody: string;
	id: string;
	timestamp: string;
	signature: string;
}) {
	const secret = config.notifications.email.resendWebhookSecret;
	if (!secret) throw new HttpError(503, 'Email webhook is not configured.', 'EMAIL_WEBHOOK_NOT_CONFIGURED');
	if (
		!verifyResendSignature({
			secret,
			rawBody: input.rawBody,
			id: input.id,
			timestamp: input.timestamp,
			signature: input.signature,
		})
	) {
		throw new HttpError(401, 'Invalid webhook signature.', 'INVALID_WEBHOOK_SIGNATURE');
	}

	let payload: unknown;
	try {
		payload = JSON.parse(input.rawBody);
	} catch {
		throw new HttpError(400, 'Invalid webhook payload.', 'INVALID_WEBHOOK_PAYLOAD');
	}

	const event = resendEventSchema.safeParse(payload);
	if (!event.success) throw new HttpError(400, 'Invalid webhook payload.', 'INVALID_WEBHOOK_PAYLOAD');
	if (event.data.type !== 'email.bounced' && event.data.type !== 'email.complained') return;

	const delivery = resendDeliverySchema.safeParse(event.data.data);
	if (!delivery.success) throw new HttpError(400, 'Invalid delivery event.', 'INVALID_WEBHOOK_PAYLOAD');

	const status = event.data.type === 'email.bounced' ? 'bounced' : 'complained';
	const tracked = await notificationsRepo.updateDeliveryStatus('email', delivery.data.email_id, status);
	const recipients = typeof delivery.data.to === 'string' ? [delivery.data.to] : delivery.data.to;
	await Promise.all(recipients.map((email) => usersService.markEmailUndeliverable(email)));
	if (!tracked) throw new HttpError(503, 'Delivery record is not available yet.', 'DELIVERY_RECORD_NOT_FOUND');
}

function validateTwilioRequest(params: unknown, signature: string | undefined, url: string | undefined) {
	const authToken = config.notifications.sms.twilioAuthToken;
	if (!authToken || !url) throw new HttpError(503, 'SMS webhook is not configured.', 'SMS_WEBHOOK_NOT_CONFIGURED');
	const parsed = twilioParamsSchema.safeParse(params);
	if (!parsed.success) throw new HttpError(400, 'Invalid webhook payload.', 'INVALID_WEBHOOK_PAYLOAD');
	if (
		!verifyTwilioSignature({
			url,
			params: parsed.data,
			authToken,
			signature: signature ?? '',
		})
	) {
		throw new HttpError(401, 'Invalid webhook signature.', 'INVALID_WEBHOOK_SIGNATURE');
	}
	return parsed.data;
}

export async function processTwilioStatusWebhook(params: unknown, signature: string | undefined) {
	const parsed = validateTwilioRequest(params, signature, config.notifications.sms.twilioStatusWebhookUrl);
	const statusInput = twilioStatusSchema.safeParse(parsed);
	if (!statusInput.success) throw new HttpError(400, 'Invalid delivery event.', 'INVALID_WEBHOOK_PAYLOAD');
	const status =
		statusInput.data.MessageStatus === 'delivered'
			? 'delivered'
			: statusInput.data.MessageStatus === 'failed' || statusInput.data.MessageStatus === 'undelivered'
				? 'failed'
				: 'sent';
	const tracked = await notificationsRepo.updateDeliveryStatus('sms', statusInput.data.MessageSid, status);
	if (!tracked) throw new HttpError(503, 'Delivery record is not available yet.', 'DELIVERY_RECORD_NOT_FOUND');
}

export async function processTwilioInboundWebhook(params: unknown, signature: string | undefined) {
	const parsed = validateTwilioRequest(params, signature, config.notifications.sms.twilioInboundWebhookUrl);
	const inbound = twilioInboundSchema.safeParse(parsed);
	if (!inbound.success) throw new HttpError(400, 'Invalid inbound message.', 'INVALID_WEBHOOK_PAYLOAD');
	const phoneNumber = normalizeE164(inbound.data.From);
	if (!phoneNumber) return 'ignored';

	const keyword = inbound.data.Body.trim().toUpperCase();
	if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(keyword)) {
		await usersService.updateSmsConsent(phoneNumber, false);
		return 'stopped';
	}
	if (['START', 'YES', 'UNSTOP'].includes(keyword)) {
		await usersService.updateSmsConsent(phoneNumber, true);
		return 'started';
	}
	return 'ignored';
}
