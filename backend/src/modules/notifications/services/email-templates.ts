import type { NotificationType } from './index';

export const PHI_FIELD_NAMES = [
	'intake',
	'symptoms',
	'consultationNotes',
	'diagnosis',
	'prescriptionDetails',
	'labResults',
	'patientName',
] as const;

export interface EmailTemplate {
	version: 1;
	subject: string;
	text: string;
	html: string;
}

const generic = (subject: string, sentence: string): EmailTemplate => ({
	version: 1,
	subject,
	text: `${sentence} Sign in to DocForum to review it.`,
	html: `<p>${sentence}</p><p>Sign in to DocForum to review it.</p>`,
});

export const emailTemplates: Record<NotificationType, EmailTemplate> = {
	booking_confirmed: generic('Booking confirmed', 'Your booking is confirmed.'),
	new_booking: generic('New booking', 'You have a new booking.'),
	referral_created: generic('Referral update', 'A referral is ready for you.'),
	referral_updated: generic('Referral update', 'Your referral has an update.'),
	order_ready: generic('Order update', 'An order is ready for you.'),
	results_available: generic('Results available', 'There is an update to review.'),
};

export function renderEmailTemplate(type: NotificationType): EmailTemplate {
	return emailTemplates[type];
}