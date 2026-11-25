import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  AccountProfile,
  ApprovedSessionSummary,
  InviteSummary,
  PresenceStateSnapshot,
} from '@elm/protocol';
import type { PresenceRuntimeStatus } from '../src/shared/bridge.ts';

// Register lightweight in-process stub for `electron` so we can instantiate the real
// DesktopAuthAndInviteController under Node's test runner without spawning Electron.
const stubUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elm-race-test-'));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: 'elm-test-stub:electron', shortCircuit: true };
    }
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !/\.[a-z0-9]+$/i.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'elm-test-stub:electron') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const app = { getPath: () => ${JSON.stringify(stubUserDataDir)} };
          export const safeStorage = {
            isEncryptionAvailable: () => false,
            encryptString: (s) => Buffer.from(s, 'utf8'),
            decryptString: (b) => b.toString('utf8'),
          };
          export const shell = { openExternal: async () => {} };
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { DesktopAuthAndInviteController } = await import(
  '../src/main/auth-invite-client.ts'
);
const { ApprovedWebRtcSessionController } = await import(
  '../src/renderer/webrtc-session.ts'
);

function makeAccount(id: string, code: string, name: string): AccountProfile {
  return {
    accountId: id,
    provider: 'anonymous-device',
    providerSubject: `dev-${id}`,
    displayName: name,
    friendCode: code,
    createdAt: '2026-11-24T00:00:00.000Z',
  };
}

function makeSnapshot(
  account: AccountProfile,
  overrides?: Partial<PresenceStateSnapshot>
): PresenceStateSnapshot {
  return {
    online: true,
    account,
    incomingInvites: [],
    outgoingInvite: null,
    recentExpiredOutgoingInvite: null,
    activeSession: null,
    ...overrides,
  };
}

function makeSession(sessionId = 'sess-race-001'): ApprovedSessionSummary {
  return {
    sessionId,
    inviteId: 'inv-race-001',
    hostAccountId: 'acct-host',
    hostFriendCode: 'ELM-HOST-2345',
    hostDisplayName: 'Host B',
    guestAccountId: 'acct-guest',
    guestFriendCode: 'ELM-GUST-6789',
    guestDisplayName: 'Guest A',
    hostMediaSelection: {
      screenVideo: true,
      microphoneAudio: false,
      deviceAudio: false,
    },
    createdAt: '2026-11-24T00:00:00.000Z',
  };
}

function makeInvite(inviteId = 'inv-race-001'): InviteSummary {
  return {
    inviteId,
    requesterAccountId: 'acct-guest',
    requesterFriendCode: 'ELM-GUST-6789',
    requesterDisplayName: 'Guest A',
    targetAccountId: 'acct-host',
    targetFriendCode: 'ELM-HOST-2345',
    targetDisplayName: 'Host B',
    intent: 'connect',
    status: 'pending',
    createdAt: '2026-11-24T00:00:00.000Z',
    expiresAt: '2026-11-24T00:02:00.000Z',
    resolvedAt: null,
  };
}

