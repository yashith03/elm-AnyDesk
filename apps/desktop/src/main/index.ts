import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  nativeTheme,
  powerMonitor,
  screen,
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
  HostOverlayUiState,
  HostToolbarActionPayload,
  PresenceRuntimeStatus,
  ShareableSourceDescriptor,
  TaskbarDwmTelemetry,
  VolatileSessionUiState,
} from '../shared/bridge';
import {
  DEFAULT_FLOATING_PANEL_APPEARANCE,
  sanitizeFloatingPanelAppearance,
  type FloatingPanelAppearance,
} from '../shared/floating-panel';
import {
  THEME_TOKENS,
  computeWcagContrastRatio,
  type ThemeMode,
  type ThemeStateSnapshot,
} from '../shared/theme';
import { DesktopAuthAndInviteController } from './auth-invite-client';
import {
  CaptureProtectionController,
  type ProtectedWindowRegistry,
} from './capture-protection';
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
let hostToolbarWindow: BrowserWindow | null = null;
let sourcePickerWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let taskbarDwmController: Win11TaskbarDwmController | null = null;
let authInviteController: DesktopAuthAndInviteController | null = null;
let lastHostToolbarBounds: Electron.Rectangle | null = null;
let lastSourcePickerClosedAt = 0;
let lastSettingsClosedAt = 0;
const wasapiManager = new WasapiLoopbackManager();
const captureProtection = new CaptureProtectionController();

let explicitlySelectedSourceId: string | null = null;

function getProtectedRegistry(): ProtectedWindowRegistry {
  return {
    main: mainWindow,
    hostToolbar: hostToolbarWindow,
    chat: chatWindow,
    sourcePicker: sourcePickerWindow,
    settings: settingsWindow,
  };
}

let floatingAppearance: FloatingPanelAppearance = {
  ...DEFAULT_FLOATING_PANEL_APPEARANCE,
};

function getAllOpenUiWindows(): BrowserWindow[] {
  return [
    mainWindow,
    hostToolbarWindow,
    chatWindow,
    sourcePickerWindow,
    settingsWindow,
  ].filter((w): w is BrowserWindow => Boolean(w && !w.isDestroyed()));
}

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
  imageAttachmentsByMessageId: {},
  hostMediaState: null,
};

let hostOverlayState: HostOverlayUiState = {
  sessionActive: false,
  sessionId: null,
  peerDisplayName: '',
  connectionState: 'closed',
  iceConnectionState: 'new',
  dataChannelState: 'closed',
  hostMediaState: null,
  hostMicMutedLocally: false,
  isStartingShare: false,
  isStartingMic: false,
  isStartingDeviceSound: false,
  shareableSources: [],
  selectedSourceId: null,
  playWasapiTestTone: false,
  chatOpen: false,
  sourcePickerOpen: false,
  settingsOpen: false,
  appearance: floatingAppearance,
  captureProtection: captureProtection.getState(getProtectedRegistry()),
};

function broadcastHostOverlayState(): void {
  const nextState: HostOverlayUiState = {
    ...hostOverlayState,
    chatOpen: Boolean(chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()),
    sourcePickerOpen: Boolean(
      sourcePickerWindow &&
        !sourcePickerWindow.isDestroyed() &&
        sourcePickerWindow.isVisible()
    ),
    settingsOpen: Boolean(
      settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible()
    ),
    appearance: floatingAppearance,
    captureProtection: captureProtection.getState(getProtectedRegistry()),
  };
  hostOverlayState = nextState;
  for (const win of getAllOpenUiWindows()) {
    win.webContents.send('elm:host-overlay-updated', nextState);
  }
}

function broadcastCaptureProtectionState(): void {
  const state = captureProtection.applyToAll(getProtectedRegistry());
  for (const win of getAllOpenUiWindows()) {
    win.webContents.send('elm:capture-protection-updated', state);
  }
  broadcastHostOverlayState();
}

