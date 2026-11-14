/**
 * @elm/protocol
 * Shared domain types, validation helpers, and constants between the Windows 11
 * Electron desktop app and the Cloudflare Workers + D1 + SQLite Durable Objects backend.
 */

export const PROTOCOL_VERSION = '0.2.0-phase2' as const;

/**
 * Friend Code format: ELM-XXXX-XXXX where X is an unambiguous uppercase alphanumeric
 * character (excluding 0, O, 1, I, L to prevent visual confusion).
 */
export const FRIEND_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' as const;
export const FRIEND_CODE_REGEX =
  /^ELM-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

export function normalizeFriendCode(input: string): string {
  return input.trim().toUpperCase();
}

export function isValidFriendCode(input: string): boolean {
  return FRIEND_CODE_REGEX.test(normalizeFriendCode(input));
}

export function generateRandomFriendCode(
  getRandomBytes: (length: number) => Uint8Array = (len) => {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return arr;
  }
): string {
  const bytes = getRandomBytes(8);
  let part1 = '';
  let part2 = '';
  for (let i = 0; i < 4; i++) {
    part1 += FRIEND_CODE_ALPHABET[bytes[i] % FRIEND_CODE_ALPHABET.length];
    part2 += FRIEND_CODE_ALPHABET[bytes[i + 4] % FRIEND_CODE_ALPHABET.length];
  }
  return `ELM-${part1}-${part2}`;
}

/**
 * Host (User A) capture toggles chosen independently before accepting an invite
 * and controllable individually during an active session.
 * Both audio options MUST default to OFF.
 * Screen Video refers strictly to a window or display selected by User A (never a webcam).
 */
export interface HostMediaSelection {
  readonly screenVideo: boolean;
  readonly microphoneAudio: boolean;
  readonly deviceAudio: boolean;
}

export const DEFAULT_HOST_MEDIA_SELECTION: HostMediaSelection = Object.freeze({
  screenVideo: false,
  microphoneAudio: false,
  deviceAudio: false,
});

export function sanitizeHostMediaSelection(
  input?: Partial<HostMediaSelection> | null
): HostMediaSelection {
  return {
    screenVideo: Boolean(input?.screenVideo),
    microphoneAudio: Boolean(input?.microphoneAudio),
    deviceAudio: Boolean(input?.deviceAudio),
  };
}

/**
 * Allowed screen capture surface types for User A (webcam is explicitly excluded).
 */
export type AllowedScreenSurface = 'window' | 'display';

/**
 * High-level session lifecycle states.
 * Note: Ended sessions ('ended') can NEVER be resumed; a fresh invite and fresh
 * acceptance using the permanent Friend Code are always required.
 */
export type SessionLifecycleState =
  | 'idle'
  | 'invite_pending'
  | 'accepted_chat_connected'
  | 'sharing_active'
  | 'ended';

/**
 * Reasons that immediately terminate an active session for both peers.
 * Minimizing the window is explicitly NOT a disconnect trigger.
 */
export type SessionTerminationReason =
  | 'user_top_bar_disconnect'
  | 'app_closed'
  | 'connection_lost'
  | 'invite_declined';

/**
 * Authenticated account profile stored in D1.
 * The Friend Code is generated once on initial account creation and reused across all
 * subsequent sign-ins and app restarts.
 */
export interface AccountProfile {
  readonly accountId: string;
  readonly provider: string;
  readonly providerSubject: string;
  readonly displayName: string;
  readonly friendCode: string;
  readonly createdAt: string;
}

export interface AuthSessionResponse {
  readonly token: string;
  readonly account: AccountProfile;
  readonly expiresAt: string;
}

/**
 * Standardized protocol error codes for invite, presence, and session enforcement.
 */
export type ProtocolErrorCode =
  | 'UNAUTHORIZED'
  | 'AUTH_PROVIDER_NOT_CONFIGURED'
  | 'INVALID_FRIEND_CODE_FORMAT'
  | 'FRIEND_CODE_NOT_FOUND'
  | 'SELF_INVITE_NOT_ALLOWED'
  | 'TARGET_OFFLINE'
  | 'DUPLICATE_PENDING_INVITE'
  | 'OUTGOING_INVITE_ALREADY_PENDING'
  | 'USER_ALREADY_IN_ACTIVE_SESSION'
  | 'INVITE_NOT_FOUND'
  | 'INVITE_ALREADY_RESOLVED'
  | 'NOT_INVITE_OWNER'
  | 'UNAUTHORIZED_SESSION_PARTICIPANT'
  | 'SIGNALING_NOT_ADMITTED_BEFORE_ACCEPTANCE'
  | 'MEDIA_AND_CHAT_DEFERRED_IN_PHASE2';

export type InviteStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'cancelled';

export interface InviteSummary {
  readonly inviteId: string;
  readonly requesterAccountId: string;
  readonly requesterFriendCode: string;
  readonly requesterDisplayName: string;
  readonly targetAccountId: string;
  readonly targetFriendCode: string;
  readonly targetDisplayName: string;
  readonly status: InviteStatus;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface ApprovedSessionSummary {
  readonly sessionId: string;
  readonly inviteId: string;
  readonly hostAccountId: string;
  readonly hostFriendCode: string;
  readonly hostDisplayName: string;
  readonly guestAccountId: string;
  readonly guestFriendCode: string;
  readonly guestDisplayName: string;
  readonly hostMediaSelection: HostMediaSelection;
  readonly createdAt: string;
}

export interface PresenceStateSnapshot {
  readonly online: boolean;
  readonly account: AccountProfile;
  readonly incomingInvites: readonly InviteSummary[];
  readonly outgoingInvite: InviteSummary | null;
  readonly activeSession: ApprovedSessionSummary | null;
}

/**
 * WebSocket / Server-to-Client real-time events from SignalingCoordinator DO.
 */
export type CoordinatorServerEvent =
  | {
      readonly type: 'presence:snapshot';
      readonly snapshot: PresenceStateSnapshot;
    }
  | {
      readonly type: 'invite:incoming';
      readonly invite: InviteSummary;
    }
  | {
      readonly type: 'invite:updated';
      readonly invite: InviteSummary;
      readonly reason?: string;
    }
  | {
      readonly type: 'session:approved';
      readonly session: ApprovedSessionSummary;
    }
  | {
      readonly type: 'session:ended';
      readonly sessionId: string;
      readonly reason: SessionTerminationReason;
    }
  | {
      readonly type: 'error';
      readonly code: ProtocolErrorCode;
      readonly message: string;
    };

/**
 * API health check response contract.
 */
export interface ApiHealthResponse {
  readonly status: 'ok';
  readonly phase: 'phase-2-auth-invites-presence';
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly timestamp: string;
}