// Lightweight fake RTCPeerConnection + RTCDataChannel for deterministic WebRTC controller unit tests
class FakeDataChannel {
  label: string;
  ordered = true;
  maxPacketLifeTime = null;
  maxRetransmits = null;
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(label: string) {
    this.label = label;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 'closed';
  }
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  config: RTCConfiguration | undefined;
  connectionState: string = 'new';
  iceConnectionState: string = 'new';
  signalingState: string = 'stable';
  remoteDescription: { type: string; sdp: string } | null = null;
  localDescription: { type: string; sdp: string } | null = null;
  onicecandidate: ((ev: { candidate: null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;
  ontrack: ((ev: unknown) => void) | null = null;
  closed = false;
  channels: FakeDataChannel[] = [];
  restartIceCalls = 0;
  createOfferCalls: Array<RTCOfferOptions | undefined> = [];
  constructor(config?: RTCConfiguration) {
    this.config = config;
    FakeRTCPeerConnection.instances.push(this);
  }
  createDataChannel(label: string) {
    const ch = new FakeDataChannel(label);
    this.channels.push(ch);
    return ch;
  }
  restartIce() {
    this.restartIceCalls += 1;
  }
  async createOffer(options?: RTCOfferOptions) {
    this.createOfferCalls.push(options);
    return { type: 'offer', sdp: 'v=0\r\nfake-offer\r\n' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\nfake-answer\r\n' };
  }
  async setLocalDescription(desc: { type: string; sdp: string }) {
    this.localDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.remoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate() {}
  getTransceivers() {
    return [];
  }
  async getStats() {
    return new Map();
  }
  removeTrack() {}
  close() {
    this.closed = true;
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
  }
}

function installFakeBrowserGlobals(overrides: Record<string, unknown>) {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevRtc = (globalThis as Record<string, unknown>).RTCPeerConnection;
  (globalThis as Record<string, unknown>).RTCPeerConnection = FakeRTCPeerConnection;
  (globalThis as Record<string, unknown>).window = {
    elmDesktop: {
      sendSessionSignal: async () => ({ ok: true, status: 200, data: { admitted: true } }),
      pollSessionSignals: async () => ({ ok: true, status: 200, data: { signals: [] } }),
      recordSessionHeartbeat: async () => ({ ok: true, status: 200, data: { ok: true, sessionId: 's', heartbeatAtMs: Date.now() } }),
      checkSessionLiveness: async () => ({ ok: true, status: 200, data: { alive: true, alreadyEnded: false } }),
      disconnectActiveSession: async () => ({ ok: true, status: 200, data: { disconnected: true, alreadyEnded: false } }),
      stopWasapiLoopback: async () => ({ stopped: true }),
      ...overrides,
    },
  };
  return () => {
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
    if (prevRtc === undefined) {
      delete (globalThis as Record<string, unknown>).RTCPeerConnection;
    } else {
      (globalThis as Record<string, unknown>).RTCPeerConnection = prevRtc;
    }
  };
}

test('Test A: delayed pre-accept GET /presence/state cannot overwrite accepted activeSession or trigger disconnect, while genuine newer termination is applied', async () => {
  const hostAccount = makeAccount('acct-host', 'ELM-HOST-2345', 'Host B');
  const session = makeSession('sess-test-a');
  const invite = makeInvite('inv-test-a');

  let releaseHeldStatePoll: (() => void) | null = null;
  let holdFirstStatePoll = true;
  let serverActiveSession: ApprovedSessionSummary | null = null;
  let disconnectCalls = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/devices/register') {
      return send(200, {
        token: 'tok-host-a',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        alreadyRegistered: false,
        account: hostAccount,
      });
    }

    if (req.method === 'POST' && (url.pathname === '/presence/connect' || url.pathname === '/presence/heartbeat')) {
      return send(200, {
        serverTime: new Date().toISOString(),
        snapshot: makeSnapshot(hostAccount, { activeSession: serverActiveSession }),
      });
    }

    if (req.method === 'GET' && url.pathname === '/presence/state') {
      // Snapshot captured BEFORE holding response (simulates request evaluated on DO before Accept)
      const capturedSnapshot = makeSnapshot(hostAccount, {
        incomingInvites: serverActiveSession ? [] : [invite],
        activeSession: serverActiveSession,
      });
      if (holdFirstStatePoll) {
        holdFirstStatePoll = false;
        await new Promise<void>((resolve) => {
          releaseHeldStatePoll = resolve;
        });
      }
      return send(200, {
        serverTime: new Date().toISOString(),
        snapshot: capturedSnapshot,
      });
    }

    if (req.method === 'POST' && url.pathname === `/invites/${invite.inviteId}/respond`) {
      serverActiveSession = session;
      return send(200, {
        invite: { ...invite, status: 'accepted', resolvedAt: new Date().toISOString() },
        session,
        snapshot: makeSnapshot(hostAccount, { activeSession: session }),
      });
    }

    if (req.method === 'POST' && url.pathname === '/sessions/disconnect') {
      disconnectCalls += 1;
      serverActiveSession = null;
      return send(200, {
        disconnected: true,
        alreadyEnded: false,
        snapshot: makeSnapshot(hostAccount, { activeSession: null }),
      });
    }

    return send(404, { error: 'NOT_FOUND' });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const emittedStatuses: PresenceRuntimeStatus[] = [];
  const stateFile = path.join(stubUserDataDir, `state-test-a-${Date.now()}.json`);
  const controller = new DesktopAuthAndInviteController(baseUrl, {
    stateFilePath: stateFile,
    heartbeatIntervalMs: 60_000,
    onPresenceStatusChanged: (st) => emittedStatuses.push(st),
  });

  try {
    const setupRes = await controller.saveLocalProfile({ name: 'Host B' });
    assert.equal(setupRes.ok, true);
    assert.equal(controller.getPresenceRuntimeStatus().connectionState, 'online');

    // 1. Start GET /presence/state BEFORE Accept (held in flight with activeSession: null)
    const stalePollPromise = controller.getPresenceSnapshot();
    while (!releaseHeldStatePoll) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // 2. Accept invite while GET /presence/state is still in flight
    const acceptRes = await controller.respondToInvite({
      inviteId: invite.inviteId,
      action: 'accept',
      mediaSelection: { screenVideo: true, microphoneAudio: false, deviceAudio: false },
    });
    assert.equal(acceptRes.ok, true);
    assert.equal(acceptRes.data?.snapshot.activeSession?.sessionId, session.sessionId);
    const acceptEmitIndex = emittedStatuses.length - 1;

    // 3. Release the stale pre-accept GET /presence/state (activeSession: null)
    (releaseHeldStatePoll as () => void)();
    const stalePollRes = await stalePollPromise;

    // 4. Verify activeSession remains intact in both runtime status AND returned poll payload
    assert.equal(stalePollRes.ok, true);
    assert.equal(stalePollRes.data?.snapshot.activeSession?.sessionId, session.sessionId);
    assert.equal(
      controller.getPresenceRuntimeStatus().snapshot?.activeSession?.sessionId,
      session.sessionId
    );
    // No IPC broadcast after acceptance regressed activeSession to null
    for (const st of emittedStatuses.slice(acceptEmitIndex)) {
      assert.equal(st.snapshot?.activeSession?.sessionId, session.sessionId);
    }
    assert.equal(disconnectCalls, 0);

    // 5. Verify a genuine NEWER server-confirmed session termination IS still applied
    serverActiveSession = null;
    const freshPollRes = await controller.getPresenceSnapshot();
    assert.equal(freshPollRes.ok, true);
    assert.equal(freshPollRes.data?.snapshot.activeSession, null);
    assert.equal(controller.getPresenceRuntimeStatus().snapshot?.activeSession, null);
  } finally {
    controller.stopPresenceHeartbeat();
    server.close();
  }
});

test('Test B: missing snapshot field from outdated 51ca5ef backend preserves valid session and falls back from 404 /presence/heartbeat', async () => {
  const hostAccount = makeAccount('acct-host-b', 'ELM-HOST-51CA', 'Host Legacy');
  const session = makeSession('sess-test-b');
  const invite = makeInvite('inv-test-b');
  let connectCount = 0;
  let heartbeat404Count = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/devices/register') {
      return send(200, {
        token: 'tok-host-b',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        alreadyRegistered: false,
        account: hostAccount,
      });
    }
    if (req.method === 'POST' && url.pathname === '/presence/connect') {
      connectCount += 1;
      return send(200, {
        snapshot: makeSnapshot(hostAccount, { activeSession: null }),
      });
    }
    if (req.method === 'POST' && url.pathname === '/presence/heartbeat') {
      heartbeat404Count += 1;
      return send(404, { error: 'Not Found', message: 'Elm-AnyDesk API Phase 3.' });
    }
    if (req.method === 'POST' && url.pathname === `/invites/${invite.inviteId}/respond`) {
      // Legacy 51ca5ef payload: { invite, session } with NO `snapshot` field!
      return send(200, {
        invite: { ...invite, status: 'accepted', resolvedAt: new Date().toISOString() },
        session,
      });
    }
    return send(404, { error: 'NOT_FOUND' });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const stateFile = path.join(stubUserDataDir, `state-test-b-${Date.now()}.json`);
  const controller = new DesktopAuthAndInviteController(baseUrl, {
    stateFilePath: stateFile,
    heartbeatIntervalMs: 60_000,
  });

  try {
    await controller.saveLocalProfile({ name: 'Host Legacy' });
    assert.equal(controller.getPresenceRuntimeStatus().connectionState, 'online');

    // 1. Accept against legacy backend returning { invite, session } without snapshot
    const acceptRes = await controller.respondToInvite({
      inviteId: invite.inviteId,
      action: 'accept',
      mediaSelection: { screenVideo: true, microphoneAudio: false, deviceAudio: false },
    });
    assert.equal(acceptRes.ok, true);
    assert.ok(acceptRes.data?.snapshot, 'Snapshot must never be undefined');
    assert.equal(acceptRes.data?.snapshot.activeSession?.sessionId, session.sessionId);
    assert.equal(
      controller.getPresenceRuntimeStatus().snapshot?.activeSession?.sessionId,
      session.sessionId
    );

    // 2. Heartbeat against legacy backend lacking /presence/heartbeat falls back to /presence/connect without going offline
    const hbStatus = await controller.establishRemotePresence('heartbeat');
    assert.equal(heartbeat404Count, 1);
    assert.equal(connectCount >= 2, true);
    assert.equal(hbStatus.connectionState, 'online');
    assert.equal(hbStatus.serverConfirmedOnline, true);
  } finally {
    controller.stopPresenceHeartbeat();
    server.close();
  }
});

test('Test C: destroyLocalOnly releases local controller resources without calling POST /sessions/disconnect', async () => {
  let disconnectCalls = 0;
  let viewerCleared = false;
  let stopWasapiCalls = 0;
  const restore = installFakeBrowserGlobals({
    disconnectActiveSession: async () => {
      disconnectCalls += 1;
      return { ok: true, status: 200, data: { disconnected: true, alreadyEnded: false } };
    },
    stopWasapiLoopback: async () => {
      stopWasapiCalls += 1;
      return { stopped: true };
    },
  });

  try {
    const emissions: unknown[] = [];
    const ctrl = new ApprovedWebRtcSessionController(
      makeSession('sess-test-c'),
      (snap) => emissions.push(snap),
      {
        mode: 'remote',
        localRole: 'host',
        enableBackgroundLivenessTimer: false,
        onGuestViewerCleared: () => {
          viewerCleared = true;
        },
      }
    );

    const receipt = ctrl.destroyLocalOnly(
      'connection_lost',
      'session_cleared_by_server',
      { silent: true }
    );
    assert.equal(receipt.peerConnectionsClosed, true);
    assert.equal(receipt.dataChannelsClosed, true);
    assert.equal(receipt.permissionsInvalidated, true);
    assert.equal(viewerCleared, true);
    assert.equal(stopWasapiCalls, 1);
    assert.equal(disconnectCalls, 0, 'Local-only cleanup must never call POST /sessions/disconnect');
    assert.equal(emissions.length, 0, 'Silent local-only cleanup must not emit stale UI state');
  } finally {
    restore();
  }
});

test('Test D: explicit End Session (executeIdempotentTeardown) terminates backend session and is idempotent on repeat calls', async () => {
  const disconnectPayloads: Array<Record<string, unknown>> = [];
  let viewerCleared = false;
  const restore = installFakeBrowserGlobals({
    disconnectActiveSession: async (params: Record<string, unknown>) => {
      disconnectPayloads.push(params);
      return {
        ok: true,
        status: 200,
        data: {
          disconnected: true,
          alreadyEnded: disconnectPayloads.length > 1,
          receipt: {
            sessionId: params.sessionId,
            reason: params.reason,
            subReason: params.subReason,
            initiatedByAccountId: params.callerAccountId ?? null,
            terminatedAt: new Date().toISOString(),
            alreadyEnded: disconnectPayloads.length > 1,
            duplicateCallCount: Math.max(0, disconnectPayloads.length - 1),
            hostTracksStoppedCount: 0,
            peerConnectionsClosed: true,
            dataChannelsClosed: true,
            guestViewerCleared: true,
            permissionsInvalidated: true,
            signalingMembershipInvalidated: true,
            detectionTimeMs: 1,
          },
        },
      };
    },
  });

  try {
    const ctrl = new ApprovedWebRtcSessionController(
      makeSession('sess-test-d'),
      () => {},
      {
        mode: 'remote',
        localRole: 'host',
        enableBackgroundLivenessTimer: false,
        onGuestViewerCleared: () => {
          viewerCleared = true;
        },
      }
    );

    const first = await ctrl.executeIdempotentTeardown('user_top_bar_disconnect', {
      subReason: 'top_bar_host_a',
      initiatedByAccountId: 'acct-host',
    });
    assert.equal(first.reason, 'user_top_bar_disconnect');
    assert.equal(first.permissionsInvalidated, true);
    assert.equal(viewerCleared, true);
    assert.equal(disconnectPayloads.length, 1);

    const second = await ctrl.executeIdempotentTeardown('user_top_bar_disconnect', {
      subReason: 'top_bar_host_a',
      initiatedByAccountId: 'acct-host',
    });
    assert.equal(second.alreadyEnded, true);
    assert.equal(second.duplicateCallCount >= 1, true);
  } finally {
    restore();
  }
});

test('Test E: 409 SESSION_ALREADY_ENDED from signal polling exits Connecting, cleans up locally, and avoids duplicate disconnect', async () => {
  let disconnectCalls = 0;
  let endedRemotelyInfo: { sessionId: string; subReason: string; message: string } | null = null;
  const restore = installFakeBrowserGlobals({
    pollSessionSignals: async () => ({
      ok: false,
      status: 409,
      errorCode: 'SESSION_ALREADY_ENDED',
      errorMessage: 'Session has already ended on server.',
    }),
    disconnectActiveSession: async () => {
      disconnectCalls += 1;
      return { ok: true, status: 200 };
    },
  });

  try {
    const ctrl = new ApprovedWebRtcSessionController(
      makeSession('sess-test-e'),
      () => {},
      {
        mode: 'remote',
        localRole: 'guest',
        enableBackgroundLivenessTimer: false,
        onSessionEndedRemotely: (info) => {
          endedRemotelyInfo = info;
        },
      }
    );

    await ctrl.connectAcceptedSession();
    assert.ok(endedRemotelyInfo, 'onSessionEndedRemotely must fire on 409 SESSION_ALREADY_ENDED');
    assert.equal((endedRemotelyInfo as { sessionId: string }).sessionId, 'sess-test-e');
    assert.equal(
      (endedRemotelyInfo as { subReason: string }).subReason,
      'session_already_ended_on_server'
    );
    assert.equal(ctrl.getSnapshot().permissionsInvalidated, true);
    assert.equal(ctrl.getSnapshot().connectionState, 'closed');
    assert.equal(
      disconnectCalls,
      0,
      '409 SESSION_ALREADY_ENDED must not send unnecessary duplicate POST /sessions/disconnect'
    );
  } finally {
    restore();
  }
});

test('Test F: async signaling completion after destroyLocalOnly cannot resurrect UI state or emit stale snapshots', async () => {
  let resolveSlowSignal: (() => void) | null = null;
  const restore = installFakeBrowserGlobals({
    sendSessionSignal: () =>
      new Promise((resolve) => {
        resolveSlowSignal = () => resolve({ ok: true, status: 200, data: { admitted: true } });
      }),
  });

  try {
    let emissionCount = 0;
    const ctrl = new ApprovedWebRtcSessionController(
      makeSession('sess-test-f'),
      () => {
        emissionCount += 1;
      },
      {
        mode: 'remote',
        localRole: 'host',
        enableBackgroundLivenessTimer: false,
      }
    );

    // Start connectAcceptedSession (triggers createOffer -> sendSessionSignal which blocks)
    const connectPromise = ctrl.connectAcceptedSession();
    while (!resolveSlowSignal) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Destroy controller silently while sendSessionSignal is still in flight
    ctrl.destroyLocalOnly('connection_lost', 'session_replaced', { silent: true });
    const countAfterDestroy = emissionCount;

    // Resolve the old in-flight signaling request
    (resolveSlowSignal as () => void)();
    await connectPromise;

    assert.equal(
      emissionCount,
      countAfterDestroy,
      'Destroyed controller must emit zero UI updates when late async operations resolve'
    );
    assert.equal(ctrl.getSnapshot().connectionState, 'closed');
  } finally {
    restore();
  }
});

test('Presence retry scheduling: recovering via GET /presence/state cancels backoff and resumes normal heartbeat cadence', async () => {
  const hostAccount = makeAccount('acct-retry', 'ELM-RTRY-2345', 'Retry Host');
  let failHeartbeats = true;
  let heartbeatCalls = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname === '/devices/register') {
      return send(200, {
        token: 'tok-retry',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        alreadyRegistered: false,
        account: hostAccount,
      });
    }
    if (req.method === 'POST' && url.pathname === '/presence/connect') {
      return send(200, {
        serverTime: new Date().toISOString(),
        snapshot: makeSnapshot(hostAccount),
      });
    }
    if (req.method === 'POST' && url.pathname === '/presence/heartbeat') {
      heartbeatCalls += 1;
      if (failHeartbeats) {
        return send(503, { error: 'UNAVAILABLE', message: 'Transient outage' });
      }
      return send(200, {
        serverTime: new Date().toISOString(),
        snapshot: makeSnapshot(hostAccount),
      });
    }
    if (req.method === 'GET' && url.pathname === '/presence/state') {
      return send(200, {
        serverTime: new Date().toISOString(),
        snapshot: makeSnapshot(hostAccount),
      });
    }
    return send(404, { error: 'NOT_FOUND' });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const stateFile = path.join(stubUserDataDir, `state-retry-${Date.now()}.json`);
  const controller = new DesktopAuthAndInviteController(baseUrl, {
    stateFilePath: stateFile,
    heartbeatIntervalMs: 5000,
    initialBackoffMs: 120,
  });

  try {
    await controller.saveLocalProfile({ name: 'Retry Host' });
    // Trigger 1st heartbeat failure -> enters 120ms backoff
    const failedStatus = await controller.establishRemotePresence('heartbeat');
    assert.equal(failedStatus.connectionState, 'reconnecting');
    assert.equal(heartbeatCalls, 1);

    // Recover via GET /presence/state -> should cancel the 120ms backoff timer and reschedule 5000ms heartbeat
    failHeartbeats = false;
    const pollRes = await controller.getPresenceSnapshot();
    assert.equal(pollRes.ok, true);
    assert.equal(controller.getPresenceRuntimeStatus().connectionState, 'online');

    // Wait 300ms (> 120ms backoff, < 5000ms normal heartbeat) -> no premature retry should fire!
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      heartbeatCalls,
      1,
      'Outdated 120ms backoff timer must be cancelled once presence is confirmed online'
    );
  } finally {
    controller.stopPresenceHeartbeat();
    server.close();
  }
});

test('Phase 8A/8B/8C: Heartbeat HTTP 404, HTTP 503, and timeout immediately after Accept preserve activeSession and never trigger disconnect', async () => {
  const hostAccount = makeAccount('acct-hb-fault', 'ELM-HBFT-2345', 'Host HB');
  const session = makeSession('sess-hb-fault');
  const invite = makeInvite('inv-hb-fault');
  let mode: '404' | '503' | 'timeout' = '404';
  let disconnectCalls = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(200, {
        status: 'ok',
        phase: 'phase-5-staging-and-installer-pilot',
        protocolVersion: '0.5.0-phase5',
        timestamp: new Date().toISOString(),
      });
    }
    if (req.method === 'POST' && url.pathname === '/devices/register') {
      return send(200, {
        token: 'tok-hb-fault',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        alreadyRegistered: false,
        account: hostAccount,
      });
    }
    if (req.method === 'POST' && url.pathname === '/presence/connect') {
      if (mode === '404') {
        // Legacy fallback succeeds and reflects activeSession
        return send(200, {
          serverTime: new Date().toISOString(),
          snapshot: makeSnapshot(hostAccount, { activeSession: session }),
        });
      }
      if (mode === '503') {
        return send(503, { error: 'UNAVAILABLE', message: 'Transient 503' });
      }
      // timeout mode: hold past requestTimeoutMs
      await new Promise((r) => setTimeout(r, 400));
      if (!res.writableEnded) {
        return send(200, {
          serverTime: new Date().toISOString(),
          snapshot: makeSnapshot(hostAccount, { activeSession: session }),
        });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/presence/heartbeat') {
      if (mode === '404') {
        return send(404, { error: 'NOT_FOUND', message: 'Route not found' });
      }
      if (mode === '503') {
        return send(503, { error: 'UNAVAILABLE', message: 'Transient 503' });
      }
      await new Promise((r) => setTimeout(r, 400));
      if (!res.writableEnded) {
        return send(200, {
          serverTime: new Date().toISOString(),
          snapshot: makeSnapshot(hostAccount, { activeSession: session }),
        });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === `/invites/${invite.inviteId}/respond`) {
      return send(200, {
        invite: { ...invite, status: 'accepted', resolvedAt: new Date().toISOString() },
        session,
        snapshot: makeSnapshot(hostAccount, { activeSession: session }),
      });
    }
    if (req.method === 'POST' && url.pathname === '/sessions/disconnect') {
      disconnectCalls += 1;
      return send(200, { disconnected: true, alreadyEnded: false });
    }
    return send(404, { error: 'NOT_FOUND' });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const stateFile = path.join(stubUserDataDir, `state-hb-fault-${Date.now()}.json`);
  const controller = new DesktopAuthAndInviteController(baseUrl, {
    stateFilePath: stateFile,
    heartbeatIntervalMs: 60_000,
    requestTimeoutMs: 120,
  });

  try {
    await controller.saveLocalProfile({ name: 'Host HB' });
    const acceptRes = await controller.respondToInvite({
      inviteId: invite.inviteId,
      action: 'accept',
      mediaSelection: { screenVideo: true, microphoneAudio: false, deviceAudio: false },
    });
    assert.equal(acceptRes.ok, true);
    assert.equal(acceptRes.data?.snapshot.activeSession?.sessionId, session.sessionId);

    // 8A: Heartbeat HTTP 404 immediately after Accept
    mode = '404';
    const st404 = await controller.establishRemotePresence('heartbeat');
    assert.equal(st404.snapshot?.activeSession?.sessionId, session.sessionId);
    assert.equal(st404.backendCompatibility?.compatible, false);
    assert.equal(disconnectCalls, 0);

    // 8B: Heartbeat HTTP 503 immediately after Accept
    mode = '503';
    const st503 = await controller.establishRemotePresence('heartbeat');
    assert.equal(st503.connectionState, 'reconnecting');
    assert.equal(st503.snapshot?.activeSession?.sessionId, session.sessionId);
    assert.equal(disconnectCalls, 0);

    // 8C: Heartbeat timeout immediately after Accept
    mode = 'timeout';
    const stTimeout = await controller.establishRemotePresence('heartbeat');
    assert.equal(stTimeout.connectionState, 'offline');
    assert.equal(stTimeout.snapshot?.activeSession?.sessionId, session.sessionId);
    assert.equal(disconnectCalls, 0);
  } finally {
    controller.stopPresenceHeartbeat();
    server.close();
  }
});

test('Phase 8E/8F & Phase 7: Missing snapshot on POST /invites and POST /sessions/disconnect is handled safely, and backend compatibility detects missing capabilities', async () => {
  const acct = makeAccount('acct-nosnap', 'ELM-NSNP-2345', 'NoSnap User');
  const invite = makeInvite('inv-nosnap');
  let advertiseCapabilities = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(200, {
        status: 'ok',
        phase: 'phase-5-staging-and-installer-pilot',
        protocolVersion: '0.5.0-phase5',
        timestamp: new Date().toISOString(),
        ...(advertiseCapabilities
          ? {
              capabilities: [
                'presence_heartbeat',
                'presence_lookup',
                'invite_cancel',
                'session_heartbeat',
                'mutation_snapshots',
              ],
            }
          : {}),
      });
    }
    if (req.method === 'POST' && url.pathname === '/devices/register') {
      return send(200, {
        token: 'tok-nosnap',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        alreadyRegistered: false,
        account: acct,
      });
    }
    if (req.method === 'POST' && url.pathname === '/presence/connect') {
      return send(200, {
        serverTime: new Date().toISOString(),
        snapshot: makeSnapshot(acct),
      });
    }
    if (req.method === 'POST' && url.pathname === '/invites') {
      // Omit `snapshot` field intentionally
      return send(201, { invite });
    }
    if (req.method === 'POST' && url.pathname === '/sessions/disconnect') {
      // Omit `snapshot` field intentionally (legacy / pre-fix Worker behavior)
      return send(200, {
        disconnected: true,
        alreadyEnded: false,
        receipt: {
          sessionId: 'sess-nosnap',
          reason: 'user_top_bar_disconnect',
          subReason: 'user_top_bar_disconnect',
          initiatedByAccountId: acct.accountId,
          terminatedAt: new Date().toISOString(),
          alreadyEnded: false,
          duplicateCallCount: 0,
          hostTracksStoppedCount: 0,
          peerConnectionsClosed: true,
          dataChannelsClosed: true,
          guestViewerCleared: true,
          permissionsInvalidated: true,
          signalingMembershipInvalidated: true,
          detectionTimeMs: 1,
        },
      });
    }
    return send(404, { error: 'NOT_FOUND' });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const stateFile = path.join(stubUserDataDir, `state-nosnap-${Date.now()}.json`);
  const controller = new DesktopAuthAndInviteController(baseUrl, {
    stateFilePath: stateFile,
    heartbeatIntervalMs: 60_000,
  });

  try {
    await controller.saveLocalProfile({ name: 'NoSnap User' });

    // Phase 7: Legacy backend without capabilities advertised -> incompatible
    const legacyCompat = await controller.checkBackendCompatibility();
    assert.equal(legacyCompat.checked, true);
    assert.equal(legacyCompat.compatible, false);
    assert.ok(legacyCompat.missingCapabilities.includes('presence_heartbeat'));

    // Phase 7: Updated backend advertising capabilities -> compatible
    advertiseCapabilities = true;
    const modernCompat = await controller.checkBackendCompatibility();
    assert.equal(modernCompat.checked, true);
    assert.equal(modernCompat.compatible, true);
    assert.deepEqual(modernCompat.missingCapabilities, []);

    // Phase 8E: POST /invites without snapshot builds compatible snapshot safely
    const invRes = await controller.sendFriendCodeInvite({
      friendCode: 'ELM-HOST-2345',
      intent: 'connect',
    });
    assert.equal(invRes.ok, true);
    assert.ok(invRes.data?.snapshot);
    assert.equal(invRes.data?.snapshot.outgoingInvite?.inviteId, invite.inviteId);

    // Phase 8F: POST /sessions/disconnect without snapshot clears activeSession safely
    const discRes = await controller.disconnectActiveSession({
      sessionId: 'sess-nosnap',
      reason: 'user_top_bar_disconnect',
      subReason: 'user_top_bar_disconnect',
    });
    assert.equal(discRes.ok, true);
    assert.ok(discRes.data?.snapshot);
    assert.equal(discRes.data?.snapshot.activeSession, null);
  } finally {
    controller.stopPresenceHeartbeat();
    server.close();
  }
});

test('Pre-open ICE failure attempts one controlled ICE restart and recovers without teardown', async () => {
  FakeRTCPeerConnection.instances = [];
  let disconnectCalls = 0;
  let seqCounter = 0;
  const pendingSignals: Array<{
    seq: number;
    senderAccountId: string;
    payload: { type: string; sdp?: string; negotiationId?: string };
  }> = [];

  const restore = installFakeBrowserGlobals({
    sendSessionSignal: async (input: {
      senderAccountId?: string;
      payload: { type: string; negotiationId?: string };
    }) => {
      if (input.payload.type === 'offer') {
        seqCounter += 1;
        pendingSignals.push({
          seq: seqCounter,
          senderAccountId: 'acct-guest',
          payload: {
            type: 'answer',
            sdp: 'v=0\r\nfake-answer\r\n',
            negotiationId: input.payload.negotiationId,
          },
        });
      }
      return { ok: true, status: 200, data: { admitted: true } };
    },
    pollSessionSignals: async (input: { afterSeq: number }) => {
      const signals = pendingSignals.filter((s) => s.seq > input.afterSeq);
      return { ok: true, status: 200, data: { signals } };
    },
    disconnectActiveSession: async () => {
      disconnectCalls += 1;
      return { ok: true, status: 200, data: { disconnected: true, alreadyEnded: false } };
    },
  });

  try {
    const ctrl = new ApprovedWebRtcSessionController(
      makeSession('sess-ice-recover'),
      () => {},
      { mode: 'remote', localRole: 'host', enableBackgroundLivenessTimer: false }
    );
    const pcHost = FakeRTCPeerConnection.instances[0];
    assert.ok(pcHost);
    assert.equal(pcHost.config?.iceCandidatePoolSize, 2);

    // Connect initially (poll delivers answer)
    const connectPromise = ctrl.connectAcceptedSession();
    await new Promise((r) => setTimeout(r, 80));
    await (ctrl as unknown as { pumpSignalsOnce: () => Promise<void> }).pumpSignalsOnce();
    await connectPromise;

    // Simulate pre-open ICE failure before DataChannel opens
    pcHost.iceConnectionState = 'failed';
    pcHost.oniceconnectionstatechange?.();

    // Wait for 250ms controlled ICE restart timer to fire; while negotiating, simulate ICE recovering
    await new Promise((r) => setTimeout(r, 150));
    const origCreateOffer = pcHost.createOffer.bind(pcHost);
    pcHost.createOffer = async (options?: RTCOfferOptions) => {
      if (options?.iceRestart) {
        pcHost.iceConnectionState = 'connected';
        pcHost.connectionState = 'connected';
      }
      return origCreateOffer(options);
    };
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(pcHost.restartIceCalls, 1, 'Must attempt exactly one controlled ICE restart');
    assert.ok(
      pcHost.createOfferCalls.some((opt) => opt?.iceRestart === true),
      'Must create an offer with { iceRestart: true }'
    );
    assert.equal(disconnectCalls, 0, 'Recovered ICE restart must not terminate session');
    assert.notEqual(ctrl.getSnapshot().connectionState, 'closed');
    ctrl.destroyLocalOnly('user_top_bar_disconnect', 'test_cleanup', { silent: true });
  } finally {
    restore();
  }
});

test('Pre-open ICE failure after one ICE restart terminates session cleanly', async () => {
  FakeRTCPeerConnection.instances = [];
  let disconnectReason: string | null = null;
  let disconnectSubReason: string | null = null;

  const restore = installFakeBrowserGlobals({
    sendSessionSignal: async () => ({ ok: true, status: 200, data: { admitted: true } }),
    pollSessionSignals: async () => ({ ok: true, status: 200, data: { signals: [] } }),
    disconnectActiveSession: async (input: { reason: string; subReason?: string }) => {
      disconnectReason = input.reason;
      disconnectSubReason = input.subReason ?? null;
      return { ok: true, status: 200, data: { disconnected: true, alreadyEnded: false } };
    },
  });

  try {
    const ctrl = new ApprovedWebRtcSessionController(
      makeSession('sess-ice-fail-twice'),
      () => {},
      { mode: 'remote', localRole: 'host', enableBackgroundLivenessTimer: false }
    );
    const pcHost = FakeRTCPeerConnection.instances[0];
    assert.ok(pcHost);

    // First pre-open ICE failure schedules 250ms ICE restart
    pcHost.iceConnectionState = 'failed';
    pcHost.oniceconnectionstatechange?.();

    // Wait for restart timer + 10s? No, trigger settle or simulate second failure after restart starts
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pcHost.restartIceCalls, 1);

    // Settle active negotiation so performControlledPreOpenIceRestart finishes while ICE is still failed
    const activeNeg = (ctrl as unknown as { activeNegotiation: { id: string } | null }).activeNegotiation;
    if (activeNeg) {
      (ctrl as unknown as { settleActiveNegotiation: (id: string) => void }).settleActiveNegotiation(activeNeg.id);
    }
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(disconnectReason, 'connection_lost');
    assert.equal(
      disconnectSubReason,
      'restrictive_network_stun_only_direct_connection_failed'
    );
    assert.equal(ctrl.getSnapshot().connectionState, 'closed');
  } finally {
    restore();
  }
});

