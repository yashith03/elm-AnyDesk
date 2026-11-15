/**
 * @elm/protocol
 * Shared domain types, validation helpers, and constants between the Windows 11
 * Electron desktop app and the Cloudflare Workers + D1 + SQLite Durable Objects backend.
 */

export const PROTOCOL_VERSION = '0.5.0-phase5' as const;

/**
 * Default liveness heartbeat configuration.
 * A liveness threshold detects abrupt peer/network loss when a close event cannot arrive;
 * it is NEVER a time limit on a healthy connected session.
 */
export const DEFAULT_LIVENESS_CONFIG = Object.freeze({
  heartbeatIntervalMs: 1000,
  livenessTimeoutMs: 3500,
});

/**
 * Free-tier STUN-only ICE server configuration for WebRTC peer connections.
 * Media and private chat flow peer-to-peer (media A -> B, chat bidirectional via reliable DataChannel).
 * The Cloudflare Worker only coordinates signaling and session state.
 */
export const STUN_ICE_SERVERS: ReadonlyArray<{ readonly urls: string }> =
  Object.freeze([
    Object.freeze({ urls: 'stun:stun.l.google.com:19302' }),
    Object.freeze({ urls: 'stun:stun.cloudflare.com:3478' }),
  ]);

/**
 * Zero-bill pilot policy constants.
 * Strictly enforces STUN-only WebRTC, no TURN relays, no paid services, and no automatic upgrades.
 */
export const PILOT_NETWORK_POLICY = Object.freeze({
  stunOnly: true,
  turnEnabled: false,
  paidServicesEnabled: false,
  autoUpgradeEnabled: false,
  stunServers: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] as const,
  restrictiveNetworkLimitationMessage:
    'Direct peer-to-peer connection failed under STUN-only mode (stun:stun.l.google.com:19302, stun:stun.cloudflare.com:3478). Because this zero-bill pilot does not enable paid TURN relays, connections across symmetric NATs or UDP-blocking enterprise firewalls cannot complete. Switch to a less restrictive network or allow outbound UDP on ports 19302/3478.',
});

/**
 * Validates that an ICE server list contains only STUN URLs (`stun:` / `stuns:`)
 * and rejects any `turn:` or `turns:` relay servers.
 */
export function validateStunOnlyIceServers(
  iceServers: ReadonlyArray<{ readonly urls: string | readonly string[] }>
): { readonly valid: boolean; readonly rejectedUrls: readonly string[] } {
  const rejectedUrls: string[] = [];
  for (const entry of iceServers) {
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    for (const rawUrl of urls) {
      const normalized = String(rawUrl).trim().toLowerCase();
      if (!normalized.startsWith('stun:') && !normalized.startsWith('stuns:')) {
        rejectedUrls.push(String(rawUrl));
      }
    }
  }
  return {
    valid: rejectedUrls.length === 0 && iceServers.length > 0,
    rejectedUrls,
  };
}

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
  | 'SESSION_ALREADY_ENDED'
  | 'INVALID_SIGNAL_PAYLOAD'
  | 'RESTRICTIVE_NETWORK_STUN_ONLY_LIMITATION'
  | 'MEDIA_AND_CHAT_DEFERRED_IN_PHASE2'
  | 'INVALID_DEVICE_CREDENTIAL'
  | 'DEVICE_SECRET_MISMATCH';

/**
 * Local-only user/device profile stored on-device and never transmitted to the backend.
 */
export interface LocalDeviceProfile {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly updatedAt: string;
}

export type DeviceRegistrationStatus =
  | 'unregistered'
  | 'registering'
  | 'registered'
  | 'offline'
  | 'error';

export interface AnonymousDeviceRegistrationRequest {
  readonly deviceId: string;
  readonly deviceSecret: string;
}

export interface AnonymousDeviceRegistrationResponse {
  readonly token: string;
  readonly expiresAt: string;
  readonly account: AccountProfile;
  readonly alreadyRegistered: boolean;
}

/**
 * Structured receipt produced by the unified idempotent session teardown path.
 * Repeated teardown calls for the same sessionId return `alreadyEnded: true`
 * and increment `duplicateCallCount` without throwing or repeating side effects.
 */
export interface SessionTeardownReceipt {
  readonly sessionId: string;
  readonly reason: SessionTerminationReason;
  readonly subReason: string;
  readonly initiatedByAccountId: string | null;
  readonly terminatedAt: string;
  readonly alreadyEnded: boolean;
  readonly duplicateCallCount: number;
  readonly hostTracksStoppedCount: number;
  readonly peerConnectionsClosed: boolean;
  readonly dataChannelsClosed: boolean;
  readonly guestViewerCleared: boolean;
  readonly permissionsInvalidated: boolean;
  readonly signalingMembershipInvalidated: boolean;
  readonly detectionTimeMs: number;
}

