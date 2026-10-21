// Provider-agnostic outbound email seam (ARCHITECTURE.md §2: email/SMS is
// "third-party, behind an interface — never build custom").
//
// Notification providers are selected in Phase 6, issue #17, but this
// auth-specific sender has not been wired to them. Until then the default
// sender drops the message and logs only the *subject* and recipient:
// never the body, because for verification mail the body contains the
// one-time token (same rule the admin bootstrap CLI follows for
// passwords — see issue #39). Tests inject their own sender to capture
// the link.
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export type EmailSender = (message: EmailMessage) => Promise<void>;

async function defaultEmailSender(message: EmailMessage): Promise<void> {
  // eslint-disable-next-line no-console
  console.info(`[email] auth sender is not wired (Phase 6 / issue #34) — "${message.subject}" to ${message.to} was not sent.`);
}

let currentSender: EmailSender = defaultEmailSender;

/** Swap the sender in tests; the auth-specific provider wiring remains pending. */
export function setEmailSender(sender: EmailSender): void {
  currentSender = sender;
}

export function resetEmailSender(): void {
  currentSender = defaultEmailSender;
}

export function sendEmail(message: EmailMessage): Promise<void> {
  return currentSender(message);
}