test('Concurrent renegotiation and ICE restart are serialized without offer collisions', async () => {
  FakeRTCPeerConnection.instances = [];
  let inFlightCreateOffer = 0;
  let maxConcurrentOffers = 0;
  let seqCounter = 0;
  const pendingSignals: Array<{
    seq: number;
    senderAccountId: string;
    payload: { type: string; sdp?: string; negotiationId?: string };
  }> = [];

  const restore = installFakeBrowserGlobals({
    sendSessionSignal: async (input: {
      payload: { type: string; negotiationId?: string };
    }) => {
      if (input.payload.type === 'offer') {
        seqCounter += 1;
        pendingSignals.push({
          seq: seqCounter,
          senderAccountId: 'acct-guest',
          payload: {
            type: 'answer',
            sdp: 'v=0\r\nfake-answer\r\n',
            negotiationId: input.payload.negotiationId,
          },
        });
      }
      return { ok: true, status: 200, data: { admitted: true } };
    },
    pollSessionSignals: async (input: { afterSeq: number }) => {
      const signals = pendingSignals.filter((s) => s.seq > input.afterSeq);
      return { ok: true, status: 200, data: { signals } };
    },
  });

  try {
    const ctrl = new ApprovedWebRtcSessionController(
      makeSession('sess-serialize'),
      () => {},
      { mode: 'remote', localRole: 'host', enableBackgroundLivenessTimer: false }
    );
    const pcHost = FakeRTCPeerConnection.instances[0];
    assert.ok(pcHost);
    const origCreateOffer = pcHost.createOffer.bind(pcHost);
    pcHost.createOffer = async (options?: RTCOfferOptions) => {
      inFlightCreateOffer += 1;
      maxConcurrentOffers = Math.max(maxConcurrentOffers, inFlightCreateOffer);
      await new Promise((r) => setTimeout(r, 20));
      const res = await origCreateOffer(options);
      inFlightCreateOffer -= 1;
      return res;
    };

    const p1 = (ctrl as unknown as { renegotiateHostToGuest: () => Promise<void> }).renegotiateHostToGuest();
    const p2 = (ctrl as unknown as { renegotiateHostToGuest: (o?: { iceRestart?: boolean }) => Promise<void> }).renegotiateHostToGuest({ iceRestart: true });

    // Pump answers for both serialized negotiations
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 25));
      await (ctrl as unknown as { pumpSignalsOnce: () => Promise<void> }).pumpSignalsOnce();
    }
    await Promise.all([p1, p2]);

    assert.equal(maxConcurrentOffers, 1, 'Negotiations must be strictly serialized');
    assert.equal(pcHost.createOfferCalls.length, 2);
    assert.equal(pcHost.createOfferCalls[1]?.iceRestart, true);
    ctrl.destroyLocalOnly('user_top_bar_disconnect', 'test_cleanup', { silent: true });
  } finally {
    restore();
  }
});