/**
 * Distinct media capture sources controlled strictly by Host A.
 */
export type MediaSourceKind =
  | 'screenVideo'
  | 'microphoneAudio'
  | 'deviceAudio';

export const STREAM_ID_BY_SOURCE: Readonly<Record<MediaSourceKind, string>> =
  Object.freeze({
    screenVideo: 'elm-stream-screenVideo',
    microphoneAudio: 'elm-stream-microphoneAudio',
    deviceAudio: 'elm-stream-deviceAudio',
  });

export type MediaSourceStatusKind =
  | 'off'
  | 'approved_awaiting_start'
  | 'starting'
  | 'active'
  | 'stopped_by_host'
  | 'permission_denied'
  | 'source_disappeared'
  | 'unsupported';

export interface MediaSourceStatusDescriptor {
  readonly source: MediaSourceKind;
  readonly approved: boolean;
  readonly active: boolean;
  readonly status: MediaSourceStatusKind;
  readonly message: string;
  readonly trackId: string | null;
  readonly streamId: string | null;
  readonly label: string | null;
}

export type HostMediaRuntimeState = Readonly<
  Record<MediaSourceKind, MediaSourceStatusDescriptor>
>;

export interface WebRtcTrackDescriptor {
  readonly source: MediaSourceKind;
  readonly kind: 'video' | 'audio';
  readonly trackId: string;
  readonly streamId: string;
  readonly label: string;
}

/**
 * WebRTC signaling payloads exchanged through SignalingCoordinator ONLY after
 * an invite is accepted. The Worker coordinates SDP/ICE and session state,
 * never media frames or chat payloads.
 */
export type WebRtcSignalPayload =
  | {
      readonly type: 'offer';
      readonly sdp: string;
      readonly activeTracks: readonly WebRtcTrackDescriptor[];
    }
  | {
      readonly type: 'answer';
      readonly sdp: string;
    }
  | {
      readonly type: 'ice-candidate';
      readonly candidate: string;
      readonly sdpMid: string | null;
      readonly sdpMLineIndex: number | null;
    }
  | {
      readonly type: 'media-status';
      readonly activeTracks: readonly WebRtcTrackDescriptor[];
      readonly sourceStatuses: Partial<
        Record<
          MediaSourceKind,
          { readonly status: MediaSourceStatusKind; readonly message: string }
        >
      >;
    }
  | {
      readonly type: 'teardown';
      readonly reason: SessionTerminationReason;
      readonly subReason?: string;
    };

export interface WebRtcSignalEnvelope {
  readonly seq: number;
  readonly signalId: string;
  readonly sessionId: string;
  readonly senderAccountId: string;
  readonly targetAccountId: string;
  readonly payload: WebRtcSignalPayload;
  readonly createdAt: string;
}

/**
 * Ephemeral private chat message sent peer-to-peer over a reliable, ordered
 * WebRTC DataChannel ('elm-private-chat'). Never persisted in D1, SQLite, or disk.
 */
export interface EphemeralChatMessage {
  readonly messageId: string;
  readonly sessionId: string;
  readonly senderAccountId: string;
  readonly senderDisplayName: string;
  readonly text: string;
  readonly sentAt: string;
}

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
      readonly type: 'session:signal';
      readonly envelope: WebRtcSignalEnvelope;
    }
  | {
      readonly type: 'session:ended';
      readonly sessionId: string;
      readonly reason: SessionTerminationReason;
      readonly subReason?: string;
      readonly receipt?: SessionTeardownReceipt;
    }
  | {
      readonly type: 'error';
      readonly code: ProtocolErrorCode;
      readonly message: string;
    };

/**
 * Pilot installer & download metadata served by the Worker download page (`GET /download/manifest.json`).
 */
export interface PilotDownloadManifest {
  readonly appName: string;
  readonly version: string;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly platform: 'win32-x64';
  readonly installerFilename: string;
  readonly installerDownloadUrl: string;
  readonly installerSha256: string;
  readonly autoUpgradeEnabled: false;
  readonly stunOnlyPilot: true;
  readonly turnEnabled: false;
  readonly paidServicesEnabled: false;
  readonly stunServers: readonly string[];
  readonly restrictiveNetworkNotice: string;
}

/**
 * API health check response contract.
 */
export interface ApiHealthResponse {
  readonly status: 'ok';
  readonly phase: 'phase-5-staging-and-installer-pilot';
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly timestamp: string;
}
