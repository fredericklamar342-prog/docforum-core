import { config } from '../../../config';

export interface ResendEmailInput {
	to: string;
	subject: string;
	text: string;
	html: string;
}

export async function sendResendEmail(message: ResendEmailInput, fetcher: typeof fetch = fetch): Promise<string> {
	const { resendApiKey, from } = config.notifications.email;
	if (!resendApiKey || !from) throw new Error('EMAIL_PROVIDER_NOT_CONFIGURED');
	const response = await fetcher('https://api.resend.com/emails', {
		method: 'POST',
		headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ from, ...message }),
	});
	if (!response.ok) throw new Error('EMAIL_PROVIDER_SEND_FAILED');
	const result = (await response.json()) as { id?: unknown };
	if (typeof result.id !== 'string' || !result.id) throw new Error('EMAIL_PROVIDER_INVALID_RESPONSE');
	return result.id;
}

export interface TwilioSmsInput {
	to: string;
	body: string;
}

export async function sendTwilioSms(message: TwilioSmsInput, fetcher: typeof fetch = fetch): Promise<string> {
	const { twilioAccountSid, twilioAuthToken, twilioFromNumber, twilioMessagingServiceSid, twilioStatusWebhookUrl } =
		config.notifications.sms;
	if (!twilioAccountSid || !twilioAuthToken || (!twilioFromNumber && !twilioMessagingServiceSid)) {
		throw new Error('SMS_PROVIDER_NOT_CONFIGURED');
	}

	const body = new URLSearchParams({ To: message.to, Body: message.body });
	if (twilioMessagingServiceSid) body.set('MessagingServiceSid', twilioMessagingServiceSid);
	else if (twilioFromNumber) body.set('From', twilioFromNumber);
	else throw new Error('SMS_PROVIDER_NOT_CONFIGURED');
	if (twilioStatusWebhookUrl) body.set('StatusCallback', twilioStatusWebhookUrl);
	const authorization = Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64');
	const response = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`, {
		method: 'POST',
		headers: { Authorization: `Basic ${authorization}`, 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	});
	if (!response.ok) throw new Error('SMS_PROVIDER_SEND_FAILED');
	const result = (await response.json()) as { sid?: unknown };
	if (typeof result.sid !== 'string' || !result.sid) throw new Error('SMS_PROVIDER_INVALID_RESPONSE');
	return result.sid;
}