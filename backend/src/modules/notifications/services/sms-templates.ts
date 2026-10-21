import type { NotificationType } from './index';

export const smsTemplates: Record<NotificationType, string> = {
	booking_confirmed: 'Your DocForum booking is confirmed. Sign in to view it.',
	new_booking: 'You have a new DocForum booking. Sign in to review it.',
	referral_created: 'A DocForum referral is ready. Sign in to review it.',
	referral_updated: 'Your DocForum referral has an update. Sign in to review it.',
	order_ready: 'A DocForum order is ready. Sign in to review it.',
	results_available: 'A DocForum update is ready. Sign in to review it.',
};

export function renderSmsTemplate(type: NotificationType): string {
	return smsTemplates[type];
}