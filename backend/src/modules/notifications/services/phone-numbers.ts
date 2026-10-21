import { parsePhoneNumber } from 'libphonenumber-js';

export function normalizeE164(value: string): string | null {
	try {
		const parsed = parsePhoneNumber(value);
		return parsed.isValid() ? parsed.number : null;
	} catch {
		return null;
	}
}