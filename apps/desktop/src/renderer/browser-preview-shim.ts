import {
  DEFAULT_HOST_MEDIA_SELECTION,
  INVITE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  normalizeFriendCode,
  type AccountProfile,
  type InviteSummary,
  type PresenceStateSnapshot,
} from '@elm/protocol';
import type {
  DesktopRuntimeMetadata,
  DeviceSetupState,
  ElmDesktopBridge,
  HostOverlayUiState,
  TaskbarDwmTelemetry,
  VolatileSessionUiState,
} from '../shared/bridge';
import type { CaptureProtectionState } from '../shared/capture-protection';
import {
  DEFAULT_FLOATING_PANEL_APPEARANCE,
  sanitizeFloatingPanelAppearance,
  type FloatingPanelAppearance,
} from '../shared/floating-panel';
import {
  removeRecentPeerEntry,
  renameRecentPeerEntry,
  sortRecentPeers,
  toggleFavoritePeerEntry,
  upsertRecentPeerContact,
  upsertSuccessfulPeerConnection,
  type RecentPeerEntry,
} from '../shared/recent-peers';
import type { ThemeMode, ThemeStateSnapshot } from '../shared/theme';

/**
 * Installs an interactive browser-only preview bridge when running the Vite
 * renderer outside Electron (no-op in Electron where preload sets `window.elmDesktop`).
 */
