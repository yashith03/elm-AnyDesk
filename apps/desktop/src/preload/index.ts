import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { HostMediaSelection } from '@elm/protocol';
import type {
  DesktopRuntimeMetadata,
  ElmDesktopBridge,
  ShareableSourceDescriptor,
  TaskbarDwmTelemetry,
  WasapiAudioChunkPayload,
  WasapiEndpointProbeResult,
} from '../shared/bridge';

const bridge: ElmDesktopBridge = Object.freeze({
  getRuntimeMetadata: (): Promise<DesktopRuntimeMetadata> =>
    ipcRenderer.invoke('elm:get-runtime-metadata'),
  openSeparateChatWindow: (): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke('elm:open-separate-chat-window'),
  copyTextToClipboard: (text: string): Promise<{ copied: boolean }> =>
    ipcRenderer.invoke('elm:copy-text-to-clipboard', text),

  // Phase 2: Authentication, Friend Codes, Presence & Invites
  getStoredAuthSession: () => ipcRenderer.invoke('elm:auth-get-stored-session'),
  startBrowserOAuthSignIn: () =>
    ipcRenderer.invoke('elm:auth-start-browser-oauth'),
  signInWithTestDouble: (personaKey: string) =>
    ipcRenderer.invoke('elm:auth-signin-test-double', personaKey),
  switchActivePersona: (personaKey: string) =>
    ipcRenderer.invoke('elm:auth-switch-persona', personaKey),
  signOut: () => ipcRenderer.invoke('elm:auth-sign-out'),
  getPresenceSnapshot: () => ipcRenderer.invoke('elm:presence-get-snapshot'),
  setPresenceOnline: (online: boolean) =>
    ipcRenderer.invoke('elm:presence-set-online', online),
  sendFriendCodeInvite: (friendCode: string) =>
    ipcRenderer.invoke('elm:invites-send', friendCode),
  respondToInvite: (params: {
    inviteId: string;
    action: 'accept' | 'decline';
    mediaSelection?: HostMediaSelection;
  }) => ipcRenderer.invoke('elm:invites-respond', params),
  disconnectActiveSession: (sessionId?: string) =>
    ipcRenderer.invoke('elm:sessions-disconnect', sessionId),

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
