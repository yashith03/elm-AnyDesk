import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
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
  type MediaSourceKind,
  type SessionTerminationReason,
  type WebRtcSignalPayload,
} from '@elm/protocol';
import type {
  DesktopRuntimeMetadata,
  DesktopWindowRole,
  ShareableSourceDescriptor,
  TaskbarDwmTelemetry,
  VolatileSessionUiState,
} from '../shared/bridge';
import { DesktopAuthAndInviteController } from './auth-invite-client';
import { Win11TaskbarDwmController } from './win11-dwm';
import { WasapiLoopbackManager } from './wasapi-loopback';

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

if (process.argv.includes('--run-prototype-suite')) {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}

const windowRoles = new WeakMap<BrowserWindow, DesktopWindowRole>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAuthController(): DesktopAuthAndInviteController {
  if (!authInviteController) {
    authInviteController = new DesktopAuthAndInviteController();
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

  const win = new BrowserWindow({
    width: 1140,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: 'Elm-AnyDesk — Consent-Based 1:1 Screen Share',
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: createSecureWebPreferences(),
  });

  windowRoles.set(win, 'main');
  attachWindowSecurityGuards(win);

  taskbarDwmController = new Win11TaskbarDwmController(win);
  taskbarDwmController.initialize();

  const rendererHtmlPath = path.join(__dirname, '../renderer/index.html');
  await win.loadFile(rendererHtmlPath, { query: { role: 'main' } });

  win.on('closed', () => {
    wasapiManager.stopCapture();
    resetVolatileUiState();
    getAuthController().disconnectActiveSession({
      reason: 'app_closed',
      subReason: 'main_window_closed',
    });
    mainWindow = null;
    taskbarDwmController = null;
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
    width: 480,
    height: 660,
    minWidth: 380,
    minHeight: 480,
    title: 'Elm-AnyDesk — Private 1:1 Session Chat (Volatile DataChannel)',
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
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

  ipcMain.handle('elm:copy-text-to-clipboard', (_event, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return { copied: true };
  });

  // Phase 2: Auth, Permanent Friend Code, Presence & Invites
  ipcMain.handle('elm:auth-get-stored-session', () => {
    return getAuthController().getStoredAuthSession();
  });

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

  ipcMain.handle('elm:invites-send', (_event, friendCode: string) => {
    return getAuthController().sendFriendCodeInvite(String(friendCode ?? ''));
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

  powerMonitor.on('suspend', () => {
    wasapiManager.stopCapture();
    resetVolatileUiState();
    getAuthController().disconnectActiveSession({
      reason: 'connection_lost',
      subReason: 'os_sleep_suspend',
    });
  });

  mainWindow = await createMainWindow();

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

app.on('before-quit', () => {
  wasapiManager.stopCapture();
  resetVolatileUiState();
  getAuthController().disconnectActiveSession({
    reason: 'app_closed',
    subReason: 'app_before_quit',
  });
});

app.on('window-all-closed', () => {
  wasapiManager.stopCapture();
  app.quit();
});