test('409 SESSION_ALREADY_ENDED maps to clear user-facing disconnect vs connection-loss messages', async () => {
  for (const tc of [
    {
      serverMsg: 'Stale session event rejected: session s1 has already ended (user_top_bar_disconnect) at 2026-11-26T00:00:00Z',
      expectedSubstr: 'The other participant ended the session',
    },
    {
      serverMsg: 'Stale session event rejected: session s1 has already ended (connection_lost) at 2026-11-26T00:00:00Z',
      expectedSubstr: 'Connection lost',
    },
  ]) {
    FakeRTCPeerConnection.instances = [];
    let endedMsg: string | null = null;
    const restore = installFakeBrowserGlobals({
      sendSessionSignal: async () => ({
        ok: false,
        status: 409,
        errorCode: 'SESSION_ALREADY_ENDED',
        errorMessage: tc.serverMsg,
      }),
    });
    try {
      const ctrl = new ApprovedWebRtcSessionController(
        makeSession('sess-409-msg'),
        () => {},
        {
          mode: 'remote',
          localRole: 'host',
          enableBackgroundLivenessTimer: false,
          onSessionEndedRemotely: (ev) => {
            endedMsg = ev.message;
          },
        }
      );
      await ctrl.connectAcceptedSession();
      assert.ok(endedMsg, 'onSessionEndedRemotely must fire');
      assert.ok((endedMsg as string).includes(tc.expectedSubstr));
      assert.ok(!(endedMsg as string).includes('Stale session event rejected'));
    } finally {
      restore();
    }
  }
});

