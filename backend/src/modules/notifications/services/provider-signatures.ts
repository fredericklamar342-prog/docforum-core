import { createHmac, timingSafeEqual } from 'node:crypto';

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyResendSignature(input: {
	secret: string;
	rawBody: string;
	id: string;
	timestamp: string;
	signature: string;
	nowSeconds?: number;
}): boolean {
	const timestamp = Number(input.timestamp);
	const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
	if (!input.id || !Number.isInteger(timestamp) || Math.abs(now - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;

	const secret = input.secret.startsWith('whsec_') ? input.secret.slice('whsec_'.length) : input.secret;
	let key: Buffer;
	try {
		key = Buffer.from(secret, 'base64');
	} catch {
		return false;
	}
	if (key.length === 0) return false;

	const expected = createHmac('sha256', key).update(`${input.id}.${input.timestamp}.${input.rawBody}`).digest('base64');
	return input.signature.split(' ').some((entry) => {
		const [version, value] = entry.split(',', 2);
		return version === 'v1' && value !== undefined && safeEqual(value, expected);
	});
}

export function verifyTwilioSignature(input: {
	url: string;
	params: Record<string, string>;
	authToken: string;
	signature: string;
}): boolean {
	if (!input.authToken || !input.signature) return false;
	const body = Object.keys(input.params)
		.sort()
		.reduce((value, key) => value + key + input.params[key], input.url);
	const expected = createHmac('sha1', input.authToken).update(body).digest('base64');
	return safeEqual(input.signature, expected);
}