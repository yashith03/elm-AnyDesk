import { normalizeFriendCode } from '@elm/protocol';
import type { RecentPeerEntry } from './recent-peers';

const GENERIC_PEER_NAMES = new Set([
  '',
  'elm device',
  'windows desktop',
  'unknown device',
]);

/**
 * Formats a remaining duration in milliseconds as `MM:SS` (e.g. `01:45`).
 */
export function formatCountdownMmSs(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Resolves the display label for the friend shown in the Waiting for Approval panel.
 */
export function resolveWaitingPeerName(
  targetFriendCode: string,
  targetDisplayName: string | null | undefined,
  recentPeers: readonly RecentPeerEntry[]
): string {
  const normalizedCode = normalizeFriendCode(targetFriendCode);
  const matched = recentPeers.find(
    (peer) => normalizeFriendCode(peer.friendCode) === normalizedCode
  );
  if (matched) {
    if (matched.alias.trim().length > 0) {
      return matched.alias.trim();
    }
    if (matched.peerName && matched.peerName.trim().length > 0) {
      return matched.peerName.trim();
    }
  }
  const cleanedDisplay = (targetDisplayName ?? '').trim();
  if (!GENERIC_PEER_NAMES.has(cleanedDisplay.toLowerCase())) {
    return cleanedDisplay;
  }
  return normalizedCode || targetFriendCode;
}