test('Rapid reconnect cancels pending ICE restart timer cleanly on teardown', async () => {
  FakeRTCPeerConnection.instances = [];
  let disconnectCalls = 0;
  const restore = installFakeBrowserGlobals({
    disconnectActiveSession: async () => {
      disconnectCalls += 1;
      return { ok: true, status: 200, data: { disconnected: true, alreadyEnded: false } };
    },
  });

  try {
    const ctrl = new ApprovedWebRtcSessionController(
      makeSession('sess-rapid-teardown'),
      () => {},
      { mode: 'remote', localRole: 'host', enableBackgroundLivenessTimer: false }
    );
    const pcHost = FakeRTCPeerConnection.instances[0];
    assert.ok(pcHost);

    pcHost.iceConnectionState = 'failed';
    pcHost.oniceconnectionstatechange?.();

    // Destroy immediately before the 250ms ICE restart timer fires
    ctrl.destroyLocalOnly('user_top_bar_disconnect', 'rapid_reconnect', { silent: true });
    await new Promise((r) => setTimeout(r, 320));

    assert.equal(pcHost.restartIceCalls, 0, 'Cancelled timer must not trigger restartIce after teardown');
    assert.equal(disconnectCalls, 0, 'destroyLocalOnly must not send server disconnect');
  } finally {
    restore();
  }
});
