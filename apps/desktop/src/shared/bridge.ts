import type {
  AccountProfile,
  AllowedScreenSurface,
  ApprovedSessionSummary,
  BackendCompatibilityStatus,
  ChatDeliveryStatus,
  DevicePresenceConnectionState,
  DeviceRegistrationStatus,
  EphemeralChatMessage,
  HostMediaRuntimeState,
  HostMediaSelection,
  InviteIntent,
  InviteSummary,
  LocalDeviceProfile,
  MediaSourceKind,
  PresenceStateSnapshot,
  ProtocolErrorCode,
  SessionLifecycleState,
  SessionTeardownReceipt,
  SessionTerminationReason,
  WebRtcSignalEnvelope,
  WebRtcSignalPayload,
} from '@elm/protocol';
import type { ThemeMode, ThemeStateSnapshot } from './theme';
import type { RecentPeerEntry } from './recent-peers';
import type { FloatingPanelAppearance } from './floating-panel';
import type { CaptureProtectionState } from './capture-protection';

export type DesktopWindowRole =
  | 'main'
  | 'chat'
  | 'presentation'
  | 'host-toolbar'
  | 'host-source-picker'
  | 'host-settings';

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
  readonly devModeEnabled: boolean;
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
  readonly imageAttachmentsByMessageId: Record<string, string>;
  readonly messageStatusesById: Record<string, ChatDeliveryStatus>;
  readonly hostMediaState: HostMediaRuntimeState | null;
}

export interface HostOverlayUiState {
  readonly sessionActive: boolean;
  readonly sessionId: string | null;
  readonly peerDisplayName: string;
  readonly connectionState: string;
  readonly iceConnectionState: string;
  readonly dataChannelState: 'closed' | 'connecting' | 'open';
  readonly hostMediaState: HostMediaRuntimeState | null;
  readonly hostMicMutedLocally: boolean;
  readonly peerMicActive?: boolean;
  readonly peerMicMutedLocally?: boolean;
  readonly peerMicRequestPending?: boolean;
  readonly isStartingShare: boolean;
  readonly isStartingMic: boolean;
  readonly isStartingDeviceSound: boolean;
  readonly shareableSources: readonly ShareableSourceDescriptor[];
  readonly selectedSourceId: string | null;
  readonly playWasapiTestTone: boolean;
  readonly chatOpen: boolean;
  readonly hasUnreadChat?: boolean;
  readonly sourcePickerOpen: boolean;
  readonly settingsOpen: boolean;
  readonly appearance: FloatingPanelAppearance;
  readonly captureProtection: CaptureProtectionState;
}

export type HostToolbarActionPayload =
  | { type: 'toggle-mic' }
  | { type: 'stop-mic' }
  | { type: 'toggle-device-sound' }
  | { type: 'toggle-peer-mic' }
  | { type: 'start-screen' }
  | { type: 'stop-screen' }
  | { type: 'select-source'; sourceId: string }
  | { type: 'refresh-sources' }
  | { type: 'set-wasapi-test-tone'; enabled: boolean }
  | { type: 'end-session' }
  | { type: 'focus-main' };

/**
 * Narrow preload bridge contract exposed on `window.elmDesktop`.
 * Raw Electron IPC primitives and provider secrets are never exposed to the renderer.
 */
export interface DeviceSetupState {
  readonly profileCompleted: boolean;
  readonly localProfile: LocalDeviceProfile | null;
  readonly registrationStatus: DeviceRegistrationStatus;
  readonly registrationMessage: string | null;
  readonly registeredAccount: AccountProfile | null;
}

export interface PresenceRuntimeStatus {
  readonly connectionState: DevicePresenceConnectionState;
  readonly serverConfirmedOnline: boolean;
  readonly lastConfirmedAt: string | null;
  readonly consecutiveFailures: number;
  readonly snapshot: PresenceStateSnapshot | null;
  readonly snapshotGeneration?: number;
  readonly backendCompatibility?: BackendCompatibilityStatus;
}

export interface ElmDesktopBridge {
  getRuntimeMetadata: () => Promise<DesktopRuntimeMetadata>;
  openSeparateChatWindow: () => Promise<{
    opened: boolean;
    mainHwndHex?: string;
    chatHwndHex?: string;
    distinctHwnds?: boolean;
  }>;
  openPresentationView: () => Promise<{
    opened: boolean;
    mainHwndHex?: string;
    presentationHwndHex?: string;
    distinctHwnds?: boolean;
  }>;
  copyTextToClipboard: (text: string) => Promise<{ copied: boolean }>;

  // Device Setup & Anonymous Registration (On-device profile, zero login)
  getDeviceSetupState: () => Promise<ApiActionResult<DeviceSetupState>>;
  saveLocalProfile: (input: {
    name: string;
    email?: string;
    phone?: string;
    shareEmailWithPeers?: boolean;
    sharePhoneWithPeers?: boolean;
  }) => Promise<ApiActionResult<DeviceSetupState>>;
  retryDeviceRegistration: () => Promise<ApiActionResult<DeviceSetupState>>;

