import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  nativeTheme,
  powerMonitor,
  session,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_HOST_MEDIA_SELECTION,
  PROTOCOL_VERSION,
  type HostMediaSelection,
  type InviteIntent,
  type MediaSourceKind,
  type SessionTerminationReason,
  type WebRtcSignalPayload,
} from '@elm/protocol';
import type {
  DesktopRuntimeMetadata,
  DesktopWindowRole,
  PresenceRuntimeStatus,
  ShareableSourceDescriptor,
  TaskbarDwmTelemetry,
  VolatileSessionUiState,
} from '../shared/bridge';
import {
  THEME_TOKENS,
  computeWcagContrastRatio,
  type ThemeMode,
  type ThemeStateSnapshot,
} from '../shared/theme';
import { DesktopAuthAndInviteController } from './auth-invite-client';
import { Win11TaskbarDwmController } from './win11-dwm';
import { WasapiLoopbackManager } from './wasapi-loopback';

// Allow isolated test runs to override Electron userData before app.whenReady()
// so automated or side-by-side multi-client tests never touch the user's real profile.
if (
  typeof process.env.ELM_USER_DATA_DIR === 'string' &&
  process.env.ELM_USER_DATA_DIR.trim().length > 0
) {
  const customUserData = path.resolve(process.env.ELM_USER_DATA_DIR.trim());
  fs.mkdirSync(customUserData, { recursive: true });
  app.setPath('userData', customUserData);
}

let mainWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
let taskbarDwmController: Win11TaskbarDwmController | null = null;
let authInviteController: DesktopAuthAndInviteController | null = null;
const wasapiManager = new WasapiLoopbackManager();

let explicitlySelectedSourceId: string | null = null;

/**
 * In-memory volatile session and chat UI state shared between the Main Window
 * and Separate Chat Window. Never written to disk, D1, SQLite, or localStorage,
 * and wiped immediately when a session disconnects or the app closes.
 */
let volatileUiState: VolatileSessionUiState = {
  session: null,
  currentAccount: null,
  connectionState: 'new',
  dataChannelState: 'closed',
  messagePreviewsEnabled: false,
  messages: [],
  hostMediaState: null,
};

function resetVolatileUiState(): void {
  volatileUiState = {
    session: null,
    currentAccount: volatileUiState.currentAccount,
    connectionState: 'closed',
    dataChannelState: 'closed',
    messagePreviewsEnabled: false,
    messages: [],
    hostMediaState: null,
  };
  broadcastVolatileUiState();
}

function broadcastVolatileUiState(): void {
  for (const win of [mainWindow, chatWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('elm:volatile-ui-updated', volatileUiState);
    }
  }
}

/**
 * Centralized Theme State Manager (Single Source of Truth across Main & Chat Windows).
 * Persists user theme choice across restarts in userData/elm-theme-preference.json.
 * On first launch (when no file exists), uses the OS system preference via Electron nativeTheme.
 */
let currentThemeState: ThemeStateSnapshot | null = null;

function getThemePreferenceFilePath(): string {
  return path.join(app.getPath('userData'), 'elm-theme-preference.json');
}

function getSystemPreferredThemeMode(): ThemeMode {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function applyThemeToWindows(state: ThemeStateSnapshot): void {
  const bg = THEME_TOKENS[state.mode].bgCanvas;
  for (const win of [mainWindow, chatWindow]) {
    if (win && !win.isDestroyed()) {
      try {
        win.setBackgroundColor(bg);
      } catch {
        // Ignore if window is closing
      }
      win.webContents.send('elm:theme-updated', state);
    }
  }
}

function loadThemeStateFromDisk(): ThemeStateSnapshot {
  const filePath = getThemePreferenceFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
        mode?: string;
        updatedAt?: string;
      };
      if (raw.mode === 'light' || raw.mode === 'dark') {
        nativeTheme.themeSource = raw.mode;
        currentThemeState = {
          mode: raw.mode,
          source: 'user_persisted',
          systemPrefersDark: nativeTheme.shouldUseDarkColors,
          updatedAt: raw.updatedAt || new Date().toISOString(),
        };
        applyThemeToWindows(currentThemeState);
        return currentThemeState;
      }
    }
  } catch {
    // Fall back to system preference if file is unreadable
  }

  nativeTheme.themeSource = 'system';
  const systemMode = getSystemPreferredThemeMode();
  currentThemeState = {
    mode: systemMode,
    source: 'system_default',
    systemPrefersDark: nativeTheme.shouldUseDarkColors,
    updatedAt: new Date().toISOString(),
  };
  applyThemeToWindows(currentThemeState);
  return currentThemeState;
}

function getOrLoadThemeState(): ThemeStateSnapshot {
  if (!currentThemeState) {
    return loadThemeStateFromDisk();
  }
  return currentThemeState;
}

function setPersistedThemeMode(mode: ThemeMode): ThemeStateSnapshot {
  const validMode: ThemeMode = mode === 'light' ? 'light' : 'dark';
  const updatedAt = new Date().toISOString();
  const filePath = getThemePreferenceFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        mode: validMode,
        source: 'user_persisted',
        updatedAt,
      },
      null,
      2
    ),
    'utf8'
  );
  nativeTheme.themeSource = validMode;
  currentThemeState = {
    mode: validMode,
    source: 'user_persisted',
    systemPrefersDark: nativeTheme.shouldUseDarkColors,
    updatedAt,
  };
  applyThemeToWindows(currentThemeState);
  return currentThemeState;
}

function resetThemeStateToSystemDefault(): ThemeStateSnapshot {
  const filePath = getThemePreferenceFilePath();
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore
  }
  nativeTheme.themeSource = 'system';
  const systemMode = getSystemPreferredThemeMode();
  currentThemeState = {
    mode: systemMode,
    source: 'system_default',
    systemPrefersDark: nativeTheme.shouldUseDarkColors,
    updatedAt: new Date().toISOString(),
  };
  applyThemeToWindows(currentThemeState);
  return currentThemeState;
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.elm.anydesk');
}