function broadcastFloatingAppearance(): void {
  for (const win of getAllOpenUiWindows()) {
    win.webContents.send('elm:floating-appearance-updated', floatingAppearance);
  }
  broadcastHostOverlayState();
}

function closeHostSourcePickerWindow(): void {
  if (sourcePickerWindow && !sourcePickerWindow.isDestroyed()) {
    lastSourcePickerClosedAt = Date.now();
    sourcePickerWindow.close();
  }
  sourcePickerWindow = null;
}

function closeHostSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    lastSettingsClosedAt = Date.now();
    settingsWindow.close();
  }
  settingsWindow = null;
}

function closeHostOverlayWindows(restoreMain: boolean): void {
  closeHostSourcePickerWindow();
  closeHostSettingsWindow();
  if (hostToolbarWindow && !hostToolbarWindow.isDestroyed()) {
    hostToolbarWindow.close();
  }
  hostToolbarWindow = null;
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.close();
  }
  chatWindow = null;
  lastHostToolbarBounds = null;
  captureProtection.resetToDefaultOn(getProtectedRegistry());
  hostOverlayState = {
    ...hostOverlayState,
    sessionActive: false,
    sessionId: null,
    peerDisplayName: '',
    connectionState: 'closed',
    iceConnectionState: 'new',
    dataChannelState: 'closed',
    hostMediaState: null,
    hostMicMutedLocally: false,
    isStartingShare: false,
    isStartingMic: false,
    isStartingDeviceSound: false,
    chatOpen: false,
    sourcePickerOpen: false,
    settingsOpen: false,
    captureProtection: captureProtection.getState(getProtectedRegistry()),
  };
  broadcastCaptureProtectionState();
  if (restoreMain && mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
}

function resetVolatileUiState(): void {
  volatileUiState = {
    session: null,
    currentAccount: volatileUiState.currentAccount,
    connectionState: 'closed',
    dataChannelState: 'closed',
    messagePreviewsEnabled: false,
    messages: [],
    imageAttachmentsByMessageId: {},
    hostMediaState: null,
  };
  broadcastVolatileUiState();
}

function broadcastVolatileUiState(): void {
  for (const win of [mainWindow, chatWindow, hostToolbarWindow]) {
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
  for (const win of getAllOpenUiWindows()) {
    try {
      win.setBackgroundColor(bg);
    } catch {
      // Ignore if window is closing
    }
    win.webContents.send('elm:theme-updated', state);
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
  captureProtection.applyToWindow(win);

  taskbarDwmController = new Win11TaskbarDwmController(win);
  taskbarDwmController.initialize();

  const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
  await win.loadFile(rendererHtmlPath, { query: { role: 'main' } });
  captureProtection.applyToWindow(win);

  win.on('show', () => {
    captureProtection.applyToWindow(win);
  });
  win.on('restore', () => {
    captureProtection.applyToWindow(win);
  });
  win.on('focus', () => {
    captureProtection.applyToWindow(win);
  });
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
    closeHostOverlayWindows(false);
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.close();
    }
  });

  return win;
}