  // Phase 2: Authentication, Friend Codes, Presence & Invites
  getStoredAuthSession: () => Promise<
    ApiActionResult<{ account: AccountProfile; snapshot: PresenceStateSnapshot }>
  >;
  updateLocalDisplayName: (displayName: string) => Promise<
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
  getPresenceRuntimeStatus: () => Promise<PresenceRuntimeStatus>;
  triggerPresenceReconnect: () => Promise<PresenceRuntimeStatus>;
  onPresenceStatusUpdated: (
    listener: (status: PresenceRuntimeStatus) => void
  ) => () => void;
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
  sendFriendCodeInvite: (
    input:
      | string
      | {
          friendCode: string;
          intent?: InviteIntent;
          hostMediaSelection?: HostMediaSelection;
        }
  ) => Promise<
    ApiActionResult<{ invite: InviteSummary; snapshot: PresenceStateSnapshot }>
  >;
  cancelOutgoingInvite: (inviteId: string) => Promise<
    ApiActionResult<{ invite: InviteSummary; snapshot: PresenceStateSnapshot }>
  >;
  lookupDevicePresence: (friendCodes: string[]) => Promise<
    ApiActionResult<{ statuses: Record<string, boolean> }>
  >;
  getRecentPeers: () => Promise<RecentPeerEntry[]>;
  recordConnectedPeer: (params: {
    friendCode: string;
    defaultAlias?: string;
    connectedAt?: string;
  }) => Promise<RecentPeerEntry[]>;
  updateRecentPeerContact: (params: {
    friendCode: string;
    peerName?: string;
    email?: string;
    phone?: string;
    connectedAt?: string;
  }) => Promise<RecentPeerEntry[]>;
  toggleFavoritePeer: (friendCode: string) => Promise<RecentPeerEntry[]>;
  renameRecentPeer: (params: {
    friendCode: string;
    alias: string;
  }) => Promise<RecentPeerEntry[]>;
  removeRecentPeer: (friendCode: string) => Promise<RecentPeerEntry[]>;
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
    imageDataUrl?: string;
    imageMimeType?: string;
    imageName?: string;
    imageByteLength?: number;
  }) => Promise<{ queued: boolean }>;
  requestHostStopSharingFromChatWindow: (
    target: MediaSourceKind | 'all'
  ) => Promise<{ requested: boolean }>;
  markChatMessagesSeen: (
    messageIds: readonly string[]
  ) => Promise<{ marked: boolean }>;
  onChatMessagesSeenRequested: (
    listener: (messageIds: readonly string[]) => void
  ) => () => void;
  onVolatileSessionUiStateUpdated: (
    listener: (state: VolatileSessionUiState) => void
  ) => () => void;
  onChatWindowOutboundSend: (
    listener: (params: {
      text: string;
      senderOverride?: 'host' | 'guest';
      imageDataUrl?: string;
      imageMimeType?: string;
      imageName?: string;
      imageByteLength?: number;
    }) => void
  ) => () => void;
  onHostStopSharingRequest: (
    listener: (target: MediaSourceKind | 'all') => void
  ) => () => void;

  // Independent Host Floating Toolbar, Source Picker, Settings, Appearance & Capture Protection
  getHostOverlayState: () => Promise<HostOverlayUiState>;
  syncHostOverlayState: (
    patch: Partial<HostOverlayUiState>
  ) => Promise<HostOverlayUiState>;
  onHostOverlayStateUpdated: (
    listener: (state: HostOverlayUiState) => void
  ) => () => void;
  dispatchHostToolbarAction: (
    action: HostToolbarActionPayload
  ) => Promise<{ dispatched: boolean }>;
  onHostToolbarAction: (
    listener: (action: HostToolbarActionPayload) => void
  ) => () => void;
  toggleHostToolbarWindow: (open: boolean) => Promise<{ open: boolean }>;
  toggleHostSourcePickerPopup: (open?: boolean) => Promise<{ open: boolean }>;
  toggleHostSettingsPopup: (open?: boolean) => Promise<{ open: boolean }>;
  closeSeparateChatWindow: () => Promise<{ closed: boolean }>;
  restoreAndFocusMainWindow: () => Promise<void>;
  getFloatingAppearance: () => Promise<FloatingPanelAppearance>;
  setFloatingAppearance: (
    patch: Partial<FloatingPanelAppearance>
  ) => Promise<FloatingPanelAppearance>;
  onFloatingAppearanceUpdated: (
    listener: (appearance: FloatingPanelAppearance) => void
  ) => () => void;
  getCaptureProtectionState: () => Promise<CaptureProtectionState>;
  setCaptureProtectionTestEnabled: (
    enabled: boolean
  ) => Promise<CaptureProtectionState>;
  onCaptureProtectionUpdated: (
    listener: (state: CaptureProtectionState) => void
  ) => () => void;

  // Centralized Theme State (Single Source of Truth across Main & Chat Windows)
  getThemeState: () => Promise<ThemeStateSnapshot>;
  setThemeMode: (mode: ThemeMode) => Promise<ThemeStateSnapshot>;
  resetThemeToSystemDefault: () => Promise<ThemeStateSnapshot>;
  reloadThemeFromDisk: () => Promise<ThemeStateSnapshot>;
  onThemeUpdated: (
    listener: (themeState: ThemeStateSnapshot) => void
  ) => () => void;

  // Windows 11 Custom Titlebar Window Controls & DWM Preview Prototype
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<{ maximized: boolean }>;
  closeWindow: () => Promise<void>;
  isWindowMaximized: () => Promise<boolean>;
  onWindowMaximizedChanged: (
    listener: (maximized: boolean) => void
  ) => () => void;
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