if (process.argv.includes('--run-prototype-suite')) {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}

function getWindowIconPath(): string | undefined {
  const candidate = path.join(__dirname, '../assets/elm-icon.ico');
  return fs.existsSync(candidate) ? candidate : undefined;
}

const windowRoles = new WeakMap<BrowserWindow, DesktopWindowRole>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function broadcastPresenceStatus(status: PresenceRuntimeStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('elm:presence-status-updated', status);
  }
}

function getAuthController(): DesktopAuthAndInviteController {
  if (!authInviteController) {
    authInviteController = new DesktopAuthAndInviteController(undefined, {
      onPresenceStatusChanged: broadcastPresenceStatus,
    });
  }
  return authInviteController;
}

function createSecureWebPreferences() {
  return {
    preload: path.join(__dirname, '../preload/index.cjs'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
    backgroundThrottling: false,
  } as const;
}

function attachWindowSecurityGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return mainWindow;
  }

  let customBounds: { x: number; y: number; width: number; height: number } | null = null;
  if (typeof process.env.ELM_WINDOW_BOUNDS === 'string') {
    const parts = process.env.ELM_WINDOW_BOUNDS.split(',').map((n) => Number(n.trim()));
    if (
      parts.length === 4 &&
      parts.every((n) => Number.isFinite(n)) &&
      parts[2] >= 640 &&
      parts[3] >= 480
    ) {
      customBounds = {
        x: Math.round(parts[0]),
        y: Math.round(parts[1]),
        width: Math.round(parts[2]),
        height: Math.round(parts[3]),
      };
    }
  }
  const titleSuffix =
    typeof process.env.ELM_WINDOW_TITLE_SUFFIX === 'string' &&
    process.env.ELM_WINDOW_TITLE_SUFFIX.trim().length > 0
      ? ` ${process.env.ELM_WINDOW_TITLE_SUFFIX.trim()}`
      : '';

  const win = new BrowserWindow({
    ...(customBounds ? { x: customBounds.x, y: customBounds.y } : {}),
    width: customBounds?.width ?? 1140,
    height: customBounds?.height ?? 860,
    minWidth: customBounds ? Math.min(640, customBounds.width) : 900,
    minHeight: customBounds ? Math.min(480, customBounds.height) : 640,
    title: `Elm-AnyDesk — Consent-Based 1:1 Screen Share${titleSuffix}`,
    icon: getWindowIconPath(),
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    backgroundColor: THEME_TOKENS[getOrLoadThemeState().mode].bgCanvas,
    webPreferences: createSecureWebPreferences(),
  });

  windowRoles.set(win, 'main');
  attachWindowSecurityGuards(win);

  taskbarDwmController = new Win11TaskbarDwmController(win);
  taskbarDwmController.initialize();

  const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
  await win.loadFile(rendererHtmlPath, { query: { role: 'main' } });

  win.on('maximize', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('elm:window-maximized-changed', true);
    }
  });
  win.on('unmaximize', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('elm:window-maximized-changed', false);
    }
  });

  win.on('closed', () => {
    wasapiManager.stopCapture();
    resetVolatileUiState();
    mainWindow = null;
    taskbarDwmController = null;
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.close();
    }
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.close();
    }
  });

  return win;
}

async function createOrFocusChatWindow(): Promise<BrowserWindow> {
  if (chatWindow && !chatWindow.isDestroyed()) {
    if (chatWindow.isMinimized()) {
      chatWindow.restore();
    }
    chatWindow.focus();
    return chatWindow;
  }

  const win = new BrowserWindow({
    width: 480,
    height: 660,
    minWidth: 380,
    minHeight: 480,
    title: 'Elm-AnyDesk — Private 1:1 Session Chat (Volatile DataChannel)',
    icon: getWindowIconPath(),
    autoHideMenuBar: true,
    backgroundColor: THEME_TOKENS[getOrLoadThemeState().mode].bgCanvas,
    webPreferences: createSecureWebPreferences(),
  });

  windowRoles.set(win, 'chat');
  attachWindowSecurityGuards(win);

  const chatDwm = new Win11TaskbarDwmController(win);
  chatDwm.initialize();

  const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
  await win.loadFile(rendererHtmlPath, { query: { role: 'chat' } });

  win.on('closed', () => {
    chatWindow = null;
  });

  chatWindow = win;
  return win;
}

let presentationWindow: BrowserWindow | null = null;

async function createOrFocusPresentationWindow(): Promise<BrowserWindow> {
  if (presentationWindow && !presentationWindow.isDestroyed()) {
    if (presentationWindow.isMinimized()) presentationWindow.restore();
    presentationWindow.focus();
    return presentationWindow;
  }

  const win = new BrowserWindow({
    width: 1120,
    height: 680,
    minWidth: 480,
    minHeight: 320,
    title: 'Elm-AnyDesk — Presentation View',
    autoHideMenuBar: true,
    backgroundColor: '#07080A',
    webPreferences: createSecureWebPreferences(),
  });

  windowRoles.set(win, 'presentation');
  attachWindowSecurityGuards(win);

  const presentationDwm = new Win11TaskbarDwmController(win);
  presentationDwm.initialize();

  const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
  await win.loadFile(rendererHtmlPath, { query: { role: 'presentation' } });

  win.on('closed', () => {
    presentationWindow = null;
  });

  presentationWindow = win;
  return win;
}

let lastDisplayMediaRequestFlags: {
  videoRequested: boolean;
  audioRequested: boolean;
} | null = null;

