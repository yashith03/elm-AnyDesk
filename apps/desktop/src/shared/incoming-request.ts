import type { InviteSummary } from '@elm/protocol';

const GENERIC_BACKEND_DEVICE_NAMES = new Set([
  'elm device',
  'windows desktop',
  'unknown device',
]);

/**
 * Formats the incoming request headline without ever exposing email or phone.
 * Uses "<Display name> wants to connect" only when a direct non-generic self-entered
 * display name is available locally; otherwise falls back to
 * "Device <code> wants to connect".
 */
export function formatIncomingRequestHeadline(
  invite: Pick<
    InviteSummary,
    'requesterDisplayName' | 'requesterFriendCode'
  > & { readonly intent?: InviteSummary['intent'] }
): string {
  const rawName = (invite.requesterDisplayName ?? '').trim();
  const normalized = rawName.toLowerCase();
  const hasRealName =
    rawName.length > 0 &&
    !GENERIC_BACKEND_DEVICE_NAMES.has(normalized) &&
    !rawName.includes('@');
  const actor = hasRealName ? rawName : `Device ${invite.requesterFriendCode}`;
  if (invite.intent === 'invite') {
    return `${actor} invited you to view their screen`;
  }
  return `${actor} wants to connect`;
}
