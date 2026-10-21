// users repositories — placeholder. Data access only. Not to be imported
// by other modules directly — go through services/ instead.
//
// Phase 8 (issue #39): this module owns the shared `User` row and admin
// account lifecycle (invites, deactivation). `auth` still owns credentials
// and sessions — it calls into these services for user creation, never the
// other way round.
import { prisma } from '../../../db/prisma-client';
import { Prisma, type Role } from '@prisma/client';

export function findUserById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

export function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

export function findNotificationContact(userId: string) {
  return prisma.user.findFirst({
    where: { id: userId, deactivatedAt: null },
    select: {
      email: true,
      phone: true,
      emailUndeliverableAt: true,
      smsConsent: { select: { phoneNumber: true, grantedAt: true, optedOutAt: true } },
    },
  });
}

export function markEmailUndeliverable(email: string, at: Date) {
  return prisma.user.updateMany({
    where: { email: { equals: email.trim(), mode: 'insensitive' } },
    data: { emailUndeliverableAt: at },
  });
}

export async function updateSmsConsent(phoneNumber: string, subscribed: boolean, at: Date) {
  const users = await prisma.user.findMany({
    where: { phone: phoneNumber, deactivatedAt: null },
    select: { id: true },
    take: 2,
  });
  if (users.length !== 1) return false;
  const user = users[0]!;
  try {
    await prisma.smsConsent.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        phoneNumber,
        grantedAt: subscribed ? at : null,
        optedOutAt: subscribed ? null : at,
      },
      update: {
        phoneNumber,
        grantedAt: subscribed ? at : undefined,
        optedOutAt: subscribed ? null : at,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return false;
    }
    throw error;
  }
}

/** Active = not deactivated. Used for the "last active admin" guard. */
export function countActiveUsersByRole(role: Role) {
  return prisma.user.count({ where: { role, deactivatedAt: null } });
}

export function setUserDeactivated(userId: string, deactivatedAt: Date) {
  return prisma.user.update({
    where: { id: userId },
    data: { deactivatedAt, sessionsInvalidatedAt: deactivatedAt },
  });
}

export function setUserReactivated(userId: string, at: Date) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      deactivatedAt: null,
      // Also bumped on reactivation: tokens issued before deactivation must
      // not come back to life because the account was re-enabled.
      sessionsInvalidatedAt: at,
    },
  });
}

// --- Admin invites (Phase 8, issue #39) ----------------------------------

/** Creates the invite and retires any outstanding invite for the same
 * address, in one transaction — issuing a new link shouldn't leave two live
 * ones. Retiring means setting `consumedAt`, never deleting. */
export function replaceAdminInvite(input: {
  email: string;
  tokenHash: string;
  expiresAt: Date;
  invitedByUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.adminInvite.updateMany({
      where: { email: input.email, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return tx.adminInvite.create({
      data: {
        email: input.email,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        invitedByUserId: input.invitedByUserId,
      },
    });
  });
}

export function findAdminInviteByTokenHash(tokenHash: string) {
  return prisma.adminInvite.findUnique({ where: { tokenHash } });
}

/** Consumes the invite and creates the admin account atomically: a
 * consumed invite with no account (or an account from an already-consumed
 * invite) must never be observable. Returns null if the invite was already
 * consumed by a concurrent redemption — see services/redeemAdminInvite.
 *
 * TODO(issue #34): when email verification lands, an invited/bootstrapped
 * admin should be created already verified — an invite is an admin-vouched
 * address, and there is no email provider to verify against until issue
 * #17. The `emailVerifiedAt` column doesn't exist on this branch, so it
 * can't be set here yet; wire it up in the PR that merges both. */
export function consumeAdminInviteAndCreateAdmin(input: {
  inviteId: string;
  email: string;
  passwordHash: string;
  consumedAt: Date;
}) {
  return prisma.$transaction(async (tx) => {
    const consumed = await tx.adminInvite.updateMany({
      where: { id: input.inviteId, consumedAt: null },
      data: { consumedAt: input.consumedAt },
    });
    if (consumed.count !== 1) return null;

    return tx.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        role: 'admin',
      },
    });
  });
}
