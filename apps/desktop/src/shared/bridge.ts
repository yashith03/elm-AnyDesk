import type {
  AccountProfile,
  AllowedScreenSurface,
  ApprovedSessionSummary,
  EphemeralChatMessage,
  HostMediaRuntimeState,
  HostMediaSelection,
  InviteSummary,
  MediaSourceKind,
  PresenceStateSnapshot,
  ProtocolErrorCode,
  SessionLifecycleState,
  SessionTeardownReceipt,
  SessionTerminationReason,
  WebRtcSignalEnvelope,
  WebRtcSignalPayload,
} from '@elm/protocol';

export type DesktopWindowRole = 'main' | 'chat';

export interface DesktopSecurityPosture {
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly webSecurity: true;
  readonly narrowPreloadBridge: true;
}

export interface DesktopRuntimeMetadata {
  readonly appName: string;
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly chromeVersion: string;
  readonly nodeVersion: string;
  readonly osRelease: string;
  readonly protocolVersion: string;
  readonly platform: string;
  readonly windowRole: DesktopWindowRole;
  readonly phase: 'Phase 5 — Windows Installer, Cloudflare Staging & Pilot Verification';
  readonly defaultMediaSelection: HostMediaSelection;
  readonly initialSessionState: SessionLifecycleState;
  readonly securityPosture: DesktopSecurityPosture;
  readonly apiBaseUrl: string;
}

export interface TaskbarTransitionEvent {
  readonly timestamp: string;
  readonly action: string;
  readonly isMinimized: boolean;
  readonly win32IsIconic: boolean;
  readonly skipTaskbarApplied: boolean;
  readonly wsExAppWindow: boolean;
  readonly wsExToolWindow: boolean;
}

export interface TaskbarDwmTelemetry {
  readonly hwndHex: string;
  readonly isMinimized: boolean;
  readonly win32IsIconic: boolean;
  readonly win32IsVisible: boolean;
  readonly skipTaskbarApplied: boolean;
  readonly wsExAppWindow: boolean;
  readonly wsExToolWindow: boolean;
  readonly dwmAttributes: {
    readonly forceIconicRepresentation: string;
    readonly hasIconicBitmap: string;
    readonly disallowPeek: string;
    readonly excludedFromPeek: string;
    readonly invalidateIconicBitmaps: string;
  };
  readonly iconicThumbnail: {
    readonly callbackCount: number;
    readonly lastHResult: string;
    readonly lastWidth: number;
    readonly lastHeight: number;
  };
  readonly livePreview: {
    readonly callbackCount: number;
    readonly lastHResult: string;
  };
  readonly transitions: readonly TaskbarTransitionEvent[];
}

export interface ShareableSourceDescriptor {
  readonly id: string;
  readonly name: string;
  readonly surfaceType: AllowedScreenSurface;
  readonly displayId: string;
  readonly thumbnailDataUrl: string;
}

export interface WasapiEndpointProbeResult {
  readonly ok: boolean;
  readonly endpointId: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly error?: string;
}

export interface WasapiAudioChunkPayload {
  readonly sampleRate: number;
  readonly frames: number;
  readonly rms: number;
  readonly peak: number;
  readonly pcmFloat32Base64: string;
}

export interface ApiActionResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data?: T;
  readonly errorCode?: ProtocolErrorCode | string;
  readonly errorMessage?: string;
}

/**
 * In-memory volatile session & chat state shared between the Main Window and the
 * Separate Chat Window. Never persisted to disk, SQLite, D1, or localStorage.
 */
export interface VolatileSessionUiState {
  readonly session: ApprovedSessionSummary | null;
  readonly currentAccount: AccountProfile | null;
  readonly connectionState: string;
  readonly dataChannelState: 'closed' | 'connecting' | 'open';
  readonly messagePreviewsEnabled: boolean;
  readonly messages: readonly EphemeralChatMessage[];
  readonly hostMediaState: HostMediaRuntimeState | null;
}

/**
 * Narrow preload bridge contract exposed on `window.elmDesktop`.
 * Raw Electron IPC primitives and provider secrets are never exposed to the renderer.
 */
export interface ElmDesktopBridge {
  getRuntimeMetadata: () => Promise<DesktopRuntimeMetadata>;
  openSeparateChatWindow: () => Promise<{ opened: boolean }>;
  copyTextToClipboard: (text: string) => Promise<{ copied: boolean }>;

