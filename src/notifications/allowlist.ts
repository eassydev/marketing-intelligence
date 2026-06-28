import { env } from '../config/env.js';

const allow = new Set(env.WHATSAPP_RECIPIENT_ALLOWLIST);

export function isAllowed(to: string): boolean {
  return allow.has(to);
}

/**
 * Hard guardrail while alerting is young: only allowlisted ops numbers (E.164)
 * can be messaged, so a bug can never blast customers.
 */
export function assertAllowed(to: string): void {
  if (!isAllowed(to)) {
    throw new Error(`Recipient ${to} is not on WHATSAPP_RECIPIENT_ALLOWLIST`);
  }
}