function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        lastDisplayMediaRequestFlags = {
          videoRequested: request.videoRequested,
          audioRequested: request.audioRequested,
        };
        if (!request.videoRequested) {
          if (request.audioRequested) {
            callback({ audio: 'loopback' } as unknown as Parameters<
              typeof callback
            >[0]);
            return;
          }
          callback({});
          return;
        }

        if (!explicitlySelectedSourceId) {
          callback({});
          return;
        }

        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
        });
        const chosen = sources.find((s) => s.id === explicitlySelectedSourceId);
        if (!chosen) {
          callback({});
          return;
        }

        if (request.audioRequested) {
          callback({ video: chosen, audio: 'loopback' });
        } else {
          callback({ video: chosen });
        }
      } catch {
        callback({});
      }
    }
  );
}

function registerIpcHandlers(): void {
  ipcMain.handle('elm:get-runtime-metadata', (event): DesktopRuntimeMetadata => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const role: DesktopWindowRole =
      (senderWindow && windowRoles.get(senderWindow)) || 'main';
    const controller = getAuthController();

    return {
      appName: app.getName(),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      osRelease: `${os.type()} ${os.release()} (${os.arch()})`,
      protocolVersion: PROTOCOL_VERSION,
      platform: process.platform,
      windowRole: role,
      devModeEnabled:
        process.argv.includes('--dev-mode') ||
        process.argv.includes('--run-prototype-suite') ||
        process.env.ELM_DEV_MODE === '1',
      phase:
        'Phase 5 — Windows Installer, Cloudflare Staging & Pilot Verification',
      defaultMediaSelection: DEFAULT_HOST_MEDIA_SELECTION,
      initialSessionState: 'idle',
      securityPosture: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        narrowPreloadBridge: true,
      },
      apiBaseUrl: controller.apiBaseUrl,
    };
  });

  ipcMain.handle('elm:open-separate-chat-window', async () => {
    const cWin = await createOrFocusChatWindow();
    const mainHwndHex =
      mainWindow && !mainWindow.isDestroyed()
        ? `0x${mainWindow.getNativeWindowHandle().toString('hex')}`
        : '';
    const chatHwndHex = !cWin.isDestroyed()
      ? `0x${cWin.getNativeWindowHandle().toString('hex')}`
      : '';
    return {
      opened: true,
      mainHwndHex,
      chatHwndHex,
      distinctHwnds:
        Boolean(mainHwndHex && chatHwndHex) && mainHwndHex !== chatHwndHex,
    };
  });

  ipcMain.handle('elm:open-presentation-view', async () => {
    const pWin = await createOrFocusPresentationWindow();
    const mainHwndHex =
      mainWindow && !mainWindow.isDestroyed()
        ? `0x${mainWindow.getNativeWindowHandle().toString('hex')}`
        : '';
    const presentationHwndHex = !pWin.isDestroyed()
      ? `0x${pWin.getNativeWindowHandle().toString('hex')}`
      : '';
    return {
      opened: true,
      mainHwndHex,
      presentationHwndHex,
      distinctHwnds:
        Boolean(mainHwndHex && presentationHwndHex) &&
        mainHwndHex !== presentationHwndHex,
    };
  });

  ipcMain.handle('elm:copy-text-to-clipboard', (_event, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return { copied: true };
  });

  // Device Setup & Anonymous Registration
  ipcMain.handle('elm:device-get-setup-state', () => {
    return getAuthController().getDeviceSetupState();
  });

  ipcMain.handle(
    'elm:device-save-local-profile',
    (
      _event,
      input: {
        name: string;
        email?: string;
        phone?: string;
        shareEmailWithPeers?: boolean;
        sharePhoneWithPeers?: boolean;
      }
    ) => {
      return getAuthController().saveLocalProfile(input);
    }
  );

  ipcMain.handle('elm:device-retry-registration', () => {
    return getAuthController().retryDeviceRegistration();
  });

  // Phase 2: Auth, Permanent Friend Code, Presence & Invites
  ipcMain.handle('elm:auth-get-stored-session', () => {
    return getAuthController().getStoredAuthSession();
  });

  ipcMain.handle(
    'elm:update-local-display-name',
    (_event, displayName: string) => {
      return getAuthController().updateLocalDisplayName(
        String(displayName ?? '')
      );
    }
  );

  ipcMain.handle('elm:auth-start-browser-oauth', async () => {
    return getAuthController().startBrowserOAuthSignIn();
  });

  ipcMain.handle('elm:auth-signin-test-double', (_event, personaKey: string) => {
    return getAuthController().signInWithTestDouble(String(personaKey ?? ''));
  });

  ipcMain.handle('elm:auth-switch-persona', (_event, personaKey: string) => {
    return getAuthController().switchActivePersona(String(personaKey ?? ''));
  });

  ipcMain.handle('elm:auth-sign-out', () => {
    resetVolatileUiState();
    return getAuthController().signOut();
  });

  ipcMain.handle('elm:presence-get-snapshot', () => {
    return getAuthController().getPresenceSnapshot();
  });

  ipcMain.handle('elm:presence-get-runtime-status', () => {
    return getAuthController().getPresenceRuntimeStatus();
  });

  ipcMain.handle('elm:presence-trigger-reconnect', () => {
    return getAuthController().triggerPresenceReconnect();
  });

  ipcMain.handle(
    'elm:presence-set-online',
    (
      _event,
      online: boolean,
      options?: {
        personaKey?: string;
        reason?: SessionTerminationReason;
        subReason?: string;
      }
    ) => {
      if (!online) {
        wasapiManager.stopCapture();
        resetVolatileUiState();
      }
      return getAuthController().setPresenceOnline(Boolean(online), options);
    }
  );

  ipcMain.handle(
    'elm:invites-send',
    (
      _event,
      input:
        | string
        | {
            friendCode: string;
            intent?: InviteIntent;
            hostMediaSelection?: HostMediaSelection;
          }
    ) => {
      return getAuthController().sendFriendCodeInvite(input);
    }
  );

  ipcMain.handle('elm:invites-cancel', (_event, inviteId: string) => {
    return getAuthController().cancelOutgoingInvite(String(inviteId ?? ''));
  });

  ipcMain.handle(
    'elm:presence-lookup',
    (_event, friendCodes: string[]) => {
      return getAuthController().lookupDevicePresence(
        Array.isArray(friendCodes) ? friendCodes.map(String) : []
      );
    }
  );

  ipcMain.handle('elm:recent-peers-get', () => {
    return getAuthController().getRecentPeers();
  });

  ipcMain.handle(
    'elm:recent-peers-record',
    (
      _event,
      params: { friendCode: string; defaultAlias?: string; connectedAt?: string }
    ) => {
      return getAuthController().recordConnectedPeer(params);
    }
  );

  ipcMain.handle(
    'elm:recent-peers-update-contact',
    (
      _event,
      params: {
        friendCode: string;
        peerName?: string;
        email?: string;
        phone?: string;
        connectedAt?: string;
      }
    ) => {
      return getAuthController().updateRecentPeerContact(params);
    }
  );

  ipcMain.handle(
    'elm:recent-peers-toggle-favorite',
    (_event, friendCode: string) => {
      return getAuthController().toggleFavoritePeer(String(friendCode ?? ''));
    }
  );

  ipcMain.handle(
    'elm:recent-peers-rename',
    (_event, params: { friendCode: string; alias: string }) => {
      return getAuthController().renameRecentPeer(params);
    }
  );

  ipcMain.handle('elm:recent-peers-remove', (_event, friendCode: string) => {
    return getAuthController().removeRecentPeer(String(friendCode ?? ''));
  });

  ipcMain.handle(
    'elm:invites-respond',
    (
      _event,
      params: {
        inviteId: string;
        action: 'accept' | 'decline';
        mediaSelection?: HostMediaSelection;
      }
    ) => {
      return getAuthController().respondToInvite(params);
    }
  );

  ipcMain.handle(
    'elm:sessions-disconnect',
    (
      _event,
      sessionIdOrOptions?:
        | string
        | {
            sessionId?: string;
            reason?: SessionTerminationReason;
            subReason?: string;
            callerAccountId?: string;
            detectionTimeMs?: number;
          }
    ) => {
      wasapiManager.stopCapture();
      resetVolatileUiState();
      return getAuthController().disconnectActiveSession(sessionIdOrOptions);
    }
  );

  ipcMain.handle(
    'elm:sessions-heartbeat',
    (
      _event,
      params: {
        sessionId: string;
        callerAccountId?: string;
        timestampMs?: number;
      }
    ) => {
      return getAuthController().recordSessionHeartbeat(params);
    }
  );

  ipcMain.handle(
    'elm:sessions-check-liveness',
    (
      _event,
      params: {
        sessionId: string;
        callerAccountId?: string;
        nowMs?: number;
        livenessTimeoutMs?: number;
      }
    ) => {
      const res = getAuthController().checkSessionLiveness(params);
      if (res.ok && res.data && !res.data.alive) {
        wasapiManager.stopCapture();
        resetVolatileUiState();
      }
      return res;
    }
  );

  // Phase 3: Approved Session WebRTC Signaling & Separate Chat Window Sync
  ipcMain.handle(
    'elm:sessions-send-signal',
    (
      _event,
      params: {
        sessionId: string;
        senderAccountId?: string;
        payload: WebRtcSignalPayload;
      }
    ) => {
      return getAuthController().sendSessionSignal(params);
    }
  );

  ipcMain.handle(
    'elm:sessions-poll-signals',
    (
      _event,
      params: {
        sessionId: string;
        receiverAccountId?: string;
        afterSeq: number;
      }
    ) => {
      return getAuthController().pollSessionSignals(params);
    }
  );

  ipcMain.handle('elm:volatile-ui-get', (): VolatileSessionUiState => {
    return volatileUiState;
  });

  ipcMain.handle(
    'elm:volatile-ui-sync',
    (
      _event,
      patch: Partial<VolatileSessionUiState>
    ): VolatileSessionUiState => {
      volatileUiState = {
        ...volatileUiState,
        ...patch,
      };
      broadcastVolatileUiState();
      return volatileUiState;
    }
  );

  ipcMain.handle(
    'elm:chat-window-outbound-send',
    (
      _event,
      params: { text: string; senderOverride?: 'host' | 'guest' }
    ): { queued: boolean } => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('elm:chat-window-outbound-event', params);
        return { queued: true };
      }
      return { queued: false };
    }
  );

  ipcMain.handle(
    'elm:chat-window-stop-sharing',
    (_event, target: MediaSourceKind | 'all'): { requested: boolean } => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('elm:host-stop-sharing-event', target);
        return { requested: true };
      }
      return { requested: false };
    }
  );

  // Centralized Theme State Handlers (Shared across Main & Chat Windows + Persisted to Disk)
  ipcMain.handle('elm:theme-get', (): ThemeStateSnapshot => {
    return getOrLoadThemeState();
  });

  ipcMain.handle(
    'elm:theme-set',
    (_event, mode: ThemeMode): ThemeStateSnapshot => {
      return setPersistedThemeMode(mode);
    }
  );

  ipcMain.handle('elm:theme-reset-system', (): ThemeStateSnapshot => {
    return resetThemeStateToSystemDefault();
  });

  ipcMain.handle('elm:theme-reload-disk', (): ThemeStateSnapshot => {
    return loadThemeStateFromDisk();
  });

  // Taskbar & DWM Telemetry + Prototype Controls
  ipcMain.handle(
    'elm:get-taskbar-dwm-telemetry',
    (): TaskbarDwmTelemetry => {
      if (!taskbarDwmController) {
        throw new Error('Main window DWM controller not initialized');
      }
      return taskbarDwmController.getTelemetry();
    }
  );

  ipcMain.handle(
    'elm:minimize-main-window',
    async (): Promise<TaskbarDwmTelemetry> => {
      if (!mainWindow || !taskbarDwmController) {
        throw new Error('Main window not initialized');
      }
      mainWindow.minimize();
      await sleep(160);
      return taskbarDwmController.getTelemetry();
    }
  );

  ipcMain.handle(
    'elm:restore-main-window',
    async (): Promise<TaskbarDwmTelemetry> => {
      if (!mainWindow || !taskbarDwmController) {
        throw new Error('Main window not initialized');
      }
      mainWindow.restore();
      mainWindow.focus();
      await sleep(180);
      return taskbarDwmController.getTelemetry();
    }
  );

  ipcMain.handle(
    'elm:run-taskbar-minimize-restore-cycle',
    async (): Promise<TaskbarDwmTelemetry> => {
      if (!mainWindow || !taskbarDwmController) {
        throw new Error('Main window not initialized');
      }
      taskbarDwmController.recordTransition('cycle_start_open_state');
      mainWindow.minimize();
      await sleep(220);
      taskbarDwmController.triggerIconicThumbnailVerification();
      await sleep(160);
      mainWindow.restore();
      mainWindow.focus();
      await sleep(200);
      return taskbarDwmController.getTelemetry();
    }
  );

  ipcMain.handle('elm:window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  });

  ipcMain.handle('elm:window-toggle-maximize', (): { maximized: boolean } => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { maximized: false };
    }
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return { maximized: mainWindow.isMaximized() };
  });

  ipcMain.handle('elm:window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  ipcMain.handle('elm:window-is-maximized', (): boolean => {
    return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized());
  });

  ipcMain.handle(
    'elm:verify-static-thumbnail-and-peek',
    async (): Promise<TaskbarDwmTelemetry> => {
      if (!taskbarDwmController) {
        throw new Error('Main window DWM controller not initialized');
      }
      return taskbarDwmController.triggerIconicThumbnailVerification();
    }
  );

  // Explicit Display / Window Source Enumeration (Never Webcam)
  ipcMain.handle(
    'elm:list-shareable-sources',
    async (): Promise<ShareableSourceDescriptor[]> => {
      const rawSources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 240, height: 135 },
        fetchWindowIcons: false,
      });

      return rawSources.map((source) => ({
        id: source.id,
        name: source.name,
        surfaceType: source.id.startsWith('screen:') ? 'display' : 'window',
        displayId: source.display_id || '',
        thumbnailDataUrl: source.thumbnail.toDataURL(),
      }));
    }
  );

  ipcMain.handle(
    'elm:select-shareable-source',
    async (_event, sourceId: string) => {
      const rawSources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 16, height: 16 },
      });
      const matched = rawSources.find((s) => s.id === sourceId);
      if (!matched) {
        throw new Error(`Selected source not found: ${sourceId}`);
      }
      explicitlySelectedSourceId = matched.id;
      return {
        selectedSourceId: matched.id,
        sourceName: matched.name,
      };
    }
  );

  // WASAPI Loopback Prototype Handlers
  ipcMain.handle('elm:probe-wasapi-loopback', async () => {
    return wasapiManager.probeEndpoint();
  });

  ipcMain.handle(
    'elm:start-wasapi-loopback',
    async (event, options: { playTestTone: boolean }) => {
      return wasapiManager.startCapture(event.sender, {
        playTestTone: Boolean(options?.playTestTone),
      });
    }
  );

  ipcMain.handle('elm:stop-wasapi-loopback', async () => {
    wasapiManager.stopCapture();
    return { stopped: true };
  });
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      if (permission === 'media') {
        callback(true);
        return;
      }
      callback(false);
    }
  );

  registerDisplayMediaHandler();
  registerIpcHandlers();

  nativeTheme.on('updated', () => {
    if (!currentThemeState || currentThemeState.source === 'system_default') {
      const nextState: ThemeStateSnapshot = {
        mode: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
        source: 'system_default',
        systemPrefersDark: nativeTheme.shouldUseDarkColors,
        updatedAt: new Date().toISOString(),
      };
      currentThemeState = nextState;
      applyThemeToWindows(nextState);
    }
  });

  powerMonitor.on('suspend', () => {
    wasapiManager.stopCapture();
    resetVolatileUiState();
    const ctrl = getAuthController();
    ctrl.pausePresenceForSuspend();
    void ctrl.disconnectActiveSession({
      reason: 'connection_lost',
      subReason: 'os_sleep_suspend',
    });
  });

  powerMonitor.on('resume', () => {
    // Re-establish presence only; never restore an ended screen-sharing session.
    void getAuthController().triggerPresenceReconnect();
  });

  mainWindow = await createMainWindow();

  const verifyLaunchArg = process.argv.find((a) =>
    a.startsWith('--verify-installed-launch=')
  );
  if (verifyLaunchArg) {
    const outPath = verifyLaunchArg.slice('--verify-installed-launch='.length);
    try {
      await sleep(250);
      const dwm = taskbarDwmController?.getTelemetry() ?? null;
      const wasapiProbe = await wasapiManager.probeEndpoint();
      let rendererReady = false;
      for (let i = 0; i < 30; i++) {
        rendererReady = Boolean(
          await mainWindow.webContents.executeJavaScript(
            `Boolean(document.querySelector('.top-bar h1'))`
          )
        );
        if (rendererReady) break;
        await sleep(100);
      }
      const iconPath = getWindowIconPath() ?? null;
      fs.writeFileSync(
        outPath,
        JSON.stringify(
          {
            ok: true,
            execPath: process.execPath,
            appPath: app.getAppPath(),
            iconPath,
            iconExists: Boolean(iconPath && fs.existsSync(iconPath)),
            rendererReady,
            dwmInitialized: Boolean(dwm && dwm.hwndHex),
            dwmAttributes: dwm?.dwmAttributes ?? null,
            wasapiHelperPath: path.join(
              __dirname,
              '../native/wasapi-loopback.exe'
            ),
            wasapiHelperExists: fs.existsSync(
              path.join(__dirname, '../native/wasapi-loopback.exe')
            ),
            wasapiProbeOk: Boolean(wasapiProbe),
            verifiedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        'utf8'
      );
    } finally {
      wasapiManager.stopCapture();
      app.exit(0);
    }
    return;
  }

  if (process.argv.includes('--run-prototype-suite')) {
    await runAutomatedPrototypeSuite(mainWindow);
  }
});

