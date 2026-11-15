import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  HostMediaSelection,
  MediaSourceKind,
  SessionTerminationReason,
  WebRtcSignalPayload,
} from '@elm/protocol';
import type {
  DesktopRuntimeMetadata,
  ElmDesktopBridge,
  ShareableSourceDescriptor,
  TaskbarDwmTelemetry,
  VolatileSessionUiState,
  WasapiAudioChunkPayload,
  WasapiEndpointProbeResult,
} from '../shared/bridge';
import type { ThemeMode, ThemeStateSnapshot } from '../shared/theme';

const bridge: ElmDesktopBridge = Object.freeze({
  getRuntimeMetadata: (): Promise<DesktopRuntimeMetadata> =>
    ipcRenderer.invoke('elm:get-runtime-metadata'),
  openSeparateChatWindow: () =>
    ipcRenderer.invoke('elm:open-separate-chat-window'),
  openPresentationView: () =>
    ipcRenderer.invoke('elm:open-presentation-view'),
  copyTextToClipboard: (text: string): Promise<{ copied: boolean }> =>
    ipcRenderer.invoke('elm:copy-text-to-clipboard', text),

  // Device Setup & Anonymous Registration (On-device profile, zero login)
  getDeviceSetupState: () => ipcRenderer.invoke('elm:device-get-setup-state'),
  saveLocalProfile: (input: { name: string; email?: string; phone?: string }) =>
    ipcRenderer.invoke('elm:device-save-local-profile', input),
  retryDeviceRegistration: () =>
    ipcRenderer.invoke('elm:device-retry-registration'),

  // Phase 2: Authentication, Friend Codes, Presence & Invites
  getStoredAuthSession: () => ipcRenderer.invoke('elm:auth-get-stored-session'),
  updateLocalDisplayName: (displayName: string) =>
    ipcRenderer.invoke('elm:update-local-display-name', displayName),
  startBrowserOAuthSignIn: () =>
    ipcRenderer.invoke('elm:auth-start-browser-oauth'),
  signInWithTestDouble: (personaKey: string) =>
    ipcRenderer.invoke('elm:auth-signin-test-double', personaKey),
  switchActivePersona: (personaKey: string) =>
    ipcRenderer.invoke('elm:auth-switch-persona', personaKey),
  signOut: () => ipcRenderer.invoke('elm:auth-sign-out'),
  getPresenceSnapshot: () => ipcRenderer.invoke('elm:presence-get-snapshot'),
  setPresenceOnline: (
    online: boolean,
    options?: {
      personaKey?: string;
      reason?: SessionTerminationReason;
      subReason?: string;
    }
  ) => ipcRenderer.invoke('elm:presence-set-online', online, options),
  sendFriendCodeInvite: (friendCode: string) =>
    ipcRenderer.invoke('elm:invites-send', friendCode),
  respondToInvite: (params: {
    inviteId: string;
    action: 'accept' | 'decline';
    mediaSelection?: HostMediaSelection;
  }) => ipcRenderer.invoke('elm:invites-respond', params),
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
  ) => ipcRenderer.invoke('elm:sessions-disconnect', sessionIdOrOptions),
  recordSessionHeartbeat: (params: {
    sessionId: string;
    callerAccountId?: string;
    timestampMs?: number;
  }) => ipcRenderer.invoke('elm:sessions-heartbeat', params),
  checkSessionLiveness: (params: {
    sessionId: string;
    callerAccountId?: string;
    nowMs?: number;
    livenessTimeoutMs?: number;
  }) => ipcRenderer.invoke('elm:sessions-check-liveness', params),

  // Phase 3: Approved Session WebRTC Signaling & Separate Chat Window Sync
  sendSessionSignal: (params: {
    sessionId: string;
    senderAccountId?: string;
    payload: WebRtcSignalPayload;
  }) => ipcRenderer.invoke('elm:sessions-send-signal', params),
  pollSessionSignals: (params: {
    sessionId: string;
    receiverAccountId?: string;
    afterSeq: number;
  }) => ipcRenderer.invoke('elm:sessions-poll-signals', params),
  getVolatileSessionUiState: (): Promise<VolatileSessionUiState> =>
    ipcRenderer.invoke('elm:volatile-ui-get'),
  syncVolatileSessionUiState: (
    patch: Partial<VolatileSessionUiState>
  ): Promise<VolatileSessionUiState> =>
    ipcRenderer.invoke('elm:volatile-ui-sync', patch),
  sendChatFromChatWindow: (params: {
    text: string;
    senderOverride?: 'host' | 'guest';
  }): Promise<{ queued: boolean }> =>
    ipcRenderer.invoke('elm:chat-window-outbound-send', params),
  requestHostStopSharingFromChatWindow: (
    target: MediaSourceKind | 'all'
  ): Promise<{ requested: boolean }> =>
    ipcRenderer.invoke('elm:chat-window-stop-sharing', target),
  onVolatileSessionUiStateUpdated: (
    listener: (state: VolatileSessionUiState) => void
  ): (() => void) => {
    const wrapped = (
      _event: IpcRendererEvent,
      state: VolatileSessionUiState
    ) => {
      listener(state);
    };
    ipcRenderer.on('elm:volatile-ui-updated', wrapped);
    return () => {
      ipcRenderer.removeListener('elm:volatile-ui-updated', wrapped);
    };
  },
  onChatWindowOutboundSend: (
    listener: (params: {
      text: string;
      senderOverride?: 'host' | 'guest';
    }) => void
  ): (() => void) => {
    const wrapped = (
      _event: IpcRendererEvent,
      params: { text: string; senderOverride?: 'host' | 'guest' }
    ) => {
      listener(params);
    };
    ipcRenderer.on('elm:chat-window-outbound-event', wrapped);
    return () => {
      ipcRenderer.removeListener('elm:chat-window-outbound-event', wrapped);
    };
  },
  onHostStopSharingRequest: (
    listener: (target: MediaSourceKind | 'all') => void
  ): (() => void) => {
    const wrapped = (
      _event: IpcRendererEvent,
      target: MediaSourceKind | 'all'
    ) => {
      listener(target);
    };
    ipcRenderer.on('elm:host-stop-sharing-event', wrapped);
    return () => {
      ipcRenderer.removeListener('elm:host-stop-sharing-event', wrapped);
    };
  },

  // Centralized Theme State
  getThemeState: (): Promise<ThemeStateSnapshot> =>
    ipcRenderer.invoke('elm:theme-get'),
  setThemeMode: (mode: ThemeMode): Promise<ThemeStateSnapshot> =>
    ipcRenderer.invoke('elm:theme-set', mode),
  resetThemeToSystemDefault: (): Promise<ThemeStateSnapshot> =>
    ipcRenderer.invoke('elm:theme-reset-system'),
  reloadThemeFromDisk: (): Promise<ThemeStateSnapshot> =>
    ipcRenderer.invoke('elm:theme-reload-disk'),
  onThemeUpdated: (
    listener: (themeState: ThemeStateSnapshot) => void
  ): (() => void) => {
    const wrapped = (
      _event: IpcRendererEvent,
      themeState: ThemeStateSnapshot
    ) => {
      listener(themeState);
    };
    ipcRenderer.on('elm:theme-updated', wrapped);
    return () => {
      ipcRenderer.removeListener('elm:theme-updated', wrapped);
    };
  },

  // Windows 11 Taskbar & DWM Preview Prototype
  getTaskbarDwmTelemetry: (): Promise<TaskbarDwmTelemetry> =>
    ipcRenderer.invoke('elm:get-taskbar-dwm-telemetry'),
  minimizeMainWindow: (): Promise<TaskbarDwmTelemetry> =>
    ipcRenderer.invoke('elm:minimize-main-window'),
  restoreMainWindow: (): Promise<TaskbarDwmTelemetry> =>
    ipcRenderer.invoke('elm:restore-main-window'),
  runTaskbarMinimizeRestoreCycle: (): Promise<TaskbarDwmTelemetry> =>
    ipcRenderer.invoke('elm:run-taskbar-minimize-restore-cycle'),
  verifyStaticThumbnailAndPeek: (): Promise<TaskbarDwmTelemetry> =>
    ipcRenderer.invoke('elm:verify-static-thumbnail-and-peek'),

  // Explicit Source Picker
  listShareableSources: (): Promise<ShareableSourceDescriptor[]> =>
    ipcRenderer.invoke('elm:list-shareable-sources'),
  selectShareableSource: (
    sourceId: string
  ): Promise<{ selectedSourceId: string; sourceName: string }> =>
    ipcRenderer.invoke('elm:select-shareable-source', sourceId),

  // WASAPI Loopback Prototype
  probeWasapiLoopback: (): Promise<WasapiEndpointProbeResult> =>
    ipcRenderer.invoke('elm:probe-wasapi-loopback'),
  startWasapiLoopback: (options: {
    playTestTone: boolean;
  }): Promise<WasapiEndpointProbeResult> =>
    ipcRenderer.invoke('elm:start-wasapi-loopback', options),
  stopWasapiLoopback: (): Promise<{ stopped: boolean }> =>
    ipcRenderer.invoke('elm:stop-wasapi-loopback'),
  onWasapiAudioChunk: (
    listener: (chunk: WasapiAudioChunkPayload) => void
  ): (() => void) => {
    const wrapped = (
      _event: IpcRendererEvent,
      payload: WasapiAudioChunkPayload
    ) => {
      listener(payload);
    };
    ipcRenderer.on('elm:wasapi-loopback-chunk', wrapped);
    return () => {
      ipcRenderer.removeListener('elm:wasapi-loopback-chunk', wrapped);
    };
  },
});

contextBridge.exposeInMainWorld('elmDesktop', bridge);
