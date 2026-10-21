import { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function createNotification(
	userId: string,
	type: string,
	payload: Prisma.InputJsonValue,
	db: DbClient = prisma,
) {
	return db.notification.create({ data: { userId, type, payload, channel: 'in_app' } });
}

export function listNotifications(
	userId: string,
	options: { unreadOnly: boolean; limit: number; cursor?: { createdAt: Date; id: string } },
) {
	return prisma.notification.findMany({
		where: {
			userId,
			...(options.unreadOnly ? { readAt: null } : {}),
			...(options.cursor
				? {
						OR: [
							{ createdAt: { lt: options.cursor.createdAt } },
							{ createdAt: options.cursor.createdAt, id: { lt: options.cursor.id } },
						],
					}
				: {}),
		},
		orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
		take: options.limit + 1,
	});
}

export function countUnread(userId: string) {
	return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markNotificationRead(userId: string, id: string) {
	const updated = await prisma.notification.updateMany({
		where: { id, userId, readAt: null },
		data: { readAt: new Date() },
	});
	if (updated.count > 0) return prisma.notification.findUniqueOrThrow({ where: { id } });
	return prisma.notification.findFirst({ where: { id, userId } });
}

export function markAllNotificationsRead(userId: string) {
	return prisma.notification.updateMany({
		where: { userId, readAt: null },
		data: { readAt: new Date() },
	});
}

export function upsertNotificationDelivery(input: {
	notificationId: string;
	channel: 'email' | 'sms';
	provider: string;
	providerMessageId?: string | null;
	status: 'queued' | 'sent' | 'delivered' | 'failed' | 'bounced' | 'complained' | 'skipped';
	errorCode?: string | null;
}) {
	return prisma.notificationDelivery.upsert({
		where: { notificationId_channel: { notificationId: input.notificationId, channel: input.channel } },
		create: input,
		update: {
			provider: input.provider,
			providerMessageId: input.providerMessageId,
			status: input.status,
			errorCode: input.errorCode,
		},
	});
}

export function updateDeliveryStatus(
	channel: 'email' | 'sms',
	providerMessageId: string,
	status: 'sent' | 'delivered' | 'failed' | 'bounced' | 'complained',
): Promise<boolean> {
	return prisma.notificationDelivery.updateMany({
		where: { channel, providerMessageId, status: { in: ['queued', 'sent'] } },
		data: { status },
	}).then(async ({ count }) => {
		if (count > 0) return true;
		return Boolean(await prisma.notificationDelivery.findFirst({
			where: { channel, providerMessageId },
			select: { id: true },
		}));
	});
}

export async function reserveSmsSend(userId: string, day: Date, dailyCap: number): Promise<boolean> {
	const reserved = await prisma.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
		INSERT INTO "SmsDailyQuota" ("userId", "day", "sendCount")
		VALUES (${userId}, ${day}::date, 1)
		ON CONFLICT ("userId", "day") DO UPDATE
		SET "sendCount" = "SmsDailyQuota"."sendCount" + 1
		WHERE "SmsDailyQuota"."sendCount" < ${dailyCap}
		RETURNING "userId"
	`);
	return reserved.length === 1;
}
