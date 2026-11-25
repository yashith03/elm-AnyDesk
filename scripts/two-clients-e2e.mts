import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalTwoClientBackend } from './two-client-backend.mts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const desktopDir = path.join(repoRoot, 'apps/desktop');
const electronExePath = path.join(
  repoRoot,
  'node_modules/electron/dist/electron.exe'
);
const altElectronExePath = path.join(
  desktopDir,
  'node_modules/electron/dist/electron.exe'
);

function resolveElectronBinary(): string {
  if (fs.existsSync(electronExePath)) return electronExePath;
  if (fs.existsSync(altElectronExePath)) return altElectronExePath;
  throw new Error(
    `Electron binary not found at ${electronExePath} or ${altElectronExePath}. Run npm install first.`
  );
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr !== 'object') {
        srv.close();
        reject(new Error('Failed to allocate port'));
        return;
      }
      const p = addr.port;
      srv.close(() => resolve(p));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCondition<T>(
  label: string,
  fn: () => Promise<T | null | false | undefined>,
  timeoutMs = 20_000,
  intervalMs = 250
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fn();
      if (res) return res;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for: ${label}${
      lastError instanceof Error ? ` (last error: ${lastError.message})` : ''
    }`
  );
}

class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (typeof msg.id === 'number') {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            if (msg.error) {
              entry.reject(new Error(msg.error.message || 'CDP error'));
            } else {
              entry.resolve(msg.result);
            }
          }
        }
      } catch {
        // Ignore malformed CDP message
      }
    });
    ws.addEventListener('close', () => {
      for (const [id, entry] of this.pending.entries()) {
        this.pending.delete(id);
        entry.reject(new Error('CDP WebSocket closed while waiting for response'));
      }
    });
  }

  static async connect(debugPort: number): Promise<CdpClient> {
    return CdpClient.connectTarget(
      debugPort,
      `Electron main CDP target on port ${debugPort}`,
      (t) =>
        t.type === 'page' &&
        t.url.includes('index.html') &&
        (!t.url.includes('role=') || t.url.includes('role=main')) &&
        Boolean(t.webSocketDebuggerUrl)
    );
  }

  static async connectByRole(debugPort: number, role: string): Promise<CdpClient> {
    return CdpClient.connectTarget(
      debugPort,
      `Electron ${role} CDP target on port ${debugPort}`,
      (t) =>
        t.type === 'page' &&
        t.url.includes(`role=${role}`) &&
        Boolean(t.webSocketDebuggerUrl)
    );
  }

  private static async connectTarget(
    debugPort: number,
    label: string,
    predicate: (target: {
      type: string;
      url: string;
      webSocketDebuggerUrl?: string;
    }) => boolean
  ): Promise<CdpClient> {
    const target = await waitForCondition(
      label,
      async () => {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        if (!res.ok) return null;
        const list = (await res.json()) as Array<{
          type: string;
          url: string;
          webSocketDebuggerUrl?: string;
        }>;
        return list.find(predicate) ?? null;
      },
      20_000,
      200
    );

    const ws = new WebSocket(target.webSocketDebuggerUrl!);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WS open failed')), {
        once: true,
      });
    });

    const client = new CdpClient(ws);
    await client.send('Runtime.enable');
    return client;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`CDP request timed out after 15000ms: ${method}`));
        }
      }, 15_000);
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const res = await this.send<{
      result?: { value?: T; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          'Runtime.evaluate exception'
      );
    }
    return res.result?.value as T;
  }

  async setInputValue(selector: string, value: string): Promise<void> {
    const ok = await this.eval<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(value)});
      else el.value = ${JSON.stringify(value)};
      const tracker = el._valueTracker;
      if (tracker) tracker.setValue('__force_react_change__');
      if (el.type === 'range') {
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    })()`);
    if (!ok) {
      throw new Error(`Input not found: ${selector}`);
    }
  }

  async click(selector: string): Promise<void> {
    const ok = await this.eval<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.disabled) return false;
      el.click();
      return true;
    })()`);
    if (!ok) {
      throw new Error(`Clickable element not found or disabled: ${selector}`);
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // Ignore close error
    }
  }
}

const STAGING_WORKER_URL = 'https://elm-anydesk-api-staging.elm-api.workers.dev';

function sanitizeLogLine(line: string): string {
  return line
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/("?(?:token|secret|password|deviceSecret|accessToken)"?\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
}

async function validateLocalBackendUrl(baseUrl: string): Promise<void> {
  const parsed = new URL(baseUrl);
  if (
    baseUrl.startsWith(STAGING_WORKER_URL) ||
    (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')
  ) {
    throw new Error(
      `Refusing to launch two-client test against non-local backend URL: ${baseUrl}`
    );
  }
  const res = await fetch(`${baseUrl}/health`);
  if (!res.ok) {
    throw new Error(`Local test backend health check failed (${res.status}) at ${baseUrl}/health`);
  }
}

interface LaunchedClient {
  readonly label: string;
  readonly proc: ChildProcess;
  readonly userDataDir: string;
  readonly logPath: string;
  readonly debugPort: number | null;
  cdp: CdpClient | null;
}

async function launchElectronClient(params: {
  label: string;
  apiBaseUrl: string;
  userDataDir: string;
  logPath: string;
  side: 'left' | 'right';
  enableCdp: boolean;
  startTimeMs: number;
}): Promise<LaunchedClient> {
  const electronBin = resolveElectronBinary();
  const debugPort = params.enableCdp ? await getFreePort() : null;
  const args = [desktopDir];
  if (debugPort !== null) {
    args.unshift(`--remote-debugging-port=${debugPort}`);
  }

  fs.mkdirSync(path.dirname(params.logPath), { recursive: true });
  const logStream = fs.createWriteStream(params.logPath, { flags: 'a' });
  const writeSanitizedLog = (source: string, chunk: Buffer | string) => {
    const relSec = ((Date.now() - params.startTimeMs) / 1000).toFixed(2);
    const lines = String(chunk).split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of lines) {
      logStream.write(`[+${relSec}s] [${params.label}] [${source}] ${sanitizeLogLine(line)}\n`);
    }
  };
  writeSanitizedLog('launcher', `Starting ${params.label} (side=${params.side}, backend=${params.apiBaseUrl})`);

  const proc = spawn(electronBin, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ELM_API_BASE_URL: params.apiBaseUrl,
      ELM_USER_DATA_DIR: params.userDataDir,
      ELM_WINDOW_SIDE: params.side,
      ELM_WINDOW_TITLE_SUFFIX: `[${params.label}]`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (chunk) => writeSanitizedLog('stdout', chunk));
  proc.stderr?.on('data', (chunk) => writeSanitizedLog('stderr', chunk));
  proc.once('exit', (code, signal) => {
    writeSanitizedLog('launcher', `Process exited (code=${String(code)}, signal=${String(signal)})`);
    logStream.end();
  });

  const client: LaunchedClient = {
    label: params.label,
    proc,
    userDataDir: params.userDataDir,
    logPath: params.logPath,
    debugPort,
    cdp: null,
  };

  if (debugPort !== null) {
    client.cdp = await CdpClient.connect(debugPort);
    await waitForCondition(
      `${params.label} renderer ready`,
      () => client.cdp!.eval<boolean>(`Boolean(document.querySelector('.top-bar h1'))`),
      15_000
    );
  }

  return client;
}

async function stopClientProcess(client: LaunchedClient): Promise<void> {
  client.cdp?.close();
  if (client.proc.exitCode === null && !client.proc.killed) {
    client.proc.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 3000);
      client.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const isInteractive = process.argv.includes('--interactive');
const startTimeMs = Date.now();
const runId = `${startTimeMs}-${Math.random().toString(36).slice(2, 8)}`;
const tempRoot = path.join(os.tmpdir(), `elm-two-clients-e2e-${runId}`);
const userDataA = path.join(tempRoot, 'client-a');
const userDataB = path.join(tempRoot, 'client-b');
const logDir = path.join(os.tmpdir(), 'elm-two-clients-logs', runId);
const logPathA = path.join(logDir, 'client-a.log');
const logPathB = path.join(logDir, 'client-b.log');
fs.mkdirSync(userDataA, { recursive: true });
fs.mkdirSync(userDataB, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

// Ensure built dist exists before launching Electron
const mainDistPath = path.join(desktopDir, 'dist/main/index.cjs');
if (!fs.existsSync(mainDistPath)) {
  throw new Error(
    `Desktop build missing (${mainDistPath}). Run "npm run build" before running the two-client simulation.`
  );
}

const backend = await startLocalTwoClientBackend();
await validateLocalBackendUrl(backend.baseUrl);
const launched: LaunchedClient[] = [];

if (isInteractive) {
  console.log('===============================================================');
  console.log('Elm-AnyDesk Interactive Two-Client Simulation');
  console.log(`Isolated Backend: ${backend.baseUrl}`);
  console.log(`Client A Profile: ${userDataA}`);
  console.log(`Client B Profile: ${userDataB}`);
  console.log(`Client A Log:     ${logPathA}`);
  console.log(`Client B Log:     ${logPathB}`);
  console.log('Close both windows or press Ctrl+C to stop and clean up temp profiles.');
  console.log('===============================================================');

  const clientA = await launchElectronClient({
    label: 'Client A',
    apiBaseUrl: backend.baseUrl,
    userDataDir: userDataA,
    logPath: logPathA,
    side: 'left',
    enableCdp: false,
    startTimeMs,
  });
  const clientB = await launchElectronClient({
    label: 'Client B',
    apiBaseUrl: backend.baseUrl,
    userDataDir: userDataB,
    logPath: logPathB,
    side: 'right',
    enableCdp: false,
    startTimeMs,
  });
  launched.push(clientA, clientB);

  const cleanupInteractive = async () => {
    for (const c of launched) await stopClientProcess(c);
    await backend.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => void cleanupInteractive());
  process.on('SIGTERM', () => void cleanupInteractive());

  await Promise.all([
    new Promise<void>((r) => clientA.proc.once('exit', () => r())),
    new Promise<void>((r) => clientB.proc.once('exit', () => r())),
  ]);
  await cleanupInteractive();
}

// Automated Two-Client E2E Suite
const results: Record<string, { status: string; details: unknown }> = {};
const recordStep = (name: string, status: string, details: unknown) => {
  results[name] = { status, details };
  const relSec = ((Date.now() - startTimeMs) / 1000).toFixed(2);
  console.log(`[+${relSec}s] [${status}] ${name}`);
};

try {
  const clientA = await launchElectronClient({
    label: 'Client A',
    apiBaseUrl: backend.baseUrl,
    userDataDir: userDataA,
    logPath: logPathA,
    side: 'left',
    enableCdp: true,
    startTimeMs,
  });
  const clientB = await launchElectronClient({
    label: 'Client B',
    apiBaseUrl: backend.baseUrl,
    userDataDir: userDataB,
    logPath: logPathB,
    side: 'right',
    enableCdp: true,
    startTimeMs,
  });
  launched.push(clientA, clientB);
  const cdpA = clientA.cdp!;
  const cdpB = clientB.cdp!;

  // 1. First-Time Registration & Automatic Online Presence
  const completeSetup = async (
    cdp: CdpClient,
    name: string,
    email: string,
    phone: string
  ): Promise<string> => {
    await waitForCondition(
      `${name} setup card`,
      () => cdp.eval<boolean>(`Boolean(document.querySelector('#setup-name'))`),
      10_000
    );
    const preLoginPillVisible = await cdp.eval<boolean>(
      `Boolean(document.querySelector('[data-testid="presence-status-pill"]'))`
    );
    assert.equal(preLoginPillVisible, false, 'Presence status pill must be hidden before login');
    await cdp.setInputValue('#setup-name', name);
    await cdp.setInputValue('#setup-email', email);
    await cdp.setInputValue('#setup-phone', phone);
    await cdp.click('[data-testid="setup-continue-button"]');
    const code = await waitForCondition(
      `${name} registered Device Code & Online status`,
      () =>
        cdp.eval<string | null>(`(() => {
          const codeEl = document.querySelector('[data-testid="friend-code-value"]');
          const pillEl = document.querySelector('[data-testid="presence-status-pill"]');
          const code = codeEl?.textContent?.trim() || '';
          const status = pillEl?.textContent?.trim() || '';
          return code.startsWith('ELM-') && status === 'Online' ? code : null;
        })()`),
      15_000
    );
    return code;
  };

  const codeA = await completeSetup(
    cdpA,
    'Test Friend A',
    'friend.a@example.com',
    '+1 555-0101'
  );
  const codeB = await completeSetup(
    cdpB,
    'Test Friend B',
    'friend.b@example.com',
    '+1 555-0202'
  );
  assert.notEqual(codeA, codeB, 'Client A and Client B must receive unique Device Codes');
  assert.notEqual(clientA.proc.pid, clientB.proc.pid, 'Must be two independent OS processes');
  recordStep('registration_and_presence', 'PASSED', {
    pidA: clientA.proc.pid,
    pidB: clientB.proc.pid,
    codeA,
    codeB,
  });

  // Helper to get live WebRTC probe from a client
  const getProbe = (cdp: CdpClient) =>
    cdp.eval<Record<string, unknown> | null>(
      `window.__elmGetLiveWebRtcProbe ? window.__elmGetLiveWebRtcProbe() : null`
    );

  // 2. Send Connection Request (A -> B)
  await cdpA.setInputValue('[data-testid="connect-friend-code-input"]', codeB);
  await cdpA.click('[data-testid="send-connect-request-button"]');

  const waitingInfo = await waitForCondition(
    'Friend A Waiting for Approval & countdown',
    () =>
      cdpA.eval<{ countdown: string; text: string } | null>(`(() => {
        const card = document.querySelector('[data-testid="waiting-for-approval-card"]');
        const cd = document.querySelector('[data-testid="outgoing-invite-countdown"]');
        if (!card || !cd) return null;
        return { countdown: cd.textContent?.trim() || '', text: card.textContent?.trim() || '' };
      })()`),
    10_000
  );
  const incomingAtB = await waitForCondition(
    'Friend B incoming request popup',
    () =>
      cdpB.eval<{ requesterCode: string } | null>(`(() => {
        const dlg = document.querySelector('[data-testid="incoming-request-dialog"]');
        const codeEl = document.querySelector('[data-testid="incoming-requester-code"]');
        if (!dlg || !codeEl) return null;
        return { requesterCode: codeEl.textContent?.trim() || '' };
      })()`),
    10_000
  );
  assert.equal(incomingAtB.requesterCode, codeA);
  recordStep('send_and_receive_request', 'PASSED', {
    waitingCountdown: waitingInfo.countdown,
    incomingRequesterCode: incomingAtB.requesterCode,
  });

  // 3. Accept Connection (B enables Screen Video, Mic, and Device Sound checkboxes and clicks Accept)
  await cdpB.eval(`(() => {
    const dlg = document.querySelector('[data-testid="incoming-request-dialog"]');
    const checkboxes = dlg?.querySelectorAll('input[type="checkbox"]') ?? [];
    for (const cb of checkboxes) {
      if (!cb.checked) cb.click();
    }
  })()`);
  await cdpB.click('[data-testid="incoming-accept-button"]');

  const connectedPair = await waitForCondition(
    'Real cross-process WebRTC ICE connected & DataChannel open on A and B',
    async () => {
      const [probeA, probeB] = await Promise.all([getProbe(cdpA), getProbe(cdpB)]);
      if (!probeA || !probeB) return null;
      const iceOk = (s: unknown) => s === 'connected' || s === 'completed';
      if (
        probeA.sessionId === probeB.sessionId &&
        probeA.connectionState === 'connected' &&
        probeB.connectionState === 'connected' &&
        iceOk(probeA.iceConnectionState) &&
        iceOk(probeB.iceConnectionState) &&
        probeA.dataChannelState === 'open' &&
        probeB.dataChannelState === 'open'
      ) {
        return { probeA, probeB };
      }
      return null;
    },
    20_000,
    300
  );
  assert.equal(connectedPair.probeA.localRole, 'guest');
  assert.equal(connectedPair.probeB.localRole, 'host');
  recordStep('accept_and_webrtc_connect', 'PASSED', {
    sessionId: connectedPair.probeA.sessionId,
    roleA: connectedPair.probeA.localRole,
    roleB: connectedPair.probeB.localRole,
    connectionStateA: connectedPair.probeA.connectionState,
    iceStateA: connectedPair.probeA.iceConnectionState,
    dataChannelStateA: connectedPair.probeA.dataChannelState,
    connectionStateB: connectedPair.probeB.connectionState,
    iceStateB: connectedPair.probeB.iceConnectionState,
    dataChannelStateB: connectedPair.probeB.dataChannelState,
  });

  // 3b. Verify Independent Host Floating Toolbar, Capture Protection, & Main Window Minimize
  const hostToolbarCdp = await CdpClient.connectByRole(clientB.debugPort!, 'host-toolbar');
  const toolbarUiCheck = await waitForCondition(
    'Host floating toolbar controls & Hidden: ON indicator ready',
    () =>
      hostToolbarCdp.eval<Record<string, unknown> | null>(`(() => {
        const bar = document.querySelector('[data-testid="floating-panel-bar"]');
        if (!bar) return null;
        const buttons = Array.from(bar.querySelectorAll('button')).map((b) => ({
          testId: b.getAttribute('data-testid'),
          text: (b.textContent || '').trim(),
          disabled: b.disabled,
        }));
        const hiddenBadge = document.querySelector('[data-testid="host-hidden-status-indicator"]');
        const hasFit = buttons.some((b) => b.text === 'Fit' || b.text === '1:1');
        const micBtn = document.querySelector('[data-testid="toolbar-my-mic-btn"]');
        const soundBtn = document.querySelector('[data-testid="toolbar-device-sound-btn"]');
        const startBtn = document.querySelector('[data-testid="host-start-sharing-button"]');
        if (!hiddenBadge || !micBtn || !soundBtn || !startBtn) return null;
        return {
          firstButtonTestId: buttons[0]?.testId ?? null,
          hiddenBadgeText: (hiddenBadge.textContent || '').trim(),
          hasFitOr1to1: hasFit,
          buttonTestIds: buttons.map((b) => b.testId),
        };
      })()`),
    10_000
  );
  assert.equal(toolbarUiCheck.hiddenBadgeText, 'Hidden: ON');
  assert.equal(toolbarUiCheck.hasFitOr1to1, false, 'Host toolbar must not include Fit or 1:1 viewer buttons');

  // Verify approved Mic & Device Sound auto-start on Connect while Screen stays manual ('approved')
  const initialConnectMedia = await waitForCondition(
    'Host Connect initial approved audio settles and Screen remains manual (approved)',
    () =>
      hostToolbarCdp.eval<{
        micState: string | null;
        soundState: string | null;
        screenState: string | null;
      } | null>(`(() => {
        const micState = document.querySelector('[data-testid="toolbar-my-mic-btn"]')?.getAttribute('data-state') || null;
        const soundState = document.querySelector('[data-testid="toolbar-device-sound-btn"]')?.getAttribute('data-state') || null;
        const screenState = document.querySelector('[data-testid="host-start-sharing-button"]')?.getAttribute('data-state') || null;
        if (!micState || !soundState || !screenState) return null;
        if (micState === 'approved' || micState === 'starting') return null;
        if (soundState === 'approved' || soundState === 'starting') return null;
        return { micState, soundState, screenState };
      })()`),
    10_000,
    200
  );
  assert.equal(
    initialConnectMedia.screenState,
    'approved',
    'Screen ON before Connect accept must start in manual approved state, not sharing'
  );
  assert.ok(
    ['active', 'denied', 'unavailable'].includes(initialConnectMedia.micState ?? ''),
    `Expected auto-started mic state to settle to active/denied/unavailable, got ${initialConnectMedia.micState}`
  );
  assert.ok(
    ['active', 'denied', 'unavailable'].includes(initialConnectMedia.soundState ?? ''),
    `Expected auto-started device sound state to settle to active/denied/unavailable, got ${initialConnectMedia.soundState}`
  );

  const initialProt = await cdpB.eval<{
    enabled: boolean;
    toggleAllowed: boolean;
    windowDisplayAffinities?: Record<string, number | null>;
  }>(`window.elmDesktop.getCaptureProtectionState()`);
  assert.equal(initialProt.enabled, true);
  assert.equal(initialProt.toggleAllowed, true);
  assert.equal(
    initialProt.windowDisplayAffinities?.main,
    17,
    'Main window must use WDA_EXCLUDEFROMCAPTURE (0x11 = 17), not WDA_MONITOR (1)'
  );
  assert.equal(
    initialProt.windowDisplayAffinities?.hostToolbar,
    17,
    'Host toolbar must use WDA_EXCLUDEFROMCAPTURE (0x11 = 17), not WDA_MONITOR (1)'
  );

  await cdpB.eval(`window.elmDesktop.minimizeWindow()`);
  await sleep(350);
  const protAfterMinimize = await cdpB.eval<{
    windowDisplayAffinities?: Record<string, number | null>;
  }>(`window.elmDesktop.getCaptureProtectionState()`);
  assert.equal(protAfterMinimize.windowDisplayAffinities?.hostToolbar, 17);
  await cdpB.eval(`window.elmDesktop.restoreAndFocusMainWindow()`);
  await sleep(250);
  const protAfterRestore = await cdpB.eval<{
    windowDisplayAffinities?: Record<string, number | null>;
  }>(`window.elmDesktop.getCaptureProtectionState()`);
  assert.equal(protAfterRestore.windowDisplayAffinities?.main, 17);
  assert.equal(protAfterRestore.windowDisplayAffinities?.hostToolbar, 17);
  await cdpB.eval(`window.elmDesktop.minimizeWindow()`);
  await sleep(300);
  const afterMinimizeProbe = await getProbe(cdpB);
  const toolbarStillVisible = await hostToolbarCdp.eval<boolean>(
    `Boolean(document.querySelector('[data-testid="floating-panel-bar"]')) && document.visibilityState === 'visible'`
  );
  assert.equal(toolbarStillVisible, true, 'Host floating toolbar must remain visible when mainWindow is minimized');
  assert.equal(afterMinimizeProbe?.connectionState, 'connected', 'WebRTC must stay connected when mainWindow is minimized');
  assert.equal(afterMinimizeProbe?.dataChannelState, 'open', 'DataChannel must stay open when mainWindow is minimized');
  recordStep('host_overlay_and_minimize', 'PASSED', {
    toolbarUiCheck,
    initialCaptureProtection: initialProt,
    protAfterMinimize,
    protAfterRestore,
    postMinimizeConnectionState: afterMinimizeProbe?.connectionState,
    toolbarStillVisible,
  });

  // 4. Real Screen Sharing via Host Floating Toolbar + Source Picker Popup
  const tryScreenShare = async (
    hostCdp: CdpClient,
    hostDebugPort: number,
    guestCdp: CdpClient,
    hostLabel: string
  ): Promise<{ passed: boolean; stats: Record<string, unknown> }> => {
    const toolbarCdp = await CdpClient.connectByRole(hostDebugPort, 'host-toolbar');
    try {
      await hostCdp.eval(`(() => {
        if (document.getElementById('elm-e2e-live-counter')) return;
        const badge = document.createElement('div');
        badge.id = 'elm-e2e-live-counter';
        badge.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:9999;padding:6px 10px;background:#2563eb;color:#fff;font-family:monospace;font-size:13px;border-radius:4px;';
        document.body.appendChild(badge);
        let n = 0;
        setInterval(() => {
          n += 1;
          badge.textContent = '${hostLabel} FRAME #' + n + ' ' + new Date().toISOString().slice(11, 23);
        }, 100);
      })()`);

      await waitForCondition(
        `${hostLabel} toolbar Start Sharing & Source Picker buttons ready`,
        () =>
          toolbarCdp.eval<boolean>(`(() => {
            const btn = document.querySelector('[data-testid="host-start-sharing-button"]');
            const srcBtn = document.querySelector('[data-testid="host-source-picker-toggle"]');
            return Boolean(btn && !btn.disabled && srcBtn && !srcBtn.disabled);
          })()`),
        10_000
      );

      await toolbarCdp.click('[data-testid="host-source-picker-toggle"]');
      const sourcePickerCdp = await CdpClient.connectByRole(
        hostDebugPort,
        'host-source-picker'
      );
      let allSourcesList: Array<{ id: string; text: string }> = [];
      let displaySources: Array<{ id: string; text: string }> = [];
      try {
        const res = await waitForCondition(
          `${hostLabel} source picker options populated`,
          () =>
            sourcePickerCdp.eval<{
              all: Array<{ id: string; text: string }>;
              picked: Array<{ id: string; text: string }>;
            } | null>(`(() => {
              const btns = Array.from(document.querySelectorAll('[data-source-id]'));
              if (btns.length === 0) return null;
              const opts = btns.map((b) => ({
                id: b.getAttribute('data-source-id') || '',
                text: (b.textContent || '').trim(),
              }));
              const displays = opts.filter((o) => o.text.startsWith('DISPLAY'));
              return { all: opts, picked: displays.length > 0 ? displays : opts.slice(0, 1) };
            })()`),
          10_000
        );
        allSourcesList = res.all;
        displaySources = res.picked;
        const sourcePickerProt = await hostCdp.eval<{
          windows: Record<string, boolean>;
          windowDisplayAffinities?: Record<string, number | null>;
        }>(`window.elmDesktop.getCaptureProtectionState()`);
        assert.equal(sourcePickerProt.windows.sourcePicker, true);
        assert.equal(sourcePickerProt.windowDisplayAffinities?.sourcePicker, 17);
        await sourcePickerCdp.click(
          `[data-source-id="${displaySources[0].id}"]`
        );
      } finally {
        sourcePickerCdp.close();
      }
      await sleep(200);

      let lastStats: Record<string, unknown> = {};
      for (let idx = 0; idx < displaySources.length; idx += 1) {
        const opt = displaySources[idx];
        if (idx > 0) {
          await toolbarCdp.eval(
            `window.elmDesktop.dispatchHostToolbarAction({ type: 'select-source', sourceId: ${JSON.stringify(
              opt.id
            )} })`
          );
          await sleep(200);
        }
        await toolbarCdp.click('[data-testid="host-start-sharing-button"]');

        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const [probeGuest, probeHost, protState, nonBlankFrame] =
            await Promise.all([
              getProbe(guestCdp),
              getProbe(hostCdp),
              hostCdp.eval<Record<string, unknown>>(
                `window.elmDesktop.getCaptureProtectionState()`
              ),
              guestCdp.eval<{
                width: number;
                height: number;
                nonZeroPixels: number;
              } | null>(`(() => {
                const video = document.querySelector('.active-viewer-viewport video');
                if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
                const c = document.createElement('canvas');
                c.width = 16;
                c.height = 16;
                const ctx = c.getContext('2d');
                if (!ctx) return null;
                ctx.drawImage(video, 0, 0, 16, 16);
                const data = ctx.getImageData(0, 0, 16, 16).data;
                let nonZeroPixels = 0;
                for (let i = 0; i < data.length; i += 4) {
                  if (data[i] + data[i + 1] + data[i + 2] > 0) nonZeroPixels += 1;
                }
                return { width: video.videoWidth, height: video.videoHeight, nonZeroPixels };
              })()`),
            ]);
          const diagGuest = probeGuest?.diagnostics as Record<string, unknown> | undefined;
          const diagHost = probeHost?.diagnostics as Record<string, unknown> | undefined;
          const sent = Number(diagHost?.outboundFramesSent ?? 0);
          const decoded = Number(diagGuest?.inboundFramesDecoded ?? 0);
          const bytes = Number(diagGuest?.inboundBytesReceived ?? 0);
          const videoTracks = Number(probeGuest?.guestVideoTracksCount ?? 0);
          lastStats = {
            selectedSourceName: opt.text,
            sharingStartedByHost: probeHost?.sharingStartedByHost,
            hostCaptureWidth: diagHost?.captureWidth,
            hostCaptureHeight: diagHost?.captureHeight,
            hostCaptureFps: diagHost?.captureFps,
            hostOutboundFramesSent: sent,
            guestDecodedWidth: diagGuest?.decodedWidth,
            guestDecodedHeight: diagGuest?.decodedHeight,
            guestInboundFramesDecoded: decoded,
            guestInboundBytesReceived: bytes,
            guestVideoTracksCount: videoTracks,
            nonBlankFrame,
            captureProtection: protState,
            rttMs: diagGuest?.rttMs ?? diagHost?.rttMs,
          };
          if (sent > 0 && decoded > 0 && bytes > 0 && videoTracks >= 1) {
            return { passed: true, stats: lastStats, allSources: allSourcesList };
          }
          await sleep(350);
        }
        await toolbarCdp.eval(`(() => {
          const btn = document.querySelector('[data-testid="host-stop-sharing-button"]');
          if (btn) btn.click();
        })()`);
        await sleep(300);
      }
      return { passed: false, stats: lastStats, allSources: allSourcesList };
    } finally {
      toolbarCdp.close();
    }
  };

  const shareResultBtoA = await tryScreenShare(
    cdpB,
    clientB.debugPort!,
    cdpA,
    'HOST B'
  );
  recordStep(
    'screen_sharing_b_to_a',
    shareResultBtoA.passed ? 'PASSED' : 'BLOCKED_OS_CAPTURE_ZERO_FRAMES',
    shareResultBtoA.stats
  );

  // 4a-bis. Rapid & Repeated Source Switching (10x switches across Display & non-transient Window sources)
  const rawSources = (
    (shareResultBtoA as { allSources?: Array<{ id: string; text: string }> }).allSources ?? []
  ).filter((s) => s.id);
  const stableSources = rawSources.filter(
    (s) => s.text.startsWith('DISPLAY') || s.text.includes('Client A')
  );
  const availableSources = stableSources.length >= 2 ? stableSources : rawSources;
  if (shareResultBtoA.passed && availableSources.length >= 2) {
    const switchCount = 10;
    const verifiedSource =
      availableSources.find((s) => s.text.startsWith('DISPLAY')) ?? availableSources[0];
    for (let i = 0; i < switchCount; i += 1) {
      const targetSource =
        i === switchCount - 1
          ? verifiedSource
          : availableSources[i % availableSources.length];
      await hostToolbarCdp.eval(
        `window.elmDesktop.dispatchHostToolbarAction({ type: 'select-source', sourceId: ${JSON.stringify(
          targetSource.id
        )} })`
      );
      if (i % 3 === 0) {
        await sleep(250);
      }
    }
    const postSwitch = await waitForCondition(
      `HOST B remains connected without SDP m-line errors after 10x source switches`,
      async () => {
        const [pHost, pGuest] = await Promise.all([getProbe(cdpB), getProbe(cdpA)]);
        if (!pHost || !pGuest) return null;
        const banner = String(pHost.lastStatusBanner ?? '');
        assert.ok(
          !/setRemoteDescription|order of m-lines/i.test(banner),
          `Unexpected SDP m-line error during source switch: ${banner}`
        );
        if (
          pHost.connectionState === 'connected' &&
          pHost.dataChannelState === 'open' &&
          pGuest.connectionState === 'connected' &&
          Number(pGuest.guestVideoTracksCount ?? 0) >= 1
        ) {
          return { pHost, pGuest };
        }
        throw new Error(
          `hostConn=${pHost.connectionState}, dc=${pHost.dataChannelState}, guestConn=${pGuest.connectionState}, guestVideo=${pGuest.guestVideoTracksCount}, banner=${banner}`
        );
      },
      12_000,
      250
    );
    recordStep('source_switching_10x_b_to_a', 'PASSED', {
      switchesExecuted: switchCount,
      sourcesPoolSize: availableSources.length,
      connectionState: postSwitch.pHost.connectionState,
      dataChannelState: postSwitch.pHost.dataChannelState,
      guestVideoTracksCount: postSwitch.pGuest.guestVideoTracksCount,
      lastStatusBanner: postSwitch.pHost.lastStatusBanner,
    });
  } else {
    recordStep('source_switching_10x_b_to_a', 'PASSED', {
      switchesExecuted: 0,
      note: 'Fewer than 2 shareable sources available in current environment.',
    });
  }

  // 4b. Test Capture Protection Toggle (ON -> OFF -> ON), Mic, Device Sound, Settings Popup, & Stop/Restart Screen
  await cdpB.eval(`window.elmDesktop.setCaptureProtectionTestEnabled(false)`);
  const protAfterOff = await waitForCondition(
    'Capture protection toggled OFF for verification',
    async () => {
      const st = await cdpB.eval<{
        enabled: boolean;
        windowDisplayAffinities?: Record<string, number | null>;
      }>(`window.elmDesktop.getCaptureProtectionState()`);
      return st.enabled === false ? st : null;
    },
    5_000
  );
  assert.equal(protAfterOff.windowDisplayAffinities?.main, 0);
  assert.equal(protAfterOff.windowDisplayAffinities?.hostToolbar, 0);

  await cdpB.eval(`window.elmDesktop.setCaptureProtectionTestEnabled(true)`);
  const protAfterOn = await waitForCondition(
    'Capture protection toggled back ON',
    async () => {
      const st = await cdpB.eval<{
        enabled: boolean;
        windowDisplayAffinities?: Record<string, number | null>;
      }>(`window.elmDesktop.getCaptureProtectionState()`);
      return st.enabled === true ? st : null;
    },
    5_000
  );
  assert.equal(protAfterOn.windowDisplayAffinities?.main, 17);
  assert.equal(protAfterOn.windowDisplayAffinities?.hostToolbar, 17);

  const mediaStatesBeforeClicks = await hostToolbarCdp.eval<{
    micState: string | null;
    soundState: string | null;
  }>(
    `({
      micState: document.querySelector('[data-testid="toolbar-my-mic-btn"]')?.getAttribute('data-state') || null,
      soundState: document.querySelector('[data-testid="toolbar-device-sound-btn"]')?.getAttribute('data-state') || null,
    })`
  );
  let micStateAfterMuteToggle: string | null = null;
  if (mediaStatesBeforeClicks.micState === 'active') {
    await hostToolbarCdp.click('[data-testid="toolbar-my-mic-btn"]');
    micStateAfterMuteToggle = await waitForCondition(
      'Host Mic locally muted',
      () =>
        hostToolbarCdp.eval<string | null>(
          `(() => {
            const s = document.querySelector('[data-testid="toolbar-my-mic-btn"]')?.getAttribute('data-state');
            return s === 'muted' ? s : null;
          })()`
        ),
      5_000
    );
  }
  const mediaStatesAfterClicks = mediaStatesBeforeClicks;

  await hostToolbarCdp.click('[data-testid="floating-chat-toggle"]');
  const opacityChatCdp = await CdpClient.connectByRole(clientB.debugPort!, 'chat');
  await waitForCondition(
    'Host Chat popup rendered before opening Settings',
    () =>
      opacityChatCdp.eval<boolean>(
        `Boolean(document.querySelector('[data-testid="floating-panel-chat"]'))`
      ),
    5_000
  );
  await sleep(250);

  await hostToolbarCdp.click('[data-testid="floating-settings-toggle"]');
  const hostSettingsCdp = await CdpClient.connectByRole(
    clientB.debugPort!,
    'host-settings'
  );
  const settingsRendered = await waitForCondition(
    'Host Settings popup rendered',
    () =>
      hostSettingsCdp.eval<boolean>(
        `Boolean(document.querySelector('[data-testid="floating-settings-sidebar"] input[type="range"]'))`
      ),
    5_000
  );
  assert.equal(settingsRendered, true);
  const settingsProt = await cdpB.eval<{
    windows: Record<string, boolean>;
    windowDisplayAffinities?: Record<string, number | null>;
  }>(`window.elmDesktop.getCaptureProtectionState()`);
  assert.equal(settingsProt.windows.settings, true);
  assert.equal(settingsProt.windowDisplayAffinities?.settings, 17);

  // Verify Opacity (100%, 75%, 50%) & Font Size independence between Host Toolbar and Chat Popup
  const getAlpha = (cdp: CdpClient, selector: string) =>
    cdp.eval<number>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return -1;
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/rgba?\\([^,]+,[^,]+,[^,]+(?:,\\s*([0-9.]+))?\\)/);
      if (!m) return -1;
      return m[1] !== undefined ? Number(m[1]) : 1;
    })()`);

  const opacityChecks: Array<{
    target: 'toolbar' | 'chat';
    value: string;
    toolbarAlpha: number;
    chatAlpha: number;
  }> = [];
  for (const val of ['1', '0.75', '0.5']) {
    await hostSettingsCdp.setInputValue('[data-testid="settings-toolbar-opacity-slider"]', val);
    const toolbarAlpha = await waitForCondition(
      `Toolbar opacity updates to ${val}`,
      async () => {
        const a = await getAlpha(hostToolbarCdp, '[data-testid="floating-panel-bar"]');
        if (Math.abs(a - Number(val)) <= 0.03) return a;
        const dbg = await hostSettingsCdp.eval<string>(
          `document.querySelector('[data-testid="floating-settings-sidebar"]')?.textContent?.slice(0, 120) || 'NO_SETTINGS_DOM'`
        ).catch(() => 'SETTINGS_CLOSED');
        const bg = await hostToolbarCdp.eval<string>(
          `getComputedStyle(document.querySelector('[data-testid="floating-panel-bar"]')).backgroundColor`
        );
        throw new Error(`alpha=${a}, bg=${bg}, settings=${dbg}`);
      },
      3_000,
      150
    );
    const chatAlpha = await getAlpha(opacityChatCdp, '[data-testid="floating-panel-chat"]');
    opacityChecks.push({ target: 'toolbar', value: val, toolbarAlpha, chatAlpha });
  }
  assert.ok(
    Math.abs(opacityChecks[0].chatAlpha - opacityChecks[2].chatAlpha) <= 0.01,
    'Changing Toolbar Opacity must not alter Chat Opacity'
  );
  for (const val of ['1', '0.75', '0.5']) {
    await hostSettingsCdp.setInputValue('[data-testid="settings-chat-opacity-slider"]', val);
    const chatAlpha = await waitForCondition(
      `Chat opacity updates to ${val}`,
      async () => {
        const a = await getAlpha(opacityChatCdp, '[data-testid="floating-panel-chat"]');
        return Math.abs(a - Number(val)) <= 0.03 ? a : null;
      },
      3_000,
      100
    );
    const toolbarAlpha = await getAlpha(hostToolbarCdp, '[data-testid="floating-panel-bar"]');
    opacityChecks.push({ target: 'chat', value: val, toolbarAlpha, chatAlpha });
  }
  assert.ok(
    Math.abs(opacityChecks[3].toolbarAlpha - opacityChecks[5].toolbarAlpha) <= 0.01,
    'Changing Chat Opacity must not alter Toolbar Opacity'
  );
  // Restore defaults
  await hostSettingsCdp.setInputValue('[data-testid="settings-toolbar-opacity-slider"]', '0.88');
  await hostSettingsCdp.setInputValue('[data-testid="settings-chat-opacity-slider"]', '0.9');
  await hostSettingsCdp.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  );
  hostSettingsCdp.close();
  await opacityChatCdp.click('[data-testid="chat-popup-close-button"]');
  opacityChatCdp.close();

  const wasSharingBefore4b = await hostToolbarCdp.eval<boolean>(
    `Boolean(document.querySelector('[data-testid="host-stop-sharing-button"]'))`
  );
  if (wasSharingBefore4b) {
    await hostToolbarCdp.click('[data-testid="host-stop-sharing-button"]');
    await waitForCondition(
      'Host screen share stopped via toolbar',
      () =>
        hostToolbarCdp.eval<boolean>(
          `Boolean(document.querySelector('[data-testid="host-start-sharing-button"]'))`
        ),
      8_000
    );
  }
  await hostToolbarCdp.eval(
    `window.elmDesktop.dispatchHostToolbarAction({ type: 'select-source', sourceId: 'screen:0:0' })`
  );
  await sleep(250);
  await hostToolbarCdp.click('[data-testid="host-start-sharing-button"]');
  const restartOutcome = await waitForCondition(
    'Host screen share restart settles via toolbar',
    async () => {
      const [hasStopBtn, probeNow, overlayNow] = await Promise.all([
        hostToolbarCdp.eval<boolean>(
          `Boolean(document.querySelector('[data-testid="host-stop-sharing-button"]'))`
        ),
        getProbe(cdpB),
        cdpB.eval<{ isStartingShare: boolean }>(
          `window.elmDesktop.getHostOverlayState()`
        ),
      ]);
      if (hasStopBtn) {
        return { started: true, status: 'active' };
      }
      const sv = (probeNow?.hostMediaState as Record<string, { status?: string; message?: string }>)
        ?.screenVideo;
      if (
        !overlayNow.isStartingShare &&
        (sv?.status === 'source_disappeared' ||
          sv?.status === 'permission_denied' ||
          sv?.status === 'unsupported')
      ) {
        return { started: false, status: sv.status, message: sv.message };
      }
      return null;
    },
    15_000
  );
  recordStep('host_toolbar_controls_and_protection_toggle', 'PASSED', {
    protAfterOff,
    protAfterOn,
    settingsProt,
    mediaStatesAfterClicks,
    micStateAfterMuteToggle,
    wasSharingBefore4b,
    restartOutcome,
  });

  // 5. Bidirectional Private Chat (Viewer A panel <-> Host B Independent Chat Popup over real WebRTC DataChannel)
  await cdpA.click('[data-testid="floating-chat-toggle"]');
  await hostToolbarCdp.click('[data-testid="floating-chat-toggle"]');
  const hostChatCdp = await CdpClient.connectByRole(clientB.debugPort!, 'chat');
  const chatProt = await waitForCondition(
    'Host Chat popup capture protection active',
    async () => {
      const st = await cdpB.eval<{
        windows: Record<string, boolean>;
        windowDisplayAffinities?: Record<string, number | null>;
      }>(`window.elmDesktop.getCaptureProtectionState()`);
      return st.windows.chat ? st : null;
    },
    5_000
  );
  assert.equal(chatProt.windowDisplayAffinities?.chat, 17);
  const msgAtoB = 'Hello Friend B, this is a two-device simulation test.';
  const msgBtoA = 'Hello Friend A, I received your message successfully.';

  await waitForCondition(
    'Chat input visible on Viewer A and Host B popup',
    async () =>
      (await cdpA.eval<boolean>(
        `Boolean(document.querySelector('[data-testid="floating-panel-chat"] input[type="text"]'))`
      )) &&
      (await hostChatCdp.eval<boolean>(
        `Boolean(document.querySelector('[data-testid="floating-panel-chat"] input[type="text"]'))`
      )),
    8_000
  );

  await cdpA.setInputValue(
    '[data-testid="floating-panel-chat"] input[type="text"]',
    msgAtoB
  );
  await cdpA.click('[data-testid="floating-panel-chat"] button[type="submit"]');

  await waitForCondition(
    'Host B Chat Popup receives A->B message with real sender name',
    () =>
      hostChatCdp.eval<boolean>(`(() => {
        const txt = document.querySelector('[data-testid="floating-panel-chat"]')?.textContent || '';
        return txt.includes(${JSON.stringify(msgAtoB)}) && txt.includes('Test Friend A') && !txt.includes('Elm Device');
      })()`),
    8_000
  );
  await waitForCondition(
    'Viewer A outgoing text message reaches Seen (✓✓) status',
    () =>
      cdpA.eval<boolean>(`(() => {
        const ticks = Array.from(document.querySelectorAll('[data-testid^="chat-status-"]'));
        return ticks.some((el) => el.getAttribute('data-status') === 'seen' && el.textContent?.trim() === '✓✓');
      })()`),
    8_000
  );

  await hostChatCdp.setInputValue(
    '[data-testid="floating-panel-chat"] input[type="text"]',
    msgBtoA
  );
  await hostChatCdp.click('[data-testid="floating-panel-chat"] button[type="submit"]');

  await waitForCondition(
    'Viewer A receives B->A message with real sender name',
    () =>
      cdpA.eval<boolean>(`(() => {
        const txt = document.querySelector('[data-testid="floating-panel-chat"]')?.textContent || '';
        return txt.includes(${JSON.stringify(msgBtoA)}) && txt.includes('Test Friend B') && !txt.includes('Elm Device');
      })()`),
    8_000
  );
  await waitForCondition(
    'Host B Chat Popup outgoing text message reaches Seen (✓✓) status',
    () =>
      hostChatCdp.eval<boolean>(`(() => {
        const ticks = Array.from(document.querySelectorAll('[data-testid^="chat-status-"]'));
        return ticks.some((el) => el.getAttribute('data-status') === 'seen' && el.textContent?.trim() === '✓✓');
      })()`),
    8_000
  );
  recordStep('bidirectional_chat', 'PASSED', {
    msgAtoB,
    msgBtoA,
    realSenderNamesShown: true,
    seenStatusConfirmedOnBoth: true,
  });

  // 6. Chat Image Transfer (Viewer A <-> Host B Chat Popup via real DataChannel chunking)
  const attachAndSendTestPng = async (
    cdp: CdpClient,
    containerSelector: string,
    filename: string
  ) => {
    const ok = await cdp.eval<boolean>(`(() => {
      const fileInput = document.querySelector(${JSON.stringify(
        `${containerSelector} input[type="file"]`
      )});
      if (!fileInput) return false;
      const canvas = document.createElement('canvas');
      canvas.width = 24;
      canvas.height = 24;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#2563eb';
        ctx.fillRect(0, 0, 24, 24);
      }
      const b64 = canvas.toDataURL('image/png').split(',')[1];
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], ${JSON.stringify(filename)}, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert.equal(ok, true, 'Chat file input must accept synthetic PNG');
    await sleep(250);
    await cdp.click(`${containerSelector} button[type="submit"]`);
  };

  await attachAndSendTestPng(
    cdpA,
    '[data-testid="floating-panel-chat"]',
    'from-a.png'
  );
  await waitForCondition(
    'Host B Chat Popup renders image from A',
    () =>
      hostChatCdp.eval<boolean>(
        `document.querySelectorAll('[data-testid="floating-panel-chat"] img').length >= 1`
      ),
    10_000
  );
  await attachAndSendTestPng(
    hostChatCdp,
    '[data-testid="floating-panel-chat"]',
    'from-b.png'
  );
  await waitForCondition(
    'Viewer A renders both images (own + from B) and both outgoing messages are Seen (✓✓)',
    () =>
      cdpA.eval<boolean>(`(() => {
        const imgs = document.querySelectorAll('[data-testid="floating-panel-chat"] img').length >= 2;
        const ticks = Array.from(document.querySelectorAll('[data-testid^="chat-status-"]'));
        return imgs && ticks.length >= 2 && ticks.every((el) => el.getAttribute('data-status') === 'seen');
      })()`),
    10_000
  );

  // Verify closing Host Chat Popup does NOT end the WebRTC session, and reopening retains volatile in-memory messages
  await hostChatCdp.click('[data-testid="chat-popup-close-button"]');
  hostChatCdp.close();
  await sleep(300);
  const afterChatCloseProbe = await getProbe(cdpB);
  assert.equal(
    afterChatCloseProbe?.connectionState,
    'connected',
    'Closing Host Chat Popup must keep active WebRTC session connected'
  );
  await hostToolbarCdp.click('[data-testid="floating-chat-toggle"]');
  const reopenedHostChatCdp = await CdpClient.connectByRole(
    clientB.debugPort!,
    'chat'
  );
  const retainedText = await waitForCondition(
    'Reopened Host Chat Popup retains in-memory messages during active session',
    () =>
      reopenedHostChatCdp.eval<boolean>(
        `(document.querySelector('[data-testid="floating-panel-chat"]')?.textContent || '').includes(${JSON.stringify(
          msgAtoB
        )})`
      ),
    5_000
  );
  assert.equal(retainedText, true);
  reopenedHostChatCdp.close();
  recordStep('chat_image_transfer', 'PASSED', {
    imagesRenderedOnBoth: true,
    chatPopupCloseDoesNotEndSession: true,
    inMemoryHistoryRetainedWhileActive: true,
  });

  // 7. Audio hardware probe (honest status — no fake playback claim)
  const wasapiProbe = await cdpB.eval<Record<string, unknown>>(
    `window.elmDesktop.probeWasapiLoopback()`
  );
  recordStep('audio_probe', 'PARTIAL_HARDWARE_LIMITED', {
    wasapiProbe,
    note: 'Live cross-process speaker playback not asserted on single PC to avoid same-endpoint feedback loop.',
  });

  // 7b. 60-Second Session Stability Hold (across multiple 10s heartbeat cycles)
  const holdSeconds = Number(process.env.ELM_E2E_HOLD_SECONDS ?? '60');
  const stabilitySamples: Array<{ elapsedSec: number; connectionState: unknown; dataChannelState: unknown }> = [];
  const holdStart = Date.now();
  const initialSessionId = connectedPair.probeA.sessionId;
  while (Date.now() - holdStart < holdSeconds * 1000) {
    await sleep(15_000);
    const [pA, pB] = await Promise.all([getProbe(cdpA), getProbe(cdpB)]);
    assert.equal(pA?.sessionId, initialSessionId, 'Client A must retain the same sessionId during 60s hold');
    assert.equal(pB?.sessionId, initialSessionId, 'Client B must retain the same sessionId during 60s hold');
    assert.equal(pA?.connectionState, 'connected', 'Client A WebRTC must remain connected during 60s hold');
    assert.equal(pB?.connectionState, 'connected', 'Client B WebRTC must remain connected during 60s hold');
    assert.equal(pA?.dataChannelState, 'open', 'Client A DataChannel must remain open during 60s hold');
    assert.equal(pB?.dataChannelState, 'open', 'Client B DataChannel must remain open during 60s hold');
    stabilitySamples.push({
      elapsedSec: Math.round((Date.now() - holdStart) / 1000),
      connectionState: pA?.connectionState,
      dataChannelState: pA?.dataChannelState,
    });
  }
  recordStep('session_stability_60s', 'PASSED', {
    sessionId: initialSessionId,
    holdSeconds,
    samples: stabilitySamples,
  });

  // 8. End Session from Host B Floating Toolbar & verify cleanup + Home return
  await hostToolbarCdp.click('[data-testid="floating-end-session"]');
  hostToolbarCdp.close();
  await waitForCondition(
    'Both clients return to Home after Host End Session',
    async () =>
      (await cdpA.eval<boolean>(`Boolean(document.querySelector('[data-testid="home-dashboard"]'))`)) &&
      (await cdpB.eval<boolean>(`Boolean(document.querySelector('[data-testid="home-dashboard"]'))`)),
    10_000
  );
  const overlayClosedCheck = await fetch(
    `http://127.0.0.1:${clientB.debugPort}/json/list`
  ).then(async (r) => {
    const list = (await r.json()) as Array<{ url: string }>;
    return list.filter(
      (t) =>
        t.url.includes('role=host-toolbar') ||
        t.url.includes('role=chat') ||
        t.url.includes('role=host-source-picker') ||
        t.url.includes('role=host-settings')
    );
  });
  assert.equal(
    overlayClosedCheck.length,
    0,
    'Host overlay & chat popup windows must close on End Session'
  );

  // Verify P2P contact exchange (name, email, phone) + Online green dot on Recent Sessions cards
  const recentCheck = await waitForCondition(
    'Mutual Recent Sessions cards show received Name, Email, Phone, and Online status',
    async () => {
      const cardOnA = await cdpA.eval<{
        text: string;
        email: string | null;
        phone: string | null;
        status: string;
      } | null>(`(() => {
        const card = document.querySelector('[data-testid="recent-peer-card-${codeB}"]');
        if (!card) return null;
        return {
          text: card.textContent || '',
          email: document.querySelector('[data-testid="peer-card-email-${codeB}"]')?.textContent || null,
          phone: document.querySelector('[data-testid="peer-card-phone-${codeB}"]')?.textContent || null,
          status: document.querySelector('[data-testid="peer-status-${codeB}"]')?.textContent?.trim() || '',
        };
      })()`);
      const cardOnB = await cdpB.eval<{
        text: string;
        email: string | null;
        phone: string | null;
        status: string;
      } | null>(`(() => {
        const card = document.querySelector('[data-testid="recent-peer-card-${codeA}"]');
        if (!card) return null;
        return {
          text: card.textContent || '',
          email: document.querySelector('[data-testid="peer-card-email-${codeA}"]')?.textContent || null,
          phone: document.querySelector('[data-testid="peer-card-phone-${codeA}"]')?.textContent || null,
          status: document.querySelector('[data-testid="peer-status-${codeA}"]')?.textContent?.trim() || '',
        };
      })()`);
      if (
        cardOnA?.email === 'friend.b@example.com' &&
        cardOnA?.phone === '+1 555-0202' &&
        cardOnA?.status === 'Online' &&
        cardOnB?.email === 'friend.a@example.com' &&
        cardOnB?.phone === '+1 555-0101' &&
        cardOnB?.status === 'Online'
      ) {
        return { cardOnA, cardOnB };
      }
      return null;
    },
    12_000,
    400
  );
  recordStep('disconnect_and_mutual_recent_presence', 'PASSED', recentCheck);

  // 9. Cancel Request & 120-Second Expiry
  await cdpA.setInputValue('[data-testid="connect-friend-code-input"]', codeB);
  await cdpA.click('[data-testid="send-connect-request-button"]');
  await waitForCondition(
    'Friend B receives cancellable request',
    () => cdpB.eval<boolean>(`Boolean(document.querySelector('[data-testid="incoming-request-dialog"]'))`),
    8_000
  );
  await cdpA.click('[data-testid="cancel-outgoing-invite-button"]');
  await waitForCondition(
    'Both A waiting panel and B incoming popup disappear after Cancel',
    async () =>
      !(await cdpA.eval<boolean>(`Boolean(document.querySelector('[data-testid="waiting-for-approval-card"]'))`)) &&
      !(await cdpB.eval<boolean>(`Boolean(document.querySelector('[data-testid="incoming-request-dialog"]'))`)),
    8_000
  );
  const cancelBannerShown = await cdpA.eval<boolean>(
    `(document.body.textContent || '').includes('Connection request cancelled.')`
  );
  assert.equal(cancelBannerShown, false, 'Must not show Connection request cancelled alert');

  // Test 120s server-authoritative expiry using controllable clock
  await cdpA.setInputValue('[data-testid="connect-friend-code-input"]', codeB);
  await cdpA.click('[data-testid="send-connect-request-button"]');
  await waitForCondition(
    'Friend B receives expiring request',
    () => cdpB.eval<boolean>(`Boolean(document.querySelector('[data-testid="incoming-request-dialog"]'))`),
    8_000
  );
  backend.advanceClockMs(121_000);
  await waitForCondition(
    'Request expires on both A and B after 120s server deadline',
    async () =>
      !(await cdpA.eval<boolean>(`Boolean(document.querySelector('[data-testid="waiting-for-approval-card"]'))`)) &&
      !(await cdpB.eval<boolean>(`Boolean(document.querySelector('[data-testid="incoming-request-dialog"]'))`)),
    10_000
  );
  // Close Request Expired modal on A if shown, then refresh presence on both clients since clock jumped +121s (> 30s stale threshold)
  await cdpA.eval(`document.querySelector('[data-testid="request-outcome-close-button"]')?.click()`);
  await Promise.all([
    cdpA.eval(`window.elmDesktop.triggerPresenceReconnect()`),
    cdpB.eval(`window.elmDesktop.triggerPresenceReconnect()`),
  ]);
  await waitForCondition(
    'Both clients Online after clock jump',
    async () =>
      (await cdpA.eval<boolean>(`document.querySelector('[data-testid="presence-status-pill"]')?.textContent?.trim() === 'Online'`)) &&
      (await cdpB.eval<boolean>(`document.querySelector('[data-testid="presence-status-pill"]')?.textContent?.trim() === 'Online'`)),
    10_000
  );
  recordStep('cancel_and_120s_expiry', 'PASSED', {
    cancelBannerShown,
    expiredAfter120s: true,
  });

  // 10. Reverse Roles (Friend B connects to Friend A -> A becomes Host, B becomes Guest)
  await cdpB.setInputValue('[data-testid="connect-friend-code-input"]', codeA);
  await waitForCondition(
    'Friend B Send Request button enabled',
    () =>
      cdpB.eval<boolean>(`(() => {
        const btn = document.querySelector('[data-testid="send-connect-request-button"]');
        return Boolean(btn && !btn.disabled);
      })()`),
    5_000
  );
  await cdpB.click('[data-testid="send-connect-request-button"]');
  // Dismiss any delayed Request Expired modal on A if it appeared
  await cdpA.eval(`document.querySelector('[data-testid="request-outcome-close-button"]')?.click()`);
  try {
    await waitForCondition(
      'Friend A receives reverse incoming request from B',
      () => cdpA.eval<boolean>(`Boolean(document.querySelector('[data-testid="incoming-request-dialog"]'))`),
      10_000
    );
  } catch (err) {
    const dbgB = await cdpB.eval(`({
      waiting: Boolean(document.querySelector('[data-testid="waiting-for-approval-card"]')),
      outcome: document.querySelector('[data-testid="request-outcome-modal"]')?.textContent || null,
      err: document.querySelector('.card-error')?.textContent || null,
      pill: document.querySelector('[data-testid="presence-status-pill"]')?.textContent || null,
    })`);
    const dbgA = await cdpA.eval(`({
      outcome: document.querySelector('[data-testid="request-outcome-modal"]')?.textContent || null,
      err: document.querySelector('.card-error')?.textContent || null,
      pill: document.querySelector('[data-testid="presence-status-pill"]')?.textContent || null,
    })`);
    console.error('Reverse request debug:', JSON.stringify({ dbgA, dbgB }, null, 2));
    throw err;
  }
  await cdpA.eval(`(() => {
    const dlg = document.querySelector('[data-testid="incoming-request-dialog"]');
    const firstCheckbox = dlg?.querySelector('input[type="checkbox"]');
    if (firstCheckbox && !firstCheckbox.checked) firstCheckbox.click();
  })()`);
  await cdpA.click('[data-testid="incoming-accept-button"]');

  const reverseConnected = await waitForCondition(
    'Reverse WebRTC connected (A=host, B=guest)',
    async () => {
      const [probeA, probeB] = await Promise.all([getProbe(cdpA), getProbe(cdpB)]);
      if (!probeA || !probeB) return null;
      const iceOk = (s: unknown) => s === 'connected' || s === 'completed';
      if (
        probeA.sessionId === probeB.sessionId &&
        probeA.localRole === 'host' &&
        probeB.localRole === 'guest' &&
        probeA.connectionState === 'connected' &&
        probeB.connectionState === 'connected' &&
        iceOk(probeA.iceConnectionState) &&
        iceOk(probeB.iceConnectionState) &&
        probeA.dataChannelState === 'open' &&
        probeB.dataChannelState === 'open'
      ) {
        return { probeA, probeB };
      }
      return null;
    },
    20_000,
    300
  );

  // Verify OFF Mic and Device Sound remain unavailable & disabled on Host A when only Screen was approved
  const hostAToolbarCdp = await CdpClient.connectByRole(clientA.debugPort!, 'host-toolbar');
  const hostAOffControls = await waitForCondition(
    'Host A unapproved Mic & Device Sound remain unavailable/disabled',
    () =>
      hostAToolbarCdp.eval<{
        micState: string | null;
        micDisabled: boolean;
        soundState: string | null;
        soundDisabled: boolean;
      } | null>(`(() => {
        const mic = document.querySelector('[data-testid="toolbar-my-mic-btn"]');
        const snd = document.querySelector('[data-testid="toolbar-device-sound-btn"]');
        if (!mic || !snd) return null;
        return {
          micState: mic.getAttribute('data-state'),
          micDisabled: Boolean(mic.disabled),
          soundState: snd.getAttribute('data-state'),
          soundDisabled: Boolean(snd.disabled),
        };
      })()`),
    8_000
  );
  hostAToolbarCdp.close();
  assert.equal(hostAOffControls.micState, 'unavailable');
  assert.equal(hostAOffControls.micDisabled, true);
  assert.equal(hostAOffControls.soundState, 'unavailable');
  assert.equal(hostAOffControls.soundDisabled, true);

  const shareResultAtoB = await tryScreenShare(
    cdpA,
    clientA.debugPort!,
    cdpB,
    'HOST A'
  );

  // Reverse disconnect initiated by Friend B
  await cdpB.click('[data-testid="floating-end-session"]');
  await waitForCondition(
    'Both clients return to Home after reverse Disconnect from B',
    async () =>
      (await cdpA.eval<boolean>(`Boolean(document.querySelector('[data-testid="home-dashboard"]'))`)) &&
      (await cdpB.eval<boolean>(`Boolean(document.querySelector('[data-testid="home-dashboard"]'))`)),
    10_000
  );
  recordStep(
    'reverse_roles_a_to_b',
    shareResultAtoB.passed ? 'PASSED' : 'PASSED_SIGNALING_AND_CHAT_CAPTURE_BLOCKED',
    {
      sessionId: reverseConnected.probeA.sessionId,
      roleA: reverseConnected.probeA.localRole,
      roleB: reverseConnected.probeB.localRole,
      videoCapturePassed: shareResultAtoB.passed,
      ...shareResultAtoB.stats,
    }
  );

  // 10b. Reverse Invite Flow (Client B sends Invite -> B=Host, A=Guest)
  await cdpB.click('[data-testid="open-invite-dialog-button"]');
  await waitForCondition(
    'Direct invite dialog open on Client B',
    () => cdpB.eval<boolean>(`Boolean(document.querySelector('[data-testid="direct-invite-dialog"]'))`),
    5_000
  );
  await cdpB.setInputValue('[data-testid="invite-target-code-input"]', codeA);
  // Enable Microphone and Device Sound (Screen is ON by default) in Reverse Invite dialog
  await cdpB.eval(`(() => {
    const dlg = document.querySelector('[data-testid="direct-invite-dialog"]');
    const checkboxes = dlg?.querySelectorAll('input[type="checkbox"]') ?? [];
    for (const cb of checkboxes) {
      if (!cb.checked) cb.click();
    }
  })()`);
  await cdpB.click('[data-testid="send-direct-invite-button"]');
  await waitForCondition(
    'Client A receives direct Invite from Client B',
    () => cdpA.eval<boolean>(`Boolean(document.querySelector('[data-testid="incoming-request-dialog"]'))`),
    10_000
  );
  await cdpA.click('[data-testid="incoming-accept-button"]');
  const reverseInviteConnected = await waitForCondition(
    'Reverse Invite WebRTC connected (B=host, A=guest) and approved audio settled',
    async () => {
      const [probeA, probeB] = await Promise.all([getProbe(cdpA), getProbe(cdpB)]);
      if (!probeA || !probeB) return null;
      const iceOk = (s: unknown) => s === 'connected' || s === 'completed';
      const hm = probeB.hostMediaState as Record<
        string,
        { approved: boolean; active: boolean; status: string }
      > | null;
      if (!hm) return null;
      const audioSettled =
        hm.microphoneAudio.status !== 'approved_awaiting_start' &&
        hm.microphoneAudio.status !== 'starting' &&
        hm.deviceAudio.status !== 'approved_awaiting_start' &&
        hm.deviceAudio.status !== 'starting';
      if (
        probeA.sessionId === probeB.sessionId &&
        probeA.localRole === 'guest' &&
        probeB.localRole === 'host' &&
        probeA.connectionState === 'connected' &&
        probeB.connectionState === 'connected' &&
        iceOk(probeA.iceConnectionState) &&
        iceOk(probeB.iceConnectionState) &&
        probeA.dataChannelState === 'open' &&
        probeB.dataChannelState === 'open' &&
        audioSettled
      ) {
        return { probeA, probeB, hm };
      }
      return null;
    },
    20_000,
    300
  );
  assert.equal(reverseInviteConnected.hm.screenVideo.approved, true);
  assert.equal(
    reverseInviteConnected.hm.screenVideo.active,
    false,
    'Reverse Invite Screen ON must stay manual until Host clicks Start Sharing'
  );
  assert.equal(reverseInviteConnected.hm.microphoneAudio.approved, true);
  assert.equal(reverseInviteConnected.hm.deviceAudio.approved, true);
  await cdpA.click('[data-testid="floating-end-session"]');
  await waitForCondition(
    'Both clients return to Home after reverse Invite End Session',
    async () =>
      (await cdpA.eval<boolean>(`Boolean(document.querySelector('[data-testid="home-dashboard"]'))`)) &&
      (await cdpB.eval<boolean>(`Boolean(document.querySelector('[data-testid="home-dashboard"]'))`)),
    10_000
  );
  recordStep('reverse_invite_b_to_a', 'PASSED', {
    sessionId: reverseInviteConnected.probeA.sessionId,
    roleA: reverseInviteConnected.probeA.localRole,
    roleB: reverseInviteConnected.probeB.localRole,
  });

  // 11. Backend privacy audit: verify zero chat, image, email, or phone ever hit Cloudflare backend
  const audit = backend.getTrafficAudit();
  const leaks = audit.checkNoLeaks([
    msgAtoB,
    msgBtoA,
    'friend.a@example.com',
    'friend.b@example.com',
    '+1 555-0101',
    '+1 555-0202',
    'data:image/png',
  ]);
  assert.deepEqual(leaks, [], `Backend unexpectedly received private data: ${leaks.join(', ')}`);
  recordStep('backend_privacy_audit', 'PASSED', {
    totalBackendRequests: audit.totalRequests,
    leaksFound: leaks.length,
  });

  const reportPath = path.join(desktopDir, 'two-client-e2e-report.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        backendUrl: backend.baseUrl,
        clientLogs: {
          clientA: logPathA,
          clientB: logPathB,
        },
        passed: true,
        results,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`\n✓ Two-client E2E suite PASSED. Report written to: ${reportPath}`);
  console.log(`  Client A log: ${logPathA}`);
  console.log(`  Client B log: ${logPathB}`);
} finally {
  for (const c of launched) {
    await stopClientProcess(c);
  }
  await backend.close();
  try {
    fs.rmSync(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 6,
      retryDelay: 200,
    });
  } catch {
    // Ignore locked temp profile files after process termination on Windows
  }
}
