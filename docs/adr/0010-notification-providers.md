# ADR 0010: Resend for email and Twilio for SMS notifications

Status: Accepted
Date: 2026-10-20

## Context

Phase 6 issues #17 and #93–#96 need concrete delivery providers without
coupling notification business logic to one vendor. Notification content may
refer to health-care events, so provider messages must not disclose clinical
details. SMS also requires reliable opt-out handling and cost controls.

## Decision

- Use **Resend** for outbound email and signed bounce/complaint webhooks.
- Use **Twilio** for outbound SMS, signed delivery callbacks, and inbound
  STOP/START consent keywords.
- Keep provider calls behind the notification module's channel-adapter
  interface. The `Notification` model and typed payload catalogue remain
  provider-agnostic.
- Email and SMS templates are static, generic prompts to sign in. They do not
  interpolate notification payloads or contain clinical details.
- Persist delivery state and stable error codes. Persist SMS consent by user
  and E.164 phone number, and enforce a five-message-per-user-per-UTC-day cap
  atomically in PostgreSQL.
- Require signed callbacks and canonical configured public URLs. Provider
  credentials and sender identities are optional at process startup; local
  development uses a console adapter, while production delivery fails
  explicitly if provider configuration is missing. In-app notifications
  remain persisted even if an adapter fails.

## Consequences

- Deployments must configure Resend/Twilio credentials, sender identities,
  webhook secrets, and canonical callback URLs before enabling external
  delivery.
- A notification's in-app row is independent of email/SMS delivery; delivery
  failures are observable without rolling back the domain event.
- SMS attempts consume the daily quota even when the provider subsequently
  fails, so repeated failures cannot create unbounded provider cost.
- Email verification still uses its existing auth-module no-op dispatcher;
  integrating that separate flow remains follow-up work for issue #34.

## Alternatives considered

- **Leave providers undecided.** Rejected because this blocks Phase 6 channel
  work despite the provider-agnostic interface already being in place.
- **Use one vendor for email and SMS.** Rejected in favor of selecting the
  provider-specific services with explicit webhook and opt-out capabilities
  for each channel.
- **Build delivery infrastructure in-house.** Rejected; it adds operational
  burden without product value and conflicts with the architecture rule to put
  third-party messaging behind an interface.