function clampRectToDisplayWorkArea(
  rect: Electron.Rectangle,
  preferredBounds?: Electron.Rectangle | null
): Electron.Rectangle {
  const display = screen.getDisplayMatching(preferredBounds ?? rect);
  const wa = display.workArea;
  const width = Math.min(rect.width, Math.max(240, wa.width - 16));
  const height = Math.min(rect.height, Math.max(48, wa.height - 16));
  const maxX = Math.max(wa.x + 8, wa.x + wa.width - width - 8);
  const maxY = Math.max(wa.y + 8, wa.y + wa.height - height - 8);
  const x = Math.max(wa.x + 8, Math.min(rect.x, maxX));
  const y = Math.max(wa.y + 8, Math.min(rect.y, maxY));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function positionPopupBelowHostToolbar(
  popup: BrowserWindow,
  popupWidth: number,
  popupHeight: number,
  align: 'center' | 'right'
): void {
  if (popup.isDestroyed()) return;
  const anchor =
    hostToolbarWindow && !hostToolbarWindow.isDestroyed()
      ? hostToolbarWindow.getBounds()
      : mainWindow && !mainWindow.isDestroyed()
        ? mainWindow.getBounds()
        : screen.getPrimaryDisplay().workArea;
  const display = screen.getDisplayMatching(anchor);
  const wa = display.workArea;

  const desiredX =
    align === 'right'
      ? anchor.x + anchor.width - popupWidth
      : anchor.x + Math.round((anchor.width - popupWidth) / 2);
  let desiredY = anchor.y + anchor.height + 8;
  if (desiredY + popupHeight > wa.y + wa.height - 8) {
    desiredY = Math.max(wa.y + 8, anchor.y - popupHeight - 8);
  }

  const clamped = clampRectToDisplayWorkArea(
    { x: desiredX, y: desiredY, width: popupWidth, height: popupHeight },
    anchor
  );
  popup.setBounds(clamped, false);
}

async function createOrShowHostToolbarWindow(): Promise<BrowserWindow> {
  if (hostToolbarWindow && !hostToolbarWindow.isDestroyed()) {
    hostToolbarWindow.setAlwaysOnTop(true, 'floating');
    captureProtection.applyToWindow(hostToolbarWindow);
    if (hostToolbarWindow.isMinimized()) {
      hostToolbarWindow.restore();
    }
    hostToolbarWindow.show();
    broadcastHostOverlayState();
    return hostToolbarWindow;
  }

  const anchorBounds =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getBounds()
      : screen.getPrimaryDisplay().workArea;
  const display = screen.getDisplayMatching(anchorBounds);
  const wa = display.workArea;
  const baseWidth = captureProtection.isToggleAllowed() ? 940 : 840;
  const width = Math.min(Math.max(480, wa.width - 24), baseWidth);
  const height = 54;

  const initialRect = clampRectToDisplayWorkArea(
    lastHostToolbarBounds
      ? {
          x: lastHostToolbarBounds.x,
          y: lastHostToolbarBounds.y,
          width,
          height,
        }
      : {
          x: wa.x + Math.round((wa.width - width) / 2),
          y: wa.y + 14,
          width,
          height,
        },
    anchorBounds
  );
  lastHostToolbarBounds = initialRect;

  const win = new BrowserWindow({
    x: initialRect.x,
    y: initialRect.y,
    width: initialRect.width,
    height: initialRect.height,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    show: false,
    title: 'Elm-AnyDesk — Host Toolbar',
    icon: getWindowIconPath(),
    backgroundColor: THEME_TOKENS[getOrLoadThemeState().mode].bgCanvas,
    webPreferences: createSecureWebPreferences(),
  });

  windowRoles.set(win, 'host-toolbar');
  win.setAlwaysOnTop(true, 'floating');
  attachWindowSecurityGuards(win);
  captureProtection.applyToWindow(win);

  const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
  await win.loadFile(rendererHtmlPath, { query: { role: 'host-toolbar' } });
  captureProtection.applyToWindow(win);

  win.on('move', () => {
    if (win.isDestroyed()) return;
    lastHostToolbarBounds = win.getBounds();
    if (sourcePickerWindow && !sourcePickerWindow.isDestroyed()) {
      positionPopupBelowHostToolbar(sourcePickerWindow, 360, 340, 'center');
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      positionPopupBelowHostToolbar(settingsWindow, 320, 410, 'right');
    }
  });

  win.on('show', () => {
    win.setAlwaysOnTop(true, 'floating');
    captureProtection.applyToWindow(win);
  });

  win.on('closed', () => {
    hostToolbarWindow = null;
    closeHostSourcePickerWindow();
    closeHostSettingsWindow();
    broadcastCaptureProtectionState();
  });

  hostToolbarWindow = win;
  win.show();
  broadcastCaptureProtectionState();
  return win;
}

async function createOrShowHostSourcePickerWindow(): Promise<BrowserWindow> {
  if (sourcePickerWindow && !sourcePickerWindow.isDestroyed()) {
    captureProtection.applyToWindow(sourcePickerWindow);
    positionPopupBelowHostToolbar(sourcePickerWindow, 360, 340, 'center');
    sourcePickerWindow.show();
    sourcePickerWindow.focus();
    broadcastHostOverlayState();
    return sourcePickerWindow;
  }

  const win = new BrowserWindow({
    width: 360,
    height: 340,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    show: false,
    title: 'Elm-AnyDesk — Select Screen or Window',
    icon: getWindowIconPath(),
    backgroundColor: THEME_TOKENS[getOrLoadThemeState().mode].bgCanvas,
    webPreferences: createSecureWebPreferences(),
  });

  windowRoles.set(win, 'host-source-picker');
  win.setAlwaysOnTop(true, 'floating');
  attachWindowSecurityGuards(win);
  captureProtection.applyToWindow(win);

  const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
  await win.loadFile(rendererHtmlPath, {
    query: { role: 'host-source-picker' },
  });
  captureProtection.applyToWindow(win);
  positionPopupBelowHostToolbar(win, 360, 340, 'center');

  win.on('blur', () => {
    closeHostSourcePickerWindow();
    broadcastHostOverlayState();
  });

  win.on('closed', () => {
    if (sourcePickerWindow === win) {
      sourcePickerWindow = null;
    }
    broadcastCaptureProtectionState();
  });

  sourcePickerWindow = win;
  win.show();
  win.focus();
  broadcastCaptureProtectionState();
  return win;
}

async function createOrShowHostSettingsWindow(): Promise<BrowserWindow> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    captureProtection.applyToWindow(settingsWindow);
    positionPopupBelowHostToolbar(settingsWindow, 320, 410, 'right');
    settingsWindow.show();
    settingsWindow.focus();
    broadcastHostOverlayState();
    return settingsWindow;
  }

  const win = new BrowserWindow({
    width: 320,
    height: 410,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    show: false,
    title: 'Elm-AnyDesk — Overlay Appearance Settings',
    icon: getWindowIconPath(),
    backgroundColor: THEME_TOKENS[getOrLoadThemeState().mode].bgCanvas,
    webPreferences: createSecureWebPreferences(),
  });

  windowRoles.set(win, 'host-settings');
  win.setAlwaysOnTop(true, 'floating');
  attachWindowSecurityGuards(win);
  captureProtection.applyToWindow(win);

  const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
  await win.loadFile(rendererHtmlPath, { query: { role: 'host-settings' } });
  captureProtection.applyToWindow(win);
  positionPopupBelowHostToolbar(win, 320, 410, 'right');

  win.on('blur', () => {
    closeHostSettingsWindow();
    broadcastHostOverlayState();
  });

  win.on('closed', () => {
    if (settingsWindow === win) {
      settingsWindow = null;
    }
    broadcastCaptureProtectionState();
  });

  settingsWindow = win;
  win.show();
  win.focus();
  broadcastCaptureProtectionState();
  return win;
}

