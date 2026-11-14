import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';
import {
  DEFAULT_HOST_MEDIA_SELECTION,
  PROTOCOL_VERSION,
} from '@elm/protocol';
import type { DesktopRuntimeMetadata, DesktopWindowRole } from '../shared/bridge';

let mainWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;

const windowRoles = new WeakMap<BrowserWindow, DesktopWindowRole>();

function createSecureWebPreferences() {
  return {
    preload: path.join(__dirname, '../preload/index.cjs'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
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

  const win = new BrowserWindow({
    width: 1024,
    height: 700,
    minWidth: 820,
    minHeight: 560,
    title: 'Elm-AnyDesk — Consent-Based 1:1 Screen Share (Scaffold)',
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: createSecureWebPreferences(),
  });

  windowRoles.set(win, 'main');
  attachWindowSecurityGuards(win);

  const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
  await win.loadFile(rendererHtmlPath, { query: { role: 'main' } });

  win.on('closed', () => {
    mainWindow = null;
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.close();
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
    width: 420,
    height: 580,
    minWidth: 340,
    minHeight: 420,
    title: 'Elm-AnyDesk — Private 1:1 Session Chat (Scaffold)',
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: createSecureWebPreferences(),
  });

  windowRoles.set(win, 'chat');
  attachWindowSecurityGuards(win);

  const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
  await win.loadFile(rendererHtmlPath, { query: { role: 'chat' } });

  win.on('closed', () => {
    chatWindow = null;
  });

  chatWindow = win;
  return win;
}

function registerIpcHandlers(): void {
  ipcMain.handle('elm:get-runtime-metadata', (event): DesktopRuntimeMetadata => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const role: DesktopWindowRole =
      (senderWindow && windowRoles.get(senderWindow)) || 'main';

    return {
      appName: app.getName(),
      appVersion: app.getVersion(),
      protocolVersion: PROTOCOL_VERSION,
      platform: process.platform,
      windowRole: role,
      phase: 'Phase 1 — Project Brief & Scaffold Only',
      defaultMediaSelection: DEFAULT_HOST_MEDIA_SELECTION,
      initialSessionState: 'idle',
      securityPosture: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        narrowPreloadBridge: true,
      },
    };
  });

  ipcMain.handle('elm:open-separate-chat-window', async () => {
    await createOrFocusChatWindow();
    return { opened: true };
  });
}

app.whenReady().then(async () => {
  // Phase 1 scaffold: deny all browser permissions by default (including notifications)
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    }
  );

  registerIpcHandlers();
  mainWindow = await createMainWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
