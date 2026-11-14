import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
} from 'electron';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_HOST_MEDIA_SELECTION,
  PROTOCOL_VERSION,
} from '@elm/protocol';
import type {
  DesktopRuntimeMetadata,
  DesktopWindowRole,
  ShareableSourceDescriptor,
  TaskbarDwmTelemetry,
} from '../shared/bridge';
import { Win11TaskbarDwmController } from './win11-dwm';
import { WasapiLoopbackManager } from './wasapi-loopback';

let mainWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
let taskbarDwmController: Win11TaskbarDwmController | null = null;
const wasapiManager = new WasapiLoopbackManager();

let explicitlySelectedSourceId: string | null = null;

const windowRoles = new WeakMap<BrowserWindow, DesktopWindowRole>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    width: 1120,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    title: 'Elm-AnyDesk — Local Windows 11 Prototype',
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
    width: 420,
    height: 580,
    minWidth: 340,
    minHeight: 420,
    title: 'Elm-AnyDesk — Private 1:1 Session Chat (Prototype)',
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

function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        if (!explicitlySelectedSourceId) {
          // Never auto-select a screen source without User A's explicit choice
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
        'Phase 2 — Local Windows 11 Prototype (Taskbar/DWM & Media Capture)',
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
  // Allow local media permissions for explicit microphone & display capture tests;
  // strictly deny notifications and all other permissions.
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

    // 1. Open state telemetry
    const openState = taskbarDwmController.getTelemetry();

    // 2. Minimize state + DWM thumbnail/peek callback verification
    win.minimize();
    await sleep(250);
    const minimizedState =
      taskbarDwmController.triggerIconicThumbnailVerification();

    // 3. Restore state telemetry
    await sleep(150);
    win.restore();
    win.focus();
    await sleep(250);
    const restoredState = taskbarDwmController.getTelemetry();

    // 4-7. Renderer media & track verification
    const mediaSuiteResult = await win.webContents.executeJavaScript(`
      (async () => {
        const results = {};

        // A. Explicit source enumeration & Screen Video capture + playback
        const sources = await window.elmDesktop.listShareableSources();
        const onlyScreenOrWindow = sources.every(
          (s) => s.surfaceType === 'display' || s.surfaceType === 'window'
        );
        results.sourceEnumeration = {
          count: sources.length,
          onlyScreenOrWindow,
          sampleSources: sources.slice(0, 3).map((s) => ({
            id: s.id,
            name: s.name,
            surfaceType: s.surfaceType,
          })),
        };

        if (sources.length > 0) {
          await window.elmDesktop.selectShareableSource(sources[0].id);
          const screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false,
          });
          const vTrack = screenStream.getVideoTracks()[0];
          const vidEl = document.createElement('video');
          vidEl.muted = true;
          vidEl.playsInline = true;
          vidEl.srcObject = screenStream;
          await vidEl.play();
          await new Promise((r) => setTimeout(r, 350));

          results.screenVideoCapture = {
            ok: Boolean(vTrack && vTrack.readyState === 'live' && vidEl.videoWidth > 0),
            trackId: vTrack?.id ?? null,
            kind: vTrack?.kind ?? null,
            label: vTrack?.label ?? null,
            readyState: vTrack?.readyState ?? null,
            videoWidth: vidEl.videoWidth,
            videoHeight: vidEl.videoHeight,
            paused: vidEl.paused,
            currentTime: vidEl.currentTime,
          };

          screenStream.getTracks().forEach((t) => t.stop());
          results.screenVideoCapture.stoppedState = vTrack?.readyState ?? null;
        }

        // B. Microphone capture & playback check
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
          const mTrack = micStream.getAudioTracks()[0];
          const micEl = document.createElement('audio');
          micEl.muted = true;
          micEl.srcObject = micStream;
          await micEl.play();
          await new Promise((r) => setTimeout(r, 250));
          results.microphoneCapture = {
            ok: Boolean(mTrack && mTrack.readyState === 'live'),
            trackId: mTrack?.id ?? null,
            kind: mTrack?.kind ?? null,
            label: mTrack?.label ?? null,
            readyState: mTrack?.readyState ?? null,
            videoTracksCount: micStream.getVideoTracks().length,
            paused: micEl.paused,
          };
          micStream.getTracks().forEach((t) => t.stop());
        } catch (err) {
          results.microphoneCapture = {
            ok: false,
            error: err instanceof Error ? err.name + ': ' + err.message : String(err),
          };
        }

        // C. Electron getDisplayMedia with Screen Video OFF (video: false, audio: true)
        try {
          const s = await navigator.mediaDevices.getDisplayMedia({
            video: false,
            audio: true,
          });
          s.getTracks().forEach((t) => t.stop());
          results.electronAudioOnlyDisplayMedia = {
            supportedNativelyWithVideoOff: true,
          };
        } catch (err) {
          results.electronAudioOnlyDisplayMedia = {
            supportedNativelyWithVideoOff: false,
            error: err instanceof Error ? err.name + ': ' + err.message : String(err),
          };
        }

        // D. Windows-native WASAPI Loopback with Screen Video OFF
        const audioCtx = new AudioContext({ sampleRate: 48000 });
        await audioCtx.resume();
        const dest = audioCtx.createMediaStreamDestination();
        let nextTime = audioCtx.currentTime;
        let chunks = 0;
        let maxRms = 0;
        let maxPeak = 0;

        const unsub = window.elmDesktop.onWasapiAudioChunk((chunk) => {
          chunks += 1;
          if (chunk.rms > maxRms) maxRms = chunk.rms;
          if (chunk.peak > maxPeak) maxPeak = chunk.peak;

          const bin = window.atob(chunk.pcmFloat32Base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const floats = new Float32Array(bytes.buffer);
          const buf = audioCtx.createBuffer(1, floats.length, chunk.sampleRate || 48000);
          buf.copyToChannel(floats, 0);
          const src = audioCtx.createBufferSource();
          src.buffer = buf;
          src.connect(dest);
          const now = audioCtx.currentTime;
          if (nextTime < now) nextTime = now + 0.015;
          src.start(nextTime);
          nextTime += buf.duration;
        });

        const wasapiStart = await window.elmDesktop.startWasapiLoopback({
          playTestTone: true,
        });
        const player = document.createElement('audio');
        player.muted = true;
        player.srcObject = dest.stream;
        await player.play();

        await new Promise((r) => setTimeout(r, 650));

        const wasapiTrack = dest.stream.getAudioTracks()[0];
        results.wasapiLoopbackWithVideoOff = {
          ok: Boolean(
            wasapiStart.ok &&
              wasapiTrack &&
              wasapiTrack.readyState === 'live' &&
              chunks > 5 &&
              maxPeak > 0.02
          ),
          endpoint: wasapiStart,
          trackId: wasapiTrack?.id ?? null,
          kind: wasapiTrack?.kind ?? null,
          readyState: wasapiTrack?.readyState ?? null,
          videoTracksCount: dest.stream.getVideoTracks().length,
          chunksReceived: chunks,
          maxRms: Number(maxRms.toFixed(6)),
          maxPeak: Number(maxPeak.toFixed(6)),
          audioElementPaused: player.paused,
          audioElementCurrentTime: Number(player.currentTime.toFixed(3)),
        };

        unsub();
        await window.elmDesktop.stopWasapiLoopback();
        await audioCtx.close();

        return results;
      })();
    `);

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
      mediaSuite: mediaSuiteResult,
    };

    console.log('===PROTOTYPE_SUITE_JSON_START===');
    console.log(JSON.stringify(report, null, 2));
    console.log('===PROTOTYPE_SUITE_JSON_END===');
  } catch (err) {
    console.error('Prototype suite failed:', err);
    process.exitCode = 1;
  } finally {
    wasapiManager.stopCapture();
    app.quit();
  }
}

app.on('before-quit', () => {
  wasapiManager.stopCapture();
});

app.on('window-all-closed', () => {
  wasapiManager.stopCapture();
  app.quit();
});