  // Phase 2: Authentication, Friend Codes, Presence & Invites
  getStoredAuthSession: () => Promise<
    ApiActionResult<{ account: AccountProfile; snapshot: PresenceStateSnapshot }>
  >;
  startBrowserOAuthSignIn: () => Promise<
    ApiActionResult<{ authUrlOpened: boolean; message: string }>
  >;
  signInWithTestDouble: (personaKey: string) => Promise<
    ApiActionResult<{ account: AccountProfile; snapshot: PresenceStateSnapshot }>
  >;
  switchActivePersona: (personaKey: string) => Promise<
    ApiActionResult<{ account: AccountProfile; snapshot: PresenceStateSnapshot }>
  >;
  signOut: () => Promise<{ signedOut: boolean }>;
  getPresenceSnapshot: () => Promise<
    ApiActionResult<{ snapshot: PresenceStateSnapshot }>
  >;
  setPresenceOnline: (
    online: boolean,
    options?: {
      personaKey?: string;
      reason?: SessionTerminationReason;
      subReason?: string;
    }
  ) => Promise<
    ApiActionResult<{
      snapshot: PresenceStateSnapshot;
      receipt?: SessionTeardownReceipt | null;
    }>
  >;
  sendFriendCodeInvite: (friendCode: string) => Promise<
    ApiActionResult<{ invite: InviteSummary; snapshot: PresenceStateSnapshot }>
  >;
  respondToInvite: (params: {
    inviteId: string;
    action: 'accept' | 'decline';
    mediaSelection?: HostMediaSelection;
  }) => Promise<
    ApiActionResult<{
      invite: InviteSummary;
      session: ApprovedSessionSummary | null;
      snapshot: PresenceStateSnapshot;
    }>
  >;
  disconnectActiveSession: (
    sessionIdOrOptions?:
      | string
      | {
          sessionId?: string;
          reason?: SessionTerminationReason;
          subReason?: string;
          callerAccountId?: string;
          detectionTimeMs?: number;
        }
  ) => Promise<
    ApiActionResult<{
      disconnected: boolean;
      alreadyEnded: boolean;
      receipt: SessionTeardownReceipt;
      snapshot: PresenceStateSnapshot;
    }>
  >;
  recordSessionHeartbeat: (params: {
    sessionId: string;
    callerAccountId?: string;
    timestampMs?: number;
  }) => Promise<
    ApiActionResult<{
      ok: boolean;
      sessionId: string;
      heartbeatAtMs: number;
    }>
  >;
  checkSessionLiveness: (params: {
    sessionId: string;
    callerAccountId?: string;
    nowMs?: number;
    livenessTimeoutMs?: number;
  }) => Promise<
    ApiActionResult<{
      alive: boolean;
      alreadyEnded: boolean;
      sessionId: string;
      hostHeartbeatAgeMs: number;
      guestHeartbeatAgeMs: number;
      livenessTimeoutMs: number;
      sessionDurationMs: number;
      receipt?: SessionTeardownReceipt;
    }>
  >;

  // Phase 3: Approved Session WebRTC Signaling & Separate Chat Window Sync
  sendSessionSignal: (params: {
    sessionId: string;
    senderAccountId?: string;
    payload: WebRtcSignalPayload;
  }) => Promise<
    ApiActionResult<{
      admitted: boolean;
      session: ApprovedSessionSummary;
      envelope: WebRtcSignalEnvelope;
    }>
  >;
  pollSessionSignals: (params: {
    sessionId: string;
    receiverAccountId?: string;
    afterSeq: number;
  }) => Promise<
    ApiActionResult<{
      session: ApprovedSessionSummary;
      signals: readonly WebRtcSignalEnvelope[];
    }>
  >;
  getVolatileSessionUiState: () => Promise<VolatileSessionUiState>;
  syncVolatileSessionUiState: (
    patch: Partial<VolatileSessionUiState>
  ) => Promise<VolatileSessionUiState>;
  sendChatFromChatWindow: (params: {
    text: string;
    senderOverride?: 'host' | 'guest';
  }) => Promise<{ queued: boolean }>;
  requestHostStopSharingFromChatWindow: (
    target: MediaSourceKind | 'all'
  ) => Promise<{ requested: boolean }>;
  onVolatileSessionUiStateUpdated: (
    listener: (state: VolatileSessionUiState) => void
  ) => () => void;
  onChatWindowOutboundSend: (
    listener: (params: {
      text: string;
      senderOverride?: 'host' | 'guest';
    }) => void
  ) => () => void;
  onHostStopSharingRequest: (
    listener: (target: MediaSourceKind | 'all') => void
  ) => () => void;

  // Windows 11 Taskbar & DWM Preview Prototype
  getTaskbarDwmTelemetry: () => Promise<TaskbarDwmTelemetry>;
  minimizeMainWindow: () => Promise<TaskbarDwmTelemetry>;
  restoreMainWindow: () => Promise<TaskbarDwmTelemetry>;
  runTaskbarMinimizeRestoreCycle: () => Promise<TaskbarDwmTelemetry>;
  verifyStaticThumbnailAndPeek: () => Promise<TaskbarDwmTelemetry>;

  // Explicit Source Picker (Displays & Windows only, never webcam)
  listShareableSources: () => Promise<ShareableSourceDescriptor[]>;
  selectShareableSource: (
    sourceId: string
  ) => Promise<{ selectedSourceId: string; sourceName: string }>;

  // Windows-native WASAPI Loopback Prototype (Device Audio independent of Screen Video)
  probeWasapiLoopback: () => Promise<WasapiEndpointProbeResult>;
  startWasapiLoopback: (options: {
    playTestTone: boolean;
  }) => Promise<WasapiEndpointProbeResult>;
  stopWasapiLoopback: () => Promise<{ stopped: boolean }>;
  onWasapiAudioChunk: (
    listener: (chunk: WasapiAudioChunkPayload) => void
  ) => () => void;
}

declare global {
  interface Window {
    elmDesktop: ElmDesktopBridge;
  }
}