export function installBrowserPreviewBridgeIfNeeded(): void {
  if (typeof window === 'undefined' || window.elmDesktop) {
    return;
  }

  const nowIso = new Date().toISOString();
  let account: AccountProfile = {
    accountId: 'preview-local-account',
    provider: 'test-double',
    providerSubject: 'preview-local',
    displayName: 'Local Preview PC',
    friendCode: 'ELM-3GNF-UMZC',
    createdAt: nowIso,
  };

  let online = true;
  let outgoingInvite: InviteSummary | null = null;
  let recentExpiredOutgoingInvite: InviteSummary | null = null;
  let recentPeers: RecentPeerEntry[] = sortRecentPeers([
    {
      friendCode: 'ELM-A1B2-C3D4',
      alias: '',
      peerName: 'Friend A',
      email: 'friend.a@example.com',
      phone: '+1 555-0101',
      favorite: true,
      lastConnectedAt: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      friendCode: 'ELM-E5F6-G7H8',
      alias: '',
      peerName: 'Friend B',
      phone: '+1 555-0199',
      favorite: false,
      lastConnectedAt: new Date(Date.now() - 120_000).toISOString(),
    },
    {
      friendCode: 'ELM-J9K2-M4N6',
      alias: 'Friend C',
      favorite: false,
      lastConnectedAt: new Date(Date.now() - 180_000).toISOString(),
    },
  ]);

  let themeState: ThemeStateSnapshot = {
    mode: 'dark',
    source: 'system_default',
    systemPrefersDark: true,
    updatedAt: nowIso,
  };

  const buildSnapshot = (): PresenceStateSnapshot => {
    if (
      outgoingInvite &&
      Date.now() >= Date.parse(outgoingInvite.expiresAt) &&
      outgoingInvite.status === 'pending'
    ) {
      recentExpiredOutgoingInvite = {
        ...outgoingInvite,
        status: 'expired',
        resolvedAt: new Date().toISOString(),
      };
      outgoingInvite = null;
    }
    return {
      online,
      account,
      incomingInvites: [],
      outgoingInvite,
      recentExpiredOutgoingInvite,
      activeSession: null,
    };
  };

  let localProfileState = {
    name: account.displayName,
    email: '',
    phone: '',
    shareEmailWithPeers: false,
    sharePhoneWithPeers: false,
    updatedAt: nowIso,
  };

  const setupState = (): DeviceSetupState => ({
    profileCompleted: true,
    localProfile: localProfileState,
    registrationStatus: 'registered',
    registrationMessage: null,
    registeredAccount: account,
  });

  const dummyTelemetry: TaskbarDwmTelemetry = {
    hwndHex: '0x00000000',
    isMinimized: false,
    win32IsIconic: false,
    win32IsVisible: true,
    skipTaskbarApplied: false,
    wsExAppWindow: true,
    wsExToolWindow: false,
    dwmAttributes: {
      forceIconicRepresentation: '0x00000000',
      hasIconicBitmap: '0x00000000',
      disallowPeek: '0x00000000',
      excludedFromPeek: '0x00000000',
      invalidateIconicBitmaps: '0x00000000',
    },
    iconicThumbnail: {
      callbackCount: 0,
      lastHResult: '0x00000000',
      lastWidth: 200,
      lastHeight: 120,
    },
    livePreview: {
      callbackCount: 0,
      lastHResult: '0x00000000',
    },
    transitions: [],
  };

  const volatileState: VolatileSessionUiState = {
    session: null,
    currentAccount: account,
    connectionState: 'closed',
    dataChannelState: 'closed',
    messagePreviewsEnabled: false,
    messages: [],
    imageAttachmentsByMessageId: {},
    hostMediaState: null,
  };

  let previewAppearance: FloatingPanelAppearance = {
    ...DEFAULT_FLOATING_PANEL_APPEARANCE,
  };
  let previewCaptureProtection: CaptureProtectionState = {
    enabled: true,
    toggleAllowed: false,
    windows: {
      main: true,
      hostToolbar: false,
      chat: false,
      sourcePicker: false,
      settings: false,
    },
  };
  const previewOverlayState: HostOverlayUiState = {
    sessionActive: false,
    sessionId: null,
    peerDisplayName: '',
    connectionState: 'closed',
    iceConnectionState: 'new',
    dataChannelState: 'closed',
    hostMediaState: null,
    hostMicMutedLocally: false,
    peerMicActive: false,
    peerMicMutedLocally: false,
    peerMicRequestPending: false,
    isStartingShare: false,
    isStartingMic: false,
    isStartingDeviceSound: false,
    shareableSources: [],
    selectedSourceId: null,
    playWasapiTestTone: false,
    chatOpen: false,
    hasUnreadChat: false,
    sourcePickerOpen: false,
    settingsOpen: false,
    appearance: previewAppearance,
    captureProtection: previewCaptureProtection,
  };

  const metadata: DesktopRuntimeMetadata = {
    appName: 'Elm-AnyDesk',
    appVersion: '0.5.0',
    electronVersion: 'browser-preview',
    chromeVersion: navigator.userAgent,
    nodeVersion: 'browser',
    osRelease: 'Browser Preview',
    protocolVersion: PROTOCOL_VERSION,
    platform: 'win32',
    windowRole: 'main',
    devModeEnabled: false,
    phase: 'Phase 5 — Windows Installer, Cloudflare Staging & Pilot Verification',
    defaultMediaSelection: DEFAULT_HOST_MEDIA_SELECTION,
    initialSessionState: 'idle',
    securityPosture: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      narrowPreloadBridge: true,
    },
    apiBaseUrl: 'browser-preview',
  };

  const themeListeners = new Set<(state: ThemeStateSnapshot) => void>();

  const bridge: ElmDesktopBridge = {
    getRuntimeMetadata: async () => metadata,
    openSeparateChatWindow: async () => ({ opened: false }),
    openPresentationView: async () => ({ opened: false }),
    copyTextToClipboard: async (text) => {
      try {
        await navigator.clipboard?.writeText(text);
      } catch {
        // Clipboard API may be restricted in non-focused contexts
      }
      return { copied: true };
    },
    getDeviceSetupState: async () => ({
      ok: true,
      status: 200,
      data: setupState(),
    }),
    saveLocalProfile: async (input) => {
      const cleanedName = input.name.trim() || account.displayName;
      account = { ...account, displayName: cleanedName };
      localProfileState = {
        name: cleanedName,
        email: String(input.email ?? '').trim().slice(0, 120),
        phone: String(input.phone ?? '').trim().slice(0, 40),
        shareEmailWithPeers:
          input.shareEmailWithPeers !== undefined
            ? Boolean(input.shareEmailWithPeers)
            : localProfileState.shareEmailWithPeers,
        sharePhoneWithPeers:
          input.sharePhoneWithPeers !== undefined
            ? Boolean(input.sharePhoneWithPeers)
            : localProfileState.sharePhoneWithPeers,
        updatedAt: new Date().toISOString(),
      };
      return { ok: true, status: 200, data: setupState() };
    },
    retryDeviceRegistration: async () => ({
      ok: true,
      status: 200,
      data: setupState(),
    }),
    getStoredAuthSession: async () => ({
      ok: true,
      status: 200,
      data: { account, snapshot: buildSnapshot() },
    }),
    updateLocalDisplayName: async (displayName) => {
      account = { ...account, displayName: displayName.trim() || account.displayName };
      return { ok: true, status: 200, data: { account, snapshot: buildSnapshot() } };
    },
    startBrowserOAuthSignIn: async () => ({
      ok: true,
      status: 200,
      data: { authUrlOpened: false, message: 'Preview mode' },
    }),
    signInWithTestDouble: async () => ({
      ok: true,
      status: 200,
      data: { account, snapshot: buildSnapshot() },
    }),
    switchActivePersona: async () => ({
      ok: true,
      status: 200,
      data: { account, snapshot: buildSnapshot() },
    }),
    signOut: async () => ({ signedOut: true }),
    getPresenceSnapshot: async () => ({
      ok: true,
      status: 200,
      data: { snapshot: buildSnapshot() },
    }),
    getPresenceRuntimeStatus: async () => ({
      connectionState: online ? 'online' : 'offline',
      serverConfirmedOnline: online,
      lastConfirmedAt: online ? new Date().toISOString() : null,
      consecutiveFailures: 0,
      snapshot: buildSnapshot(),
    }),
    triggerPresenceReconnect: async () => {
      online = true;
      return {
        connectionState: 'online',
        serverConfirmedOnline: true,
        lastConfirmedAt: new Date().toISOString(),
        consecutiveFailures: 0,
        snapshot: buildSnapshot(),
      };
    },
    onPresenceStatusUpdated: () => () => {},
    setPresenceOnline: async (nextOnline) => {
      online = nextOnline;
      if (!online) {
        outgoingInvite = null;
      }
      return { ok: true, status: 200, data: { snapshot: buildSnapshot(), receipt: null } };
    },
    sendFriendCodeInvite: async (input) => {
      const code = normalizeFriendCode(
        typeof input === 'string' ? input : input.friendCode
      );
      if (code === 'ELM-E5F6-G7H8') {
        return {
          ok: false,
          status: 409,
          errorCode: 'TARGET_OFFLINE',
          errorMessage: 'Target device is offline in browser preview.',
        };
      }
      const createdMs = Date.now();
      const inv: InviteSummary = {
        inviteId: `preview-inv-${createdMs}`,
        requesterAccountId: account.accountId,
        requesterFriendCode: account.friendCode,
        requesterDisplayName: account.displayName,
        targetAccountId: `target-${code}`,
        targetFriendCode: code,
        targetDisplayName: code,
        intent: typeof input === 'string' ? 'connect' : input.intent ?? 'connect',
        status: 'pending',
        createdAt: new Date(createdMs).toISOString(),
        expiresAt: new Date(createdMs + INVITE_TIMEOUT_MS).toISOString(),
        resolvedAt: null,
      };
      outgoingInvite = inv;
      recentExpiredOutgoingInvite = null;
      return { ok: true, status: 201, data: { invite: inv, snapshot: buildSnapshot() } };
    },
    cancelOutgoingInvite: async () => {
      if (!outgoingInvite) {
        return {
          ok: false,
          status: 404,
          errorCode: 'INVITE_NOT_FOUND',
          errorMessage: 'No pending invite.',
        };
      }
      const cancelled: InviteSummary = {
        ...outgoingInvite,
        status: 'cancelled',
        resolvedAt: new Date().toISOString(),
      };
      outgoingInvite = null;
      return {
        ok: true,
        status: 200,
        data: { invite: cancelled, snapshot: buildSnapshot() },
      };
    },
    lookupDevicePresence: async (codes) => {
      const statuses: Record<string, boolean> = {};
      for (const code of codes) {
        statuses[code] = code !== 'ELM-E5F6-G7H8';
      }
      return { ok: true, status: 200, data: { statuses } };
    },
    getRecentPeers: async () => recentPeers,
    recordConnectedPeer: async (params) => {
      recentPeers = upsertSuccessfulPeerConnection(recentPeers, params);
      return recentPeers;
    },
    updateRecentPeerContact: async (params) => {
      recentPeers = upsertRecentPeerContact(recentPeers, params);
      return recentPeers;
    },
    toggleFavoritePeer: async (code) => {
      recentPeers = toggleFavoritePeerEntry(recentPeers, code);
      return recentPeers;
    },
    renameRecentPeer: async (params) => {
      recentPeers = renameRecentPeerEntry(recentPeers, params.friendCode, params.alias);
      return recentPeers;
    },
    removeRecentPeer: async (code) => {
      recentPeers = removeRecentPeerEntry(recentPeers, code);
      return recentPeers;
    },
    respondToInvite: async () => ({
      ok: false,
      status: 404,
      errorCode: 'INVITE_NOT_FOUND',
      errorMessage: 'No incoming invite in browser preview.',
    }),
    disconnectActiveSession: async () => ({
      ok: false,
      status: 404,
      errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
      errorMessage: 'No active session.',
    }),
    recordSessionHeartbeat: async () => ({
      ok: false,
      status: 404,
      errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
      errorMessage: 'No active session.',
    }),
    checkSessionLiveness: async () => ({
      ok: false,
      status: 404,
      errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
      errorMessage: 'No active session.',
    }),
    sendSessionSignal: async () => ({
      ok: false,
      status: 404,
      errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
      errorMessage: 'No active session.',
    }),
    pollSessionSignals: async () => ({
      ok: false,
      status: 404,
      errorCode: 'UNAUTHORIZED_SESSION_PARTICIPANT',
      errorMessage: 'No active session.',
    }),
    getVolatileSessionUiState: async () => volatileState,
    syncVolatileSessionUiState: async () => volatileState,
    sendChatFromChatWindow: async () => ({ queued: false }),
    requestHostStopSharingFromChatWindow: async () => ({ requested: false }),
    onVolatileSessionUiStateUpdated: () => () => {},
    onChatWindowOutboundSend: () => () => {},
    onHostStopSharingRequest: () => () => {},
    getHostOverlayState: async () => previewOverlayState,
    syncHostOverlayState: async () => previewOverlayState,
    onHostOverlayStateUpdated: () => () => {},
    dispatchHostToolbarAction: async () => ({ dispatched: false }),
    onHostToolbarAction: () => () => {},
    toggleHostToolbarWindow: async () => ({ open: false }),
    toggleHostSourcePickerPopup: async () => ({ open: false }),
    toggleHostSettingsPopup: async () => ({ open: false }),
    closeSeparateChatWindow: async () => ({ closed: false }),
    restoreAndFocusMainWindow: async () => {},
    getFloatingAppearance: async () => previewAppearance,
    setFloatingAppearance: async (patch) => {
      previewAppearance = sanitizeFloatingPanelAppearance({
        ...previewAppearance,
        ...patch,
      });
      return previewAppearance;
    },
    onFloatingAppearanceUpdated: () => () => {},
    getCaptureProtectionState: async () => previewCaptureProtection,
    setCaptureProtectionTestEnabled: async () => previewCaptureProtection,
    onCaptureProtectionUpdated: () => () => {},
    getThemeState: async () => themeState,
    setThemeMode: async (mode: ThemeMode) => {
      themeState = {
        ...themeState,
        mode,
        source: 'user_persisted',
        updatedAt: new Date().toISOString(),
      };
      for (const listener of themeListeners) listener(themeState);
      return themeState;
    },
    resetThemeToSystemDefault: async () => themeState,
    reloadThemeFromDisk: async () => themeState,
    onThemeUpdated: (listener) => {
      themeListeners.add(listener);
      return () => themeListeners.delete(listener);
    },
    minimizeWindow: async () => {},
    toggleMaximizeWindow: async () => ({ maximized: false }),
    closeWindow: async () => {},
    isWindowMaximized: async () => false,
    onWindowMaximizedChanged: () => () => {},
    getTaskbarDwmTelemetry: async () => dummyTelemetry,
    minimizeMainWindow: async () => dummyTelemetry,
    restoreMainWindow: async () => dummyTelemetry,
    runTaskbarMinimizeRestoreCycle: async () => dummyTelemetry,
    verifyStaticThumbnailAndPeek: async () => dummyTelemetry,
    listShareableSources: async () => [],
    selectShareableSource: async (sourceId) => ({
      selectedSourceId: sourceId,
      sourceName: 'Browser Preview',
    }),
    probeWasapiLoopback: async () => ({
      ok: false,
      endpointId: '',
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 32,
      error: 'Desktop only',
    }),
    startWasapiLoopback: async () => ({
      ok: false,
      endpointId: '',
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 32,
      error: 'Desktop only',
    }),
    stopWasapiLoopback: async () => ({ stopped: true }),
    onWasapiAudioChunk: () => () => {},
  };

  window.elmDesktop = bridge;
}
