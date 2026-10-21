import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { emailTemplates, PHI_FIELD_NAMES } from '../../src/modules/notifications/services/email-templates';
import { normalizeE164 } from '../../src/modules/notifications/services/phone-numbers';
import { smsTemplates } from '../../src/modules/notifications/services/sms-templates';
import { verifyResendSignature, verifyTwilioSignature } from '../../src/modules/notifications/services/provider-signatures';

describe('notification provider safeguards', () => {
	it('keeps email templates static and free of PHI field references', () => {
		for (const template of Object.values(emailTemplates)) {
			for (const content of [template.subject, template.text, template.html]) {
				for (const field of PHI_FIELD_NAMES) {
					expect(content.toLowerCase()).not.toContain(field.toLowerCase());
				}
				expect(content).not.toMatch(/\{\{[^}]+\}\}/);
			}
		}
	});

	it('keeps every SMS template within 160 ASCII characters and free of PHI fields', () => {
		for (const template of Object.values(smsTemplates)) {
			expect(template.length).toBeLessThanOrEqual(160);
			expect(template).toMatch(/^[\x00-\x7F]+$/);
			for (const field of PHI_FIELD_NAMES) {
				expect(template.toLowerCase()).not.toContain(field.toLowerCase());
			}
		}
	});

	it('normalizes valid international numbers and rejects invalid values', () => {
		expect(normalizeE164('+14155552671')).toBe('+14155552671');
		expect(normalizeE164('not a phone')).toBeNull();
	});

	it('verifies fresh Resend signatures and rejects tampered or stale events', () => {
		const secret = `whsec_${Buffer.from('notification-webhook-secret').toString('base64')}`;
		const rawBody = '{"type":"email.bounced","data":{}}';
		const id = 'event-1';
		const timestamp = '1792518000';
		const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
		const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');

		expect(verifyResendSignature({ secret, rawBody, id, timestamp, signature: `v1,${signature}`, nowSeconds: 1792518000 })).toBe(true);
		expect(
			verifyResendSignature({
				secret,
				rawBody: `${rawBody} `,
				id,
				timestamp,
				signature: `v1,${signature}`,
				nowSeconds: 1792518000,
			}),
		).toBe(false);
		expect(verifyResendSignature({ secret, rawBody, id, timestamp, signature: `v1,${signature}`, nowSeconds: 1792519000 })).toBe(false);
	});

	it('verifies Twilio signatures against the configured URL and sorted parameters', () => {
		const url = 'https://api.example.com/notifications/webhooks/twilio/status';
		const params = { MessageStatus: 'delivered', MessageSid: 'SM123' };
		const token = 'twilio-test-token';
		const canonical = Object.keys(params)
			.sort()
			.reduce((value, key) => value + key + params[key as keyof typeof params], url);
		const signature = createHmac('sha1', token).update(canonical).digest('base64');

		expect(verifyTwilioSignature({ url, params, authToken: token, signature })).toBe(true);
		expect(verifyTwilioSignature({ url: `${url}/`, params, authToken: token, signature })).toBe(false);
	});
});
