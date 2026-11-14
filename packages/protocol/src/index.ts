/**
 * @elm/protocol
 * Shared domain types and constants between the Windows 11 Electron desktop app
 * and the Cloudflare Workers + D1 + SQLite Durable Objects backend.
 *
 * Phase 1 Scaffold: Type definitions and invariant constants only.
 * Authentication, signaling, and capture implementations are deferred to later phases.
 */

export const PROTOCOL_VERSION = '0.1.0-phase1' as const;

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
 * API health check response contract for the Phase 1 scaffold.
 */
export interface ApiHealthResponse {
  readonly status: 'ok';
  readonly phase: 'phase-1-scaffold';
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly timestamp: string;
}
