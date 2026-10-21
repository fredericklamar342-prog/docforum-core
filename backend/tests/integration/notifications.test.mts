import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import type { NotificationDispatch } from '../../src/modules/notifications/services/index.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5442;
const runId = Date.now();
const resendSecret = `whsec_${Buffer.from('test-resend-webhook-secret').toString('base64')}`;
const twilioAuthToken = 'test-twilio-auth-token';
const twilioInboundUrl = 'https://api.docforum.test/notifications/webhooks/twilio/inbound';
const twilioStatusUrl = 'https://api.docforum.test/notifications/webhooks/twilio/status';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-notifications-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

describe('notification inbox', () => {
  let app: App;
  let prisma: Prisma;
  let notifications: typeof import('../../src/modules/notifications/services/index.js');
  let channelAdapters: typeof import('../../src/modules/notifications/services/channel-adapters.js');
  let users: typeof import('../../src/modules/users/services/index.js');
  let owner: { id: string; token: string };
  let other: { id: string; token: string };

  async function signup(label: string) {
    const response = await request(app).post('/auth/signup').send({
      role: 'patient',
      email: `${label}-${runId}@example.com`,
      password: 'longenough123',
      fullName: `Notification ${label}`,
    });
    expect(response.status).toBe(200);
    return { id: response.body.user.id as string, token: response.body.accessToken as string };
  }

  beforeAll(async () => {
    process.env.RESEND_API_KEY = 'test-resend-api-key';
    process.env.RESEND_WEBHOOK_SECRET = resendSecret;
    process.env.EMAIL_FROM = 'DocForum <notifications@example.com>';
    process.env.TWILIO_ACCOUNT_SID = 'AC' + 'TEST_ACCOUNT_SID';
    process.env.TWILIO_AUTH_TOKEN = twilioAuthToken;
    process.env.TWILIO_FROM_NUMBER = '+14155552672';
    process.env.TWILIO_INBOUND_WEBHOOK_URL = twilioInboundUrl;
    process.env.TWILIO_STATUS_WEBHOOK_URL = twilioStatusUrl;
    process.env.SMS_DAILY_SEND_CAP = '5';
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;
    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    notifications = await import('../../src/modules/notifications/services/index.js');
    channelAdapters = await import('../../src/modules/notifications/services/channel-adapters.js');
    users = await import('../../src/modules/users/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;
    authServices.setEmailSender(async () => {});
    owner = await signup('owner');
    other = await signup('other');
  }, 180_000);

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('requires authentication and prevents reading or marking another user\'s notification', async () => {
    const notification = await notifications.notify(owner.id, 'booking_confirmed', {
      appointmentId: '00000000-0000-4000-8000-000000000001',
    });

    expect((await request(app).get('/notifications')).status).toBe(401);
    const otherList = await request(app).get('/notifications').set('Authorization', `Bearer ${other.token}`);
    expect(otherList.status).toBe(200);
    expect(otherList.body.items).toHaveLength(0);

    const crossUserRead = await request(app)
      .post(`/notifications/${notification.id}/read`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(crossUserRead.status).toBe(404);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } })).readAt).toBeNull();
  });

  it('validates typed payloads and rejects malformed cursors', async () => {
    await expect(notifications.notify(owner.id, 'booking_confirmed', { appointmentId: 'not-a-uuid' })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_NOTIFICATION_PAYLOAD',
    });

    const response = await request(app)
      .get('/notifications?cursor=not-a-valid-cursor')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_CURSOR');
  });

  it('returns unread-only keyset pages without duplicates and supports read-all', async () => {
    await notifications.markAllMyNotificationsRead(owner.id);
    await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        notifications.notify(owner.id, 'booking_confirmed', {
          appointmentId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
        }),
      ),
    );

    const firstPage = await request(app)
      .get('/notifications?unread=true&limit=2')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app)
      .get('/notifications')
      .query({ unread: 'true', limit: 2, cursor: firstPage.body.nextCursor as string })
      .set('Authorization', `Bearer ${owner.token}`);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.items).toHaveLength(1);
    const ids = [...firstPage.body.items, ...secondPage.body.items].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(3);

    const count = await request(app).get('/notifications/unread-count').set('Authorization', `Bearer ${owner.token}`);
    expect(count.body.count).toBe(3);
    const marked = await request(app).post('/notifications/read-all').set('Authorization', `Bearer ${owner.token}`);
    expect(marked.body.updated).toBe(3);
    const after = await request(app).get('/notifications/unread-count').set('Authorization', `Bearer ${owner.token}`);
    expect(after.body.count).toBe(0);
  });

  it('keeps the in-app write when a channel adapter fails', async () => {
    const unregister = notifications.registerChannelAdapter({ channel: 'email', send: async () => { throw new Error('provider failure'); } });
    try {
      const notification = await notifications.notify(owner.id, 'results_available', {
        labOrderId: '00000000-0000-4000-8000-000000000099',
      });
      expect(await prisma.notification.findUnique({ where: { id: notification.id } })).toMatchObject({
        id: notification.id,
        channel: 'in_app',
      });
    } finally {
      unregister();
    }
  });

  it('sends generic email templates and marks bounced addresses undeliverable through a signed webhook', async () => {
    const send = async (message: { to: string; subject: string; text: string; html: string }) => {
      expect(message.to).toBe(`owner-${runId}@example.com`);
      expect(message.subject).toBe('Booking confirmed');
      expect(message.text).not.toContain('appointmentId');
      return 'email-message-1';
    };
    const adapter = channelAdapters.createEmailAdapter(send);
    const payload = { appointmentId: '00000000-0000-4000-8000-000000000201' };
    const notification = await notifications.notify(owner.id, 'booking_confirmed', payload);
    await adapter.send({
      notificationId: notification.id,
      userId: owner.id,
      type: 'booking_confirmed',
      payload,
    });
    expect(await prisma.notificationDelivery.findUnique({
      where: { notificationId_channel: { notificationId: notification.id, channel: 'email' } },
    })).toMatchObject({ provider: 'resend', providerMessageId: 'email-message-1', status: 'sent' });

    const timestamp = String(Math.floor(Date.now() / 1000));
    const id = 'resend-bounce-1';
    const rawBody = JSON.stringify({
      type: 'email.bounced',
      data: { email_id: 'email-message-1', to: [`owner-${runId}@example.com`] },
    });
    const key = Buffer.from(resendSecret.slice('whsec_'.length), 'base64');
    const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
    const response = await request(app)
      .post('/notifications/webhooks/resend')
      .set('Content-Type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', timestamp)
      .set('svix-signature', `v1,${signature}`)
      .send(rawBody);
    expect(response.status).toBe(204);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({
      emailUndeliverableAt: expect.any(Date),
    });
    expect(await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: notification.id, channel: 'email' } },
    })).toMatchObject({ status: 'bounced' });

    const skipped = await notifications.notify(owner.id, 'booking_confirmed', {
      appointmentId: '00000000-0000-4000-8000-000000000202',
    });
    await adapter.send({
      notificationId: skipped.id,
      userId: owner.id,
      type: 'booking_confirmed',
      payload: { appointmentId: '00000000-0000-4000-8000-000000000202' },
    });
    expect(await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: skipped.id, channel: 'email' } },
    })).toMatchObject({ status: 'skipped', errorCode: 'EMAIL_UNDELIVERABLE' });
  });

  it('marks complained addresses undeliverable from a signed Resend event', async () => {
    const adapter = channelAdapters.createEmailAdapter(async () => 'email-message-complaint');
    const payload = { appointmentId: '00000000-0000-4000-8000-000000000203' };
    const notification = await notifications.notify(other.id, 'booking_confirmed', payload);
    await adapter.send({
      notificationId: notification.id,
      userId: other.id,
      type: 'booking_confirmed',
      payload,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const id = 'resend-complaint-1';
    const rawBody = JSON.stringify({
      type: 'email.complained',
      data: { email_id: 'email-message-complaint', to: `other-${runId}@example.com` },
    });
    const key = Buffer.from(resendSecret.slice('whsec_'.length), 'base64');
    const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
    const response = await request(app)
      .post('/notifications/webhooks/resend')
      .set('Content-Type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', timestamp)
      .set('svix-signature', `v1,${signature}`)
      .send(rawBody);

    expect(response.status).toBe(204);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({
      emailUndeliverableAt: expect.any(Date),
    });
    expect(await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: notification.id, channel: 'email' } },
    })).toMatchObject({ status: 'complained' });
  });

  it('requires valid provider signatures for webhook routes', async () => {
    const resend = await request(app)
      .post('/notifications/webhooks/resend')
      .set('Content-Type', 'application/json')
      .set('svix-id', 'bad-signature')
      .set('svix-timestamp', String(Math.floor(Date.now() / 1000)))
      .set('svix-signature', 'v1,invalid')
      .send('{"type":"email.bounced","data":{}}');
    expect(resend.status).toBe(401);

    const twilio = await request(app)
      .post('/notifications/webhooks/twilio/inbound')
      .type('form')
      .set('x-twilio-signature', 'invalid')
      .send({ From: '+14155552671', Body: 'STOP' });
    expect(twilio.status).toBe(401);
  });

  it('sends SMS only with active consent, honors STOP/START, and enforces the concurrent daily cap', async () => {
    const phoneNumber = '+14155552671';
    await prisma.user.update({ where: { id: owner.id }, data: { phone: phoneNumber } });
    const sent: Array<{ to: string; body: string }> = [];
    let messageId = 0;
    const adapter = channelAdapters.createSmsAdapter(async (message) => {
      sent.push(message);
      messageId += 1;
      return `SM${messageId}`;
    });
    const withoutConsentPayload = { appointmentId: '00000000-0000-4000-8000-000000000300' };
    const withoutConsent = await notifications.notify(owner.id, 'booking_confirmed', withoutConsentPayload);
    await adapter.send({
      notificationId: withoutConsent.id,
      userId: owner.id,
      type: 'booking_confirmed',
      payload: withoutConsentPayload,
    });
    expect(sent).toHaveLength(0);
    expect(await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: withoutConsent.id, channel: 'sms' } },
    })).toMatchObject({ status: 'skipped', errorCode: 'SMS_CONSENT_REQUIRED' });

    expect(await users.updateSmsConsent(phoneNumber, true)).toBe(true);
    const dispatches: NotificationDispatch[] = await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        const payload = {
          appointmentId: `00000000-0000-4000-8000-${String(index + 301).padStart(12, '0')}`,
        };
        const notification = await notifications.notify(owner.id, 'booking_confirmed', payload);
        return {
          notificationId: notification.id,
          userId: owner.id,
          type: 'booking_confirmed',
          payload,
        };
      }),
    );

    await Promise.all(dispatches.map((dispatch) => adapter.send(dispatch)));
    expect(sent).toHaveLength(5);
    expect(sent[0]).toMatchObject({
      to: phoneNumber,
      body: 'Your DocForum booking is confirmed. Sign in to view it.',
    });
    const deliveryRows = await prisma.notificationDelivery.findMany({
      where: { notificationId: { in: dispatches.map((dispatch) => dispatch.notificationId) }, channel: 'sms' },
    });
    expect(deliveryRows.filter((row) => row.status === 'sent')).toHaveLength(5);
    expect(deliveryRows.filter((row) => row.errorCode === 'SMS_DAILY_CAP_REACHED')).toHaveLength(1);

    const statusParams = { MessageSid: 'SM1', MessageStatus: 'delivered' };
    const statusCanonical = Object.keys(statusParams)
      .sort()
      .reduce((value, key) => value + key + statusParams[key as keyof typeof statusParams], twilioStatusUrl);
    const statusSignature = createHmac('sha1', twilioAuthToken).update(statusCanonical).digest('base64');
    const statusResponse = await request(app)
      .post('/notifications/webhooks/twilio/status')
      .type('form')
      .set('x-twilio-signature', statusSignature)
      .send(statusParams);
    expect(statusResponse.status).toBe(204);
    expect(await prisma.notificationDelivery.findFirstOrThrow({
      where: { channel: 'sms', providerMessageId: 'SM1' },
    })).toMatchObject({ status: 'delivered' });

    const sendInbound = async (body: string) => {
      const params = { From: phoneNumber, Body: body };
      const canonical = Object.keys(params)
        .sort()
        .reduce((value, key) => value + key + params[key as keyof typeof params], twilioInboundUrl);
      const signature = createHmac('sha1', twilioAuthToken).update(canonical).digest('base64');
      return request(app)
        .post('/notifications/webhooks/twilio/inbound')
        .type('form')
        .set('x-twilio-signature', signature)
        .send(params);
    };

    expect((await sendInbound('STOP')).status).toBe(200);
    expect(await prisma.smsConsent.findUniqueOrThrow({ where: { userId: owner.id } })).toMatchObject({
      optedOutAt: expect.any(Date),
    });
    const optedOutNotification = await notifications.notify(owner.id, 'booking_confirmed', {
      appointmentId: '00000000-0000-4000-8000-000000000399',
    });
    await adapter.send({
      notificationId: optedOutNotification.id,
      userId: owner.id,
      type: 'booking_confirmed',
      payload: { appointmentId: '00000000-0000-4000-8000-000000000399' },
    });
    expect(await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: optedOutNotification.id, channel: 'sms' } },
    })).toMatchObject({ status: 'skipped', errorCode: 'SMS_CONSENT_REQUIRED' });

    expect((await sendInbound('START')).status).toBe(200);
    expect(await prisma.smsConsent.findUniqueOrThrow({ where: { userId: owner.id } })).toMatchObject({
      grantedAt: expect.any(Date),
      optedOutAt: null,
    });
  });
});