async function createOrFocusChatWindow(): Promise<BrowserWindow> {
  if (chatWindow && !chatWindow.isDestroyed()) {
    if (chatWindow.isMinimized()) {
      chatWindow.restore();
    }
    chatWindow.setAlwaysOnTop(hostOverlayState.sessionActive, 'floating');
    captureProtection.applyToWindow(chatWindow);
    chatWindow.show();
    chatWindow.focus();
    broadcastHostOverlayState();
    return chatWindow;
  }

  const anchor =
    hostToolbarWindow && !hostToolbarWindow.isDestroyed()
      ? hostToolbarWindow.getBounds()
      : mainWindow && !mainWindow.isDestroyed()
        ? mainWindow.getBounds()
        : screen.getPrimaryDisplay().workArea;
  const display = screen.getDisplayMatching(anchor);
  const wa = display.workArea;
  const width = 400;
  const height = 480;
  const initialBounds = clampRectToDisplayWorkArea(
    {
      x:
        hostToolbarWindow && !hostToolbarWindow.isDestroyed()
          ? anchor.x + anchor.width - width
          : wa.x + wa.width - width - 24,
      y:
        hostToolbarWindow && !hostToolbarWindow.isDestroyed()
          ? anchor.y + anchor.height + 12
          : wa.y + 40,
      width,
      height,
    },
    anchor
  );

  const win = new BrowserWindow({
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: 320,
    minHeight: 320,
    frame: false,
    skipTaskbar: hostOverlayState.sessionActive,
    alwaysOnTop: hostOverlayState.sessionActive,
    hasShadow: true,
    title: 'Elm-AnyDesk — Private 1:1 Session Chat (Volatile DataChannel)',
    icon: getWindowIconPath(),
    autoHideMenuBar: true,
    backgroundColor: THEME_TOKENS[getOrLoadThemeState().mode].bgCanvas,
    webPreferences: createSecureWebPreferences(),
  });

  windowRoles.set(win, 'chat');
  if (hostOverlayState.sessionActive) {
    win.setAlwaysOnTop(true, 'floating');
  }
  attachWindowSecurityGuards(win);
  captureProtection.applyToWindow(win);

  const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
  await win.loadFile(rendererHtmlPath, { query: { role: 'chat' } });
  captureProtection.applyToWindow(win);

  win.on('show', () => {
    captureProtection.applyToWindow(win);
  });
  win.on('restore', () => {
    captureProtection.applyToWindow(win);
  });

  win.on('closed', () => {
    chatWindow = null;
    broadcastCaptureProtectionState();
  });

  chatWindow = win;
  broadcastCaptureProtectionState();
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

        const targetTypes: Array<'screen' | 'window'> =
          explicitlySelectedSourceId.startsWith('screen:')
            ? ['screen']
            : ['window'];
        const sources = await desktopCapturer.getSources({
          types: targetTypes,
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
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
    closeHostOverlayWindows(false);
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
        closeHostOverlayWindows(false);
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
      closeHostOverlayWindows(true);
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
        closeHostOverlayWindows(true);
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
      params: {
        text: string;
        senderOverride?: 'host' | 'guest';
        imageDataUrl?: string;
        imageMimeType?: string;
        imageName?: string;
        imageByteLength?: number;
      }
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

  ipcMain.handle('elm:host-overlay-get', (): HostOverlayUiState => {
    return {
      ...hostOverlayState,
      chatOpen: Boolean(chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()),
      sourcePickerOpen: Boolean(
        sourcePickerWindow &&
          !sourcePickerWindow.isDestroyed() &&
          sourcePickerWindow.isVisible()
      ),
      settingsOpen: Boolean(
        settingsWindow &&
          !settingsWindow.isDestroyed() &&
          settingsWindow.isVisible()
      ),
      appearance: floatingAppearance,
      captureProtection: captureProtection.getState(getProtectedRegistry()),
    };
  });

  ipcMain.handle(
    'elm:host-overlay-sync',
    (_event, patch: Partial<HostOverlayUiState>): HostOverlayUiState => {
      hostOverlayState = {
        ...hostOverlayState,
        ...patch,
      };
      broadcastHostOverlayState();
      return hostOverlayState;
    }
  );

  ipcMain.handle(
    'elm:host-toolbar-action-dispatch',
    (_event, action: HostToolbarActionPayload): { dispatched: boolean } => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('elm:host-toolbar-action-event', action);
        return { dispatched: true };
      }
      return { dispatched: false };
    }
  );

  ipcMain.handle(
    'elm:host-toolbar-window-toggle',
    async (_event, open: boolean): Promise<{ open: boolean }> => {
      if (open) {
        await createOrShowHostToolbarWindow();
        return { open: true };
      }
      closeHostOverlayWindows(true);
      return { open: false };
    }
  );

  ipcMain.handle(
    'elm:host-source-picker-toggle',
    async (_event, open?: boolean): Promise<{ open: boolean }> => {
      const currentlyOpen = Boolean(
        sourcePickerWindow &&
          !sourcePickerWindow.isDestroyed() &&
          sourcePickerWindow.isVisible()
      );
      const justClosedByBlur = Date.now() - lastSourcePickerClosedAt < 250;
      const shouldOpen =
        open !== undefined
          ? Boolean(open)
          : !(currentlyOpen || justClosedByBlur);
      if (shouldOpen) {
        closeHostSettingsWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('elm:host-toolbar-action-event', {
            type: 'refresh-sources',
          } satisfies HostToolbarActionPayload);
        }
        await createOrShowHostSourcePickerWindow();
        return { open: true };
      }
      closeHostSourcePickerWindow();
      broadcastHostOverlayState();
      return { open: false };
    }
  );

  ipcMain.handle(
    'elm:host-settings-toggle',
    async (_event, open?: boolean): Promise<{ open: boolean }> => {
      const currentlyOpen = Boolean(
        settingsWindow &&
          !settingsWindow.isDestroyed() &&
          settingsWindow.isVisible()
      );
      const justClosedByBlur = Date.now() - lastSettingsClosedAt < 250;
      const shouldOpen =
        open !== undefined
          ? Boolean(open)
          : !(currentlyOpen || justClosedByBlur);
      if (shouldOpen) {
        closeHostSourcePickerWindow();
        await createOrShowHostSettingsWindow();
        return { open: true };
      }
      closeHostSettingsWindow();
      broadcastHostOverlayState();
      return { open: false };
    }
  );

  ipcMain.handle('elm:close-separate-chat-window', (): { closed: boolean } => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.close();
      chatWindow = null;
      broadcastHostOverlayState();
      return { closed: true };
    }
    return { closed: false };
  });

  ipcMain.handle('elm:restore-and-focus-main-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
      captureProtection.applyToWindow(mainWindow);
    }
  });

  ipcMain.handle(
    'elm:floating-appearance-get',
    (): FloatingPanelAppearance => {
      return floatingAppearance;
    }
  );

  ipcMain.handle(
    'elm:floating-appearance-set',
    (_event, patch: Partial<FloatingPanelAppearance>): FloatingPanelAppearance => {
      floatingAppearance = sanitizeFloatingPanelAppearance({
        ...floatingAppearance,
        ...patch,
      });
      broadcastFloatingAppearance();
      return floatingAppearance;
    }
  );

  ipcMain.handle('elm:capture-protection-get', () => {
    return captureProtection.getState(getProtectedRegistry());
  });

  ipcMain.handle('elm:capture-protection-set', (_event, enabled: boolean) => {
    const next = captureProtection.setTestEnabled(
      Boolean(enabled),
      getProtectedRegistry()
    );
    broadcastCaptureProtectionState();
    return next;
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
      const targetTypes: Array<'screen' | 'window'> = sourceId.startsWith(
        'screen:'
      )
        ? ['screen']
        : ['window'];
      const rawSources = await desktopCapturer.getSources({
        types: targetTypes,
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
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
    closeHostOverlayWindows(false);
    const ctrl = getAuthController();
    ctrl.pausePresenceForSuspend();
    void ctrl.disconnectActiveSession({
      reason: 'connection_lost',
      subReason: 'os_sleep_suspend',
    });
  });

  screen.on('display-metrics-changed', () => {
    if (hostToolbarWindow && !hostToolbarWindow.isDestroyed()) {
      const clamped = clampRectToDisplayWorkArea(hostToolbarWindow.getBounds());
      hostToolbarWindow.setBounds(clamped, false);
      lastHostToolbarBounds = clamped;
    }
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.setBounds(clampRectToDisplayWorkArea(chatWindow.getBounds()), false);
    }
    if (sourcePickerWindow && !sourcePickerWindow.isDestroyed()) {
      positionPopupBelowHostToolbar(sourcePickerWindow, 360, 340, 'center');
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      positionPopupBelowHostToolbar(settingsWindow, 320, 410, 'right');
    }
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
  closeHostOverlayWindows(false);
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