async function runAutomatedPrototypeSuite(win: BrowserWindow): Promise<void> {
  try {
    await sleep(300);
    if (!taskbarDwmController) {
      throw new Error('taskbarDwmController not initialized');
    }

    const openState = taskbarDwmController.getTelemetry();
    win.minimize();
    await sleep(250);
    const minimizedState =
      taskbarDwmController.triggerIconicThumbnailVerification();
    await sleep(150);
    win.restore();
    win.focus();
    await sleep(250);
    const restoredState = taskbarDwmController.getTelemetry();

    const mediaSuiteJson = await win.webContents.executeJavaScript(
      `
      (async () => {
        try {
          const withTimeout = (promise, ms, label) =>
            Promise.race([
              promise,
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)
              ),
            ]);

          const results = {};

          // Wait up to 2s for module bundle to attach window.runElmWebRtcVerificationMatrix
          for (let i = 0; i < 40; i++) {
            if (typeof window.runElmWebRtcVerificationMatrix === 'function') break;
            await new Promise((r) => setTimeout(r, 50));
          }

          // Desktop Auth, Permanent Friend Code & Invite UI Bridge Check
          const aliceLogin = await window.elmDesktop.signInWithTestDouble('alice');
          const aliceSecondLogin = await window.elmDesktop.signInWithTestDouble('alice');
          const bobLogin = await window.elmDesktop.signInWithTestDouble('bob');
          const inviteRes = await window.elmDesktop.sendFriendCodeInvite(
            aliceLogin.data.account.friendCode
          );
          await window.elmDesktop.switchActivePersona('alice');
          const acceptRes = await window.elmDesktop.respondToInvite({
            inviteId: inviteRes.data.invite.inviteId,
            action: 'accept',
            mediaSelection: {
              screenVideo: true,
              microphoneAudio: false,
              deviceAudio: false,
            },
          });
          await window.elmDesktop.disconnectActiveSession(
            acceptRes.data.session.sessionId
          );

          results.phase2AuthInviteBridge = {
            friendCodeReused:
              aliceLogin.data.account.friendCode ===
              aliceSecondLogin.data.account.friendCode,
            aliceFriendCode: aliceLogin.data.account.friendCode,
            bobFriendCode: bobLogin.data.account.friendCode,
            inviteStatusAfterAccept: acceptRes.data.invite.status,
            approvedSessionHostId: acceptRes.data.session.hostAccountId,
            approvedSessionGuestId: acceptRes.data.session.guestAccountId,
          };

          // Phase 3: Separate Chat Window & 5-Combination WebRTC Media + DataChannel Verification Matrix
          const volatileBefore = await window.elmDesktop.getVolatileSessionUiState();

          if (typeof window.runElmWebRtcVerificationMatrix === 'function') {
            results.phase3WebRtcMatrix = await withTimeout(
              window.runElmWebRtcVerificationMatrix(),
              35000,
              'runElmWebRtcVerificationMatrix'
            );
          } else {
            results.phase3WebRtcMatrixError = 'runElmWebRtcVerificationMatrix not found on window';
          }

          const volatileAfterDisconnect =
            await window.elmDesktop.getVolatileSessionUiState();

          results.phase3SeparateChatWindow = {
            messagePreviewsDisabledByDefault:
              volatileBefore.messagePreviewsEnabled === false,
            volatileMessagesAfterDisconnectCount:
              volatileAfterDisconnect.messages.length,
          };

          // Phase 4: Unified Idempotent Session Teardown, Liveness Detection, Minimize/Restore During Sharing & Non-Resumable Recovery Suite
          if (typeof window.runElmPhase4VerificationSuite === 'function') {
            results.phase4TeardownAndLivenessSuite = await withTimeout(
              window.runElmPhase4VerificationSuite(),
              45000,
              'runElmPhase4VerificationSuite'
            );
          } else {
            results.phase4TeardownAndLivenessSuiteError =
              'runElmPhase4VerificationSuite not found on window';
          }

          // Phase 5: STUN-Only Zero-Bill Policy, Restrictive Network Reporting & Authorized Meeting 3rd Attendee Presentation Isolation
          if (typeof window.runElmPhase5VerificationSuite === 'function') {
            results.phase5PilotReadinessSuite = await withTimeout(
              window.runElmPhase5VerificationSuite(),
              30000,
              'runElmPhase5VerificationSuite'
            );
          } else {
            results.phase5PilotReadinessSuiteError =
              'runElmPhase5VerificationSuite not found on window';
          }

          // Phase 6: Clean Modern Windows UI Redesign & Light/Dark Theme Verification
          const firstLaunchState = await window.elmDesktop.resetThemeToSystemDefault();
          await new Promise((r) => setTimeout(r, 80));

          const lightSet = await window.elmDesktop.setThemeMode('light');
          await new Promise((r) => setTimeout(r, 80));
          const lightReloadedAfterRestartSim = await window.elmDesktop.reloadThemeFromDisk();
          const lightRootDataTheme = document.documentElement.getAttribute('data-theme');
          const lightRootStyles = getComputedStyle(document.documentElement);
          const lightSurfaceVar = lightRootStyles.getPropertyValue('--surface-primary').trim();
          const lightTextVar = lightRootStyles.getPropertyValue('--text-primary').trim();
          const lightAccentVar = lightRootStyles.getPropertyValue('--accent-primary').trim();
          const lightBodyBg = getComputedStyle(document.body).backgroundColor;
          const lightBodyColor = getComputedStyle(document.body).color;

          // Switch to Dark mode via keyboard operation on the top-bar theme toggle button
          await window.elmDesktop.restoreMainWindow();
          const toggleBtn = document.querySelector('[data-testid="theme-toggle-button"]');
          let keyboardToggleFocused = false;
          let toggleRegionNoDrag = false;
          let topBarRegionDrag = false;
          let toggleFocusOutlineStyle = '';
          let ariaPressedBeforeKey = null;
          let ariaPressedAfterKey = null;

          const topBarEl = document.querySelector('.top-bar');
          if (topBarEl) {
            topBarRegionDrag =
              getComputedStyle(topBarEl).getPropertyValue('-webkit-app-region').trim() === 'drag';
          }

          if (toggleBtn instanceof HTMLElement) {
            toggleBtn.focus();
            keyboardToggleFocused = document.activeElement === toggleBtn;
            toggleRegionNoDrag =
              getComputedStyle(toggleBtn).getPropertyValue('-webkit-app-region').trim() === 'no-drag';
            toggleFocusOutlineStyle = getComputedStyle(toggleBtn).outlineStyle;
            ariaPressedBeforeKey = toggleBtn.getAttribute('aria-pressed');
            // Activate button via keyboard Enter/Click handler
            toggleBtn.click();
            await new Promise((r) => setTimeout(r, 120));
            ariaPressedAfterKey = toggleBtn.getAttribute('aria-pressed');
          }

          // Open Separate Chat Window and verify immediate sync across both windows
          await window.elmDesktop.openSeparateChatWindow();
          await new Promise((r) => setTimeout(r, 150));

          const darkReloadedAfterRestartSim = await window.elmDesktop.reloadThemeFromDisk();
          const darkRootDataTheme = document.documentElement.getAttribute('data-theme');
          const darkRootStyles = getComputedStyle(document.documentElement);
          const darkSurfaceVar = darkRootStyles.getPropertyValue('--surface-primary').trim();
          const darkTextVar = darkRootStyles.getPropertyValue('--text-primary').trim();
          const darkAccentVar = darkRootStyles.getPropertyValue('--accent-primary').trim();
          const darkBodyBg = getComputedStyle(document.body).backgroundColor;
          const darkBodyColor = getComputedStyle(document.body).color;

          // Check locally bundled Chakra Petch font and zero gradients/heavy shadows
          await document.fonts.ready;
          const h1El = document.querySelector('.top-bar h1');
          const h1FontFamily = h1El ? getComputedStyle(h1El).fontFamily : '';
          const cardEl = document.querySelector('.card');
          const cardBoxShadow = cardEl ? getComputedStyle(cardEl).boxShadow : '';
          const cardBgImage = cardEl ? getComputedStyle(cardEl).backgroundImage : '';

          results.phase6UiThemeSuite = {
            firstLaunchUsesSystemPreference:
              firstLaunchState.source === 'system_default' &&
              firstLaunchState.mode ===
                (firstLaunchState.systemPrefersDark ? 'dark' : 'light'),
            lightThemeApplied: {
              mode: lightSet.mode,
              persistedAcrossRestart:
                lightReloadedAfterRestartSim.mode === 'light' &&
                lightReloadedAfterRestartSim.source === 'user_persisted',
              domDataTheme: lightRootDataTheme,
              surfaceToken: lightSurfaceVar,
              textToken: lightTextVar,
              accentToken: lightAccentVar,
              computedBodyBg: lightBodyBg,
              computedBodyColor: lightBodyColor,
            },
            darkThemeAppliedViaToggle: {
              mode: darkReloadedAfterRestartSim.mode,
              persistedAcrossRestart:
                darkReloadedAfterRestartSim.mode === 'dark' &&
                darkReloadedAfterRestartSim.source === 'user_persisted',
              domDataTheme: darkRootDataTheme,
              surfaceToken: darkSurfaceVar,
              textToken: darkTextVar,
              accentToken: darkAccentVar,
              computedBodyBg: darkBodyBg,
              computedBodyColor: darkBodyColor,
            },
            keyboardAndDragRegions: {
              topBarRegionDrag,
              toggleRegionNoDrag,
              keyboardToggleFocused,
              ariaPressedBeforeKey,
              ariaPressedAfterKey,
              toggleFocusOutlineStyle,
            },
            typographyAndCrispPanels: {
              h1FontFamilyIncludesChakraPetch: h1FontFamily.toLowerCase().includes('chakra petch'),
              h1FontFamily,
              cardBoxShadowNone: cardBoxShadow === 'none',
              cardBackgroundImageNone: cardBgImage === 'none',
            },
          };

          // Phase 7: WebRTC Readability, Dedicated Viewer Stage & Privacy-Safe Diagnostics Telemetry
          if (typeof window.runElmReadabilityVerificationSuite === 'function') {
            results.phase7ReadabilitySuite = await withTimeout(
              window.runElmReadabilityVerificationSuite(),
              30000,
              'runElmReadabilityVerificationSuite'
            );
          } else {
            results.phase7ReadabilitySuiteError =
              'runElmReadabilityVerificationSuite not found on window';
          }

          return JSON.stringify(results);
        } catch (err) {
          return JSON.stringify({
            innerError: err instanceof Error ? err.message : String(err),
            innerStack: err instanceof Error ? err.stack : undefined,
          });
        }
      })();
    `,
      true
    );
    const mediaSuiteResult = JSON.parse(String(mediaSuiteJson));

    // Verify immediate theme synchronization between Main Window and open Separate Chat Window
    let chatWindowSyncedLight = false;
    let chatWindowSyncedDark = false;
    let chatWindowHasThemeToggle = false;
    if (chatWindow && !chatWindow.isDestroyed()) {
      setPersistedThemeMode('light');
      await sleep(100);
      const [mainThemeLight, chatThemeLight] = await Promise.all([
        win.webContents.executeJavaScript(
          `document.documentElement.getAttribute('data-theme')`
        ),
        chatWindow.webContents.executeJavaScript(
          `document.documentElement.getAttribute('data-theme')`
        ),
      ]);
      chatWindowSyncedLight =
        mainThemeLight === 'light' && chatThemeLight === 'light';

      setPersistedThemeMode('dark');
      await sleep(100);
      const [mainThemeDark, chatThemeDark, chatTogglePresent] =
        await Promise.all([
          win.webContents.executeJavaScript(
            `document.documentElement.getAttribute('data-theme')`
          ),
          chatWindow.webContents.executeJavaScript(
            `document.documentElement.getAttribute('data-theme')`
          ),
          chatWindow.webContents.executeJavaScript(
            `Boolean(document.querySelector('[data-testid="theme-toggle-button"]'))`
          ),
        ]);
      chatWindowSyncedDark =
        mainThemeDark === 'dark' && chatThemeDark === 'dark';
      chatWindowHasThemeToggle = Boolean(chatTogglePresent);
    }

    const contrastVerification = {
      lightTextOnSurface: computeWcagContrastRatio(
        THEME_TOKENS.light.textPrimary,
        THEME_TOKENS.light.surfacePrimary
      ),
      lightMutedOnSurface: computeWcagContrastRatio(
        THEME_TOKENS.light.textMuted,
        THEME_TOKENS.light.surfacePrimary
      ),
      lightActionTextOnBlue: computeWcagContrastRatio(
        THEME_TOKENS.light.accentActionText,
        THEME_TOKENS.light.accentActionBg
      ),
      darkTextOnSurface: computeWcagContrastRatio(
        THEME_TOKENS.dark.textPrimary,
        THEME_TOKENS.dark.surfacePrimary
      ),
      darkMutedOnSurface: computeWcagContrastRatio(
        THEME_TOKENS.dark.textMuted,
        THEME_TOKENS.dark.surfacePrimary
      ),
      darkAccentOnSurface: computeWcagContrastRatio(
        THEME_TOKENS.dark.accentPrimary,
        THEME_TOKENS.dark.surfacePrimary
      ),
    };

    if (mediaSuiteResult.phase6UiThemeSuite) {
      mediaSuiteResult.phase6UiThemeSuite.chatWindowImmediateSync = {
        chatWindowSyncedLight,
        chatWindowSyncedDark,
        chatWindowHasThemeToggle,
      };
      mediaSuiteResult.phase6UiThemeSuite.wcagContrastRatios = {
        ...contrastVerification,
        allExceedWcagAa4_5:
          contrastVerification.lightTextOnSurface >= 4.5 &&
          contrastVerification.lightMutedOnSurface >= 4.5 &&
          contrastVerification.lightActionTextOnBlue >= 4.5 &&
          contrastVerification.darkTextOnSurface >= 4.5 &&
          contrastVerification.darkMutedOnSurface >= 4.5 &&
          contrastVerification.darkAccentOnSurface >= 4.5,
      };
    }

    const report = {
      timestamp: new Date().toISOString(),
      environment: {
        platform: process.platform,
        osRelease: `${os.type()} ${os.release()} (${os.arch()})`,
        electronVersion: process.versions.electron,
        chromeVersion: process.versions.chrome,
        nodeVersion: process.versions.node,
      },
      taskbarAndDwm: {
        openState: {
          isMinimized: openState.isMinimized,
          win32IsIconic: openState.win32IsIconic,
          skipTaskbarApplied: openState.skipTaskbarApplied,
          wsExAppWindow: openState.wsExAppWindow,
          dwmAttributes: openState.dwmAttributes,
        },
        minimizedState: {
          isMinimized: minimizedState.isMinimized,
          win32IsIconic: minimizedState.win32IsIconic,
          skipTaskbarApplied: minimizedState.skipTaskbarApplied,
          wsExAppWindow: minimizedState.wsExAppWindow,
          iconicThumbnail: minimizedState.iconicThumbnail,
          livePreview: minimizedState.livePreview,
        },
        restoredState: {
          isMinimized: restoredState.isMinimized,
          win32IsIconic: restoredState.win32IsIconic,
          skipTaskbarApplied: restoredState.skipTaskbarApplied,
          wsExAppWindow: restoredState.wsExAppWindow,
          transitionsCount: restoredState.transitions.length,
        },
      },
      mediaSuite: {
        ...mediaSuiteResult,
        lastDisplayMediaRequestFlags,
      },
    };

    const reportPath = path.join(__dirname, '../prototype-suite-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    const reportPath = path.join(__dirname, '../prototype-suite-report.json');
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        null,
        2
      ),
      'utf8'
    );
    process.exitCode = 1;
  } finally {
    wasapiManager.stopCapture();
    app.exit(0);
  }
}

let cleanupCompletedBeforeQuit = false;

app.on('before-quit', (event) => {
  wasapiManager.stopCapture();
  resetVolatileUiState();
  if (!cleanupCompletedBeforeQuit) {
    event.preventDefault();
    cleanupCompletedBeforeQuit = true;
    void (async () => {
      try {
        await Promise.race([
          getAuthController().cleanupOnAppQuit(),
          new Promise((r) => setTimeout(r, 2500)),
        ]);
      } finally {
        app.quit();
      }
    })();
  }
});

app.on('window-all-closed', () => {
  wasapiManager.stopCapture();
  app.quit();
});
