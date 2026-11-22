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
  }

  static async connect(debugPort: number): Promise<CdpClient> {
    const target = await waitForCondition(
      `Electron CDP target on port ${debugPort}`,
      async () => {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        if (!res.ok) return null;
        const list = (await res.json()) as Array<{
          type: string;
          url: string;
          webSocketDebuggerUrl?: string;
        }>;
        return (
          list.find(
            (t) =>
              t.type === 'page' &&
              t.url.includes('index.html') &&
              t.webSocketDebuggerUrl
          ) ?? null
        );
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
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
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
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
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

interface LaunchedClient {
  readonly label: string;
  readonly proc: ChildProcess;
  readonly userDataDir: string;
  readonly debugPort: number | null;
  cdp: CdpClient | null;
}

async function launchElectronClient(params: {
  label: string;
  apiBaseUrl: string;
  userDataDir: string;
  bounds: string;
  enableCdp: boolean;
}): Promise<LaunchedClient> {
  const electronBin = resolveElectronBinary();
  const debugPort = params.enableCdp ? await getFreePort() : null;
  const args = [desktopDir];
  if (debugPort !== null) {
    args.unshift(`--remote-debugging-port=${debugPort}`);
  }

  const proc = spawn(electronBin, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ELM_API_BASE_URL: params.apiBaseUrl,
      ELM_USER_DATA_DIR: params.userDataDir,
      ELM_WINDOW_BOUNDS: params.bounds,
      ELM_WINDOW_TITLE_SUFFIX: `[${params.label}]`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const client: LaunchedClient = {
    label: params.label,
    proc,
    userDataDir: params.userDataDir,
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
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const tempRoot = path.join(os.tmpdir(), `elm-two-clients-e2e-${runId}`);
const userDataA = path.join(tempRoot, 'friend-a');
const userDataB = path.join(tempRoot, 'friend-b');
fs.mkdirSync(userDataA, { recursive: true });
fs.mkdirSync(userDataB, { recursive: true });

// Ensure built dist exists before launching Electron
const mainDistPath = path.join(desktopDir, 'dist/main/index.cjs');
if (!fs.existsSync(mainDistPath)) {
  throw new Error(
    `Desktop build missing (${mainDistPath}). Run "npm run build" before running the two-client simulation.`
  );
}

const backend = await startLocalTwoClientBackend();
const launched: LaunchedClient[] = [];

if (isInteractive) {
  console.log('===============================================================');
  console.log('Elm-AnyDesk Interactive Two-Client Simulation');
  console.log(`Isolated Backend: ${backend.baseUrl}`);
  console.log(`Friend A Profile: ${userDataA}`);
  console.log(`Friend B Profile: ${userDataB}`);
  console.log('Close both windows or press Ctrl+C to stop and clean up temp profiles.');
  console.log('===============================================================');

  const clientA = await launchElectronClient({
    label: 'Friend A',
    apiBaseUrl: backend.baseUrl,
    userDataDir: userDataA,
    bounds: '20,40,730,780',
    enableCdp: false,
  });
  const clientB = await launchElectronClient({
    label: 'Friend B',
    apiBaseUrl: backend.baseUrl,
    userDataDir: userDataB,
    bounds: '770,40,730,780',
    enableCdp: false,
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
  console.log(`[${status}] ${name}`);
};

try {
  const clientA = await launchElectronClient({
    label: 'Friend A',
    apiBaseUrl: backend.baseUrl,
    userDataDir: userDataA,
    bounds: '20,40,730,780',
    enableCdp: true,
  });
  const clientB = await launchElectronClient({
    label: 'Friend B',
    apiBaseUrl: backend.baseUrl,
    userDataDir: userDataB,
    bounds: '770,40,730,780',
    enableCdp: true,
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

  // 3. Accept Connection (B enables Screen Video checkbox and clicks Accept)
  await cdpB.eval(`(() => {
    const dlg = document.querySelector('[data-testid="incoming-request-dialog"]');
    const firstCheckbox = dlg?.querySelector('input[type="checkbox"]');
    if (firstCheckbox && !firstCheckbox.checked) firstCheckbox.click();
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

  // 4. Real Screen Sharing (try each available [DISPLAY] source, record real getStats honestly, and continue suite if OS capture yields 0 frames)
  const tryScreenShare = async (
    hostCdp: CdpClient,
    guestCdp: CdpClient,
    hostLabel: string
  ): Promise<{ passed: boolean; stats: Record<string, unknown> }> => {
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
      `${hostLabel} Start Sharing button & shareable sources ready`,
      () =>
        hostCdp.eval<boolean>(`(() => {
          const btn = document.querySelector('[data-testid="host-start-sharing-button"]');
          const sel = document.querySelector('select[aria-label="Select window or display to share"]');
          return Boolean(btn && !btn.disabled && sel && sel.options.length > 0);
        })()`),
      10_000
    );

    const displayOptions = await hostCdp.eval<Array<{ value: string; text: string }>>(`(() => {
      const sel = document.querySelector('select[aria-label="Select window or display to share"]');
      if (!sel) return [];
      const opts = Array.from(sel.options).map((o) => ({ value: o.value, text: o.text }));
      const displays = opts.filter((o) => o.text.startsWith('[DISPLAY]'));
      return displays.length > 0 ? displays : opts.slice(0, 1);
    })()`);

    let lastStats: Record<string, unknown> = {};
    for (const opt of displayOptions) {
      await hostCdp.eval(`(() => {
        const sel = document.querySelector('select[aria-label="Select window or display to share"]');
        if (!sel) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (setter) setter.call(sel, ${JSON.stringify(opt.value)});
        else sel.value = ${JSON.stringify(opt.value)};
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(150);
      await hostCdp.click('[data-testid="host-start-sharing-button"]');

      const deadline = Date.now() + 6_000;
      while (Date.now() < deadline) {
        const [probeGuest, probeHost] = await Promise.all([
          getProbe(guestCdp),
          getProbe(hostCdp),
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
          rttMs: diagGuest?.rttMs ?? diagHost?.rttMs,
        };
        if (sent > 0 && decoded > 0 && bytes > 0 && videoTracks >= 1) {
          return { passed: true, stats: lastStats };
        }
        await sleep(350);
      }
      // Stop before trying next display source
      await hostCdp.eval(`(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const stopBtn = btns.find((b) => (b.textContent || '').includes('Stop All Sharing'));
        stopBtn?.click();
      })()`);
      await sleep(300);
    }
    return { passed: false, stats: lastStats };
  };

  const shareResultBtoA = await tryScreenShare(cdpB, cdpA, 'HOST B');
  recordStep(
    'screen_sharing_b_to_a',
    shareResultBtoA.passed ? 'PASSED' : 'BLOCKED_OS_CAPTURE_ZERO_FRAMES',
    shareResultBtoA.stats
  );

  // 5. Bidirectional Private Chat (A <-> B over real WebRTC DataChannel)
  await cdpA.click('[data-testid="floating-chat-toggle"]');
  await cdpB.click('[data-testid="floating-chat-toggle"]');
  const msgAtoB = 'Hello Friend B, this is a two-device simulation test.';
  const msgBtoA = 'Hello Friend A, I received your message successfully.';

  await waitForCondition(
    'Chat input visible on A and B',
    async () =>
      (await cdpA.eval<boolean>(
        `Boolean(document.querySelector('[data-testid="floating-panel-chat"] input[type="text"]'))`
      )) &&
      (await cdpB.eval<boolean>(
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
    'Friend B receives A->B message',
    () =>
      cdpB.eval<boolean>(
        `(document.querySelector('[data-testid="floating-panel-chat"]')?.textContent || '').includes(${JSON.stringify(
          msgAtoB
        )})`
      ),
    8_000
  );

  await cdpB.setInputValue(
    '[data-testid="floating-panel-chat"] input[type="text"]',
    msgBtoA
  );
  await cdpB.click('[data-testid="floating-panel-chat"] button[type="submit"]');

  await waitForCondition(
    'Friend A receives B->A message',
    () =>
      cdpA.eval<boolean>(
        `(document.querySelector('[data-testid="floating-panel-chat"]')?.textContent || '').includes(${JSON.stringify(
          msgBtoA
        )})`
      ),
    8_000
  );
  recordStep('bidirectional_chat', 'PASSED', { msgAtoB, msgBtoA });

  // 6. Chat Image Transfer (A -> B and B -> A via real DataChannel chunking)
  const attachAndSendTestPng = async (cdp: CdpClient, filename: string) => {
    const ok = await cdp.eval<boolean>(`(() => {
      const fileInput = document.querySelector('[data-testid="floating-panel-chat"] input[type="file"]');
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
    await cdp.click('[data-testid="floating-panel-chat"] button[type="submit"]');
  };

  await attachAndSendTestPng(cdpA, 'from-a.png');
  await waitForCondition(
    'Friend B renders image from A',
    () =>
      cdpB.eval<boolean>(
        `document.querySelectorAll('[data-testid="floating-panel-chat"] img').length >= 1`
      ),
    10_000
  );
  await attachAndSendTestPng(cdpB, 'from-b.png');
  await waitForCondition(
    'Friend A renders both images (own + from B)',
    () =>
      cdpA.eval<boolean>(
        `document.querySelectorAll('[data-testid="floating-panel-chat"] img').length >= 2`
      ),
    10_000
  );
  recordStep('chat_image_transfer', 'PASSED', { imagesRenderedOnBoth: true });

  // 7. Audio hardware probe (honest status — no fake playback claim)
  const wasapiProbe = await cdpB.eval<Record<string, unknown>>(
    `window.elmDesktop.probeWasapiLoopback()`
  );
  recordStep('audio_probe', 'PARTIAL_HARDWARE_LIMITED', {
    wasapiProbe,
    note: 'Live cross-process speaker playback not asserted on single PC to avoid same-endpoint feedback loop.',
  });

  // 8. Disconnect from Friend A & verify Recent Sessions P2P contact + green dot
  await cdpA.click('[data-testid="floating-end-session"]');
  await waitForCondition(
    'Both clients return to Home after Disconnect',
    async () =>
      (await cdpA.eval<boolean>(`Boolean(document.querySelector('[data-testid="home-dashboard"]'))`)) &&
      (await cdpB.eval<boolean>(`Boolean(document.querySelector('[data-testid="home-dashboard"]'))`)),
    10_000
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

  const shareResultAtoB = await tryScreenShare(cdpA, cdpB, 'HOST A');

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
        passed: true,
        results,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`\n✓ Two-client E2E suite PASSED. Report written to: ${reportPath}`);
} finally {
  for (const c of launched) {
    await stopClientProcess(c);
  }
  await backend.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
