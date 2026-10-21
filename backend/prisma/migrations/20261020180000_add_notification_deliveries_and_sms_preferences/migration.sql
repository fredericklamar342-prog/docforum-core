-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('queued', 'sent', 'delivered', 'failed', 'bounced', 'complained', 'skipped');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailUndeliverableAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'queued',
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsConsent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3),
    "optedOutAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsDailyQuota" (
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "sendCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SmsDailyQuota_pkey" PRIMARY KEY ("userId", "day")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_channel_providerMessageId_key" ON "NotificationDelivery"("channel", "providerMessageId");
CREATE UNIQUE INDEX "NotificationDelivery_notificationId_channel_key" ON "NotificationDelivery"("notificationId", "channel");
CREATE INDEX "NotificationDelivery_status_createdAt_idx" ON "NotificationDelivery"("status", "createdAt");
CREATE UNIQUE INDEX "SmsConsent_userId_key" ON "SmsConsent"("userId");
CREATE UNIQUE INDEX "SmsConsent_phoneNumber_key" ON "SmsConsent"("phoneNumber");
CREATE INDEX "User_phone_idx" ON "User"("phone");

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmsConsent" ADD CONSTRAINT "SmsConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmsDailyQuota" ADD CONSTRAINT "SmsDailyQuota_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
