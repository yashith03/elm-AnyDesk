import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ApprovedSessionSummary, WebRtcSignalPayload } from '@elm/protocol';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !path.extname(specifier) &&
      context.parentURL?.startsWith('file:')
    ) {
      const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), `${specifier}.ts`);
      if (fs.existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

interface MockTrack {
  id: string;
  kind: 'video' | 'audio';
  label: string;
  enabled: boolean;
  readyState: 'live' | 'ended';
  listeners: Map<string, Array<() => void>>;
  addEventListener: (ev: string, fn: () => void) => void;
  stop: () => void;
  dispatchEnded: () => void;
}

function createMockTrack(id: string, label: string, kind: 'video' | 'audio' = 'video'): MockTrack {
  const listeners = new Map<string, Array<() => void>>();
  const track: MockTrack = {
    id,
    kind,
    label,
    enabled: true,
    readyState: 'live',
    listeners,
    addEventListener(ev: string, fn: () => void) {
      const list = listeners.get(ev) ?? [];
      list.push(fn);
      listeners.set(ev, list);
    },
    stop() {
      this.readyState = 'ended';
    },
    dispatchEnded() {
      this.readyState = 'ended';
      for (const fn of listeners.get('ended') ?? []) fn();
    },
  };
  return track;
}

class MockMediaStream {
  readonly id: string;
  private tracks: MockTrack[];
  constructor(tracks: MockTrack[] = []) {
    this.id = `stream-${Math.random().toString(36).slice(2, 8)}`;
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  removeTrack(t: MockTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

function setupWebRtcTestEnv() {
  const sentSignals: Array<{ payload: WebRtcSignalPayload }> = [];
  let selectedSourceId: string | null = null;
  let nextTrackSeq = 0;
  let nextOfferSeq = 0;
  let replaceTrackShouldFail = false;
  let customGetDisplayMedia: ((srcId: string | null) => Promise<MockMediaStream>) | null = null;

  const createdPeers: MockPeerConnection[] = [];

  class MockPeerConnection {
    signalingState: RTCSignalingState = 'stable';
    connectionState: RTCPeerConnectionState = 'connected';
    iceConnectionState: RTCIceConnectionState = 'connected';
    remoteDescription: RTCSessionDescription | null = null;
    localDescription: RTCSessionDescription | null = null;
    readonly transceivers: Array<{
      mid: string;
      direction: RTCRtpTransceiverDirection;
      sender: {
        track: MockTrack | null;
        replaceTrackCalls: Array<MockTrack | null>;
        replaceTrack: (next: MockTrack | null) => Promise<void>;
      };
    }> = [];
    createOfferCalls = 0;
    addTrackCalls = 0;
    removeTrackCalls = 0;
    setRemoteDescriptionCalls: Array<{ type: string; sdp: string }> = [];
    dataChannels: Array<{
      label: string;
      readyState: RTCDataChannelState;
      close: () => void;
      send: () => void;
    }> = [];

    constructor() {
      createdPeers.push(this);
    }

    createDataChannel(label: string) {
      const ch = {
        label,
        readyState: 'open' as RTCDataChannelState,
        close() {
          this.readyState = 'closed';
        },
        send() {},
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
      };
      this.dataChannels.push(ch);
      return ch;
    }

    addTrack(track: MockTrack) {
      this.addTrackCalls += 1;
      const mid = String(this.transceivers.length);
      const sender = {
        track,
        replaceTrackCalls: [] as Array<MockTrack | null>,
        async replaceTrack(next: MockTrack | null) {
          this.replaceTrackCalls.push(next);
          if (replaceTrackShouldFail && next !== null) {
            throw new Error('Simulated replaceTrack failure');
          }
          this.track = next;
        },
      };
      this.transceivers.push({ mid, direction: 'sendonly', sender });
      return sender;
    }

    removeTrack(sender: { track: MockTrack | null }) {
      this.removeTrackCalls += 1;
      const tr = this.transceivers.find((t) => t.sender === sender);
      if (tr) {
        tr.direction = 'inactive';
        tr.sender.track = null;
      }
    }

    getSenders() {
      return this.transceivers.map((t) => t.sender);
    }

    getTransceivers() {
      return [...this.transceivers];
    }

    async createOffer() {
      this.createOfferCalls += 1;
      nextOfferSeq += 1;
      const mids = this.transceivers.map((t) => `${t.mid}:${t.direction}`).join(',');
      return { type: 'offer' as const, sdp: `offer-${nextOfferSeq}|${mids}` };
    }

    async setLocalDescription(desc: RTCSessionDescriptionInit) {
      this.localDescription = desc as RTCSessionDescription;
      if (desc.type === 'offer') {
        this.signalingState = 'have-local-offer';
      } else if (desc.type === 'rollback') {
        this.signalingState = 'stable';
      }
    }

    async setRemoteDescription(desc: RTCSessionDescriptionInit) {
      this.setRemoteDescriptionCalls.push({
        type: String(desc.type),
        sdp: String(desc.sdp ?? ''),
      });
      this.remoteDescription = desc as RTCSessionDescription;
      if (desc.type === 'answer') {
        this.signalingState = 'stable';
      }
    }

    async addIceCandidate() {}
    async getStats() {
      return new Map();
    }
    close() {
      this.connectionState = 'closed';
      this.signalingState = 'closed';
    }
  }

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        async getDisplayMedia() {
          if (customGetDisplayMedia) {
            return customGetDisplayMedia(selectedSourceId);
          }
          nextTrackSeq += 1;
          const track = createMockTrack(
            `video-track-${nextTrackSeq}`,
            `Source ${selectedSourceId ?? 'default'}`
          );
          return new MockMediaStream([track]);
        },
      },
    },
  });
  Object.assign(globalThis, {
    RTCPeerConnection: MockPeerConnection,
    MediaStream: MockMediaStream,
    window: {
      elmDesktop: {
        async selectShareableSource(id: string) {
          selectedSourceId = id;
        },
        async sendSessionSignal(params: { payload: WebRtcSignalPayload }) {
          sentSignals.push({ payload: params.payload });
          return { ok: true };
        },
        async pollSessionSignals() {
          return { ok: true, data: { signals: [] } };
        },
        async disconnectActiveSession() {
          return { ok: true };
        },
        async stopWasapiLoopback() {},
      },
    },
  });

  const session: ApprovedSessionSummary = {
    sessionId: 'sess-reneg-1',
    inviteId: 'inv-1',
    hostAccountId: 'acct-host',
    guestAccountId: 'acct-guest',
    hostFriendCode: 'ELM-HOST-0001',
    guestFriendCode: 'ELM-GUES-0002',
    hostMediaSelection: {
      screenVideo: true,
      microphoneAudio: false,
      deviceAudio: false,
    },
    acceptedAt: new Date().toISOString(),
  };

  return {
    session,
    sentSignals,
    createdPeers,
    setReplaceTrackFail(v: boolean) {
      replaceTrackShouldFail = v;
    },
    setCustomGetDisplayMedia(fn: ((srcId: string | null) => Promise<MockMediaStream>) | null) {
      customGetDisplayMedia = fn;
    },
  };
}

test('screen source switching reuses RTCRtpSender via replaceTrack, preserves MID order, avoids renegotiation, and handles races & teardown', async () => {
  const env = setupWebRtcTestEnv();
  const { ApprovedWebRtcSessionController } = await import(
    '../src/renderer/webrtc-session.ts'
  );

  const ctrl = new ApprovedWebRtcSessionController(env.session, () => {}, {
    mode: 'remote',
    localRole: 'host',
    enableBackgroundLivenessTimer: false,
  });

  const pc = env.createdPeers[0];

  // Initial connect (creates DataChannel + initial offer)
  const connectPromise = ctrl.connectAcceptedSession();
  await new Promise((r) => setTimeout(r, 20));
  const initialOffer = env.sentSignals.find((s) => s.payload.type === 'offer');
  assert.ok(initialOffer && initialOffer.payload.type === 'offer');
  await ctrl.injectRemoteSignalForTest('host', {
    type: 'answer',
    sdp: 'answer-initial',
    negotiationId: initialOffer.payload.negotiationId,
  });
  await connectPromise;
  assert.equal(pc.signalingState, 'stable');

  // Start initial screen share (adds 1 screen-video sender + 1 offer)
  const startPromise = ctrl.startHostSource('screenVideo', {
    selectedSourceId: 'screen:0:0',
  });
  await new Promise((r) => setTimeout(r, 20));
  const startOffer = env.sentSignals.filter((s) => s.payload.type === 'offer')[1];
  assert.ok(startOffer && startOffer.payload.type === 'offer');
  await ctrl.injectRemoteSignalForTest('host', {
    type: 'answer',
    sdp: 'answer-start',
    negotiationId: startOffer.payload.negotiationId,
  });
  await startPromise;

  assert.equal(pc.addTrackCalls, 1);
  assert.equal(pc.transceivers.length, 1);
  const initialOffersCount = pc.createOfferCalls;
  const firstTrack = pc.transceivers[0].sender.track!;

  // 1-3: Switch screen source 10 times -> uses replaceTrack, preserves 1 transceiver/MID, 0 new offers
  for (let i = 1; i <= 10; i++) {
    const targetId = i % 2 === 0 ? `window:${i}:0` : `screen:${i}:0`;
    const snap = await ctrl.switchScreenSource(targetId);
    assert.equal(snap.hostMediaState.screenVideo.active, true);
    assert.equal(pc.addTrackCalls, 1, 'Must never add duplicate video senders');
    assert.equal(pc.removeTrackCalls, 0, 'Must never remove screen sender on switch');
    assert.equal(pc.transceivers.length, 1);
    assert.equal(pc.transceivers[0].mid, '0');
    assert.equal(pc.createOfferCalls, initialOffersCount, 'Must avoid unnecessary SDP renegotiation');
  }

  // 7: Old track ended callback race must NOT stop the active switched source
  firstTrack.dispatchEnded();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctrl.getSnapshot().hostMediaState.screenVideo.active, true);
  assert.notEqual(pc.transceivers[0].sender.track, firstTrack);

  // 9: replaceTrack failure preserves active stream without leaking new track or ending session
  const liveTrackBeforeFail = pc.transceivers[0].sender.track!;
  let failedNewTrack: MockTrack | null = null;
  env.setCustomGetDisplayMedia(async () => {
    failedNewTrack = createMockTrack('video-fail-track', 'Fail Window');
    return new MockMediaStream([failedNewTrack]);
  });
  env.setReplaceTrackFail(true);
  const failSnap = await ctrl.switchScreenSource('window:fail:0');
  assert.equal(failSnap.hostMediaState.screenVideo.active, true);
  assert.equal(pc.transceivers[0].sender.track, liveTrackBeforeFail);
  assert.equal(failedNewTrack!.readyState, 'ended', 'Failed new track must be stopped without leaking');
  env.setReplaceTrackFail(false);
  env.setCustomGetDisplayMedia(null);

  // 6: Rapid overlapping source switches -> only latest source wins
  let resolveSlow!: (s: MockMediaStream) => void;
  const slowTrack = createMockTrack('slow-old-track', 'Slow Old');
  const fastTrack = createMockTrack('fast-latest-track', 'Fast Latest');
  let callIdx = 0;
  env.setCustomGetDisplayMedia(async () => {
    callIdx += 1;
    if (callIdx === 1) {
      return new Promise<MockMediaStream>((r) => {
        resolveSlow = r;
      });
    }
    return new MockMediaStream([fastTrack]);
  });
  const pSlow = ctrl.switchScreenSource('window:slow:1');
  const pFast = ctrl.switchScreenSource('window:fast:2');
  await pFast;
  resolveSlow(new MockMediaStream([slowTrack]));
  await pSlow;
  assert.equal(pc.transceivers[0].sender.track, fastTrack);
  assert.equal(slowTrack.readyState, 'ended', 'Superseded slow track must be stopped immediately');
  env.setCustomGetDisplayMedia(null);

  // 8: Stop Sharing -> Start Sharing reuses existing sender with replaceTrack(null) and 0 new transceivers
  await ctrl.stopHostSource('screenVideo');
  assert.equal(ctrl.getSnapshot().hostMediaState.screenVideo.active, false);
  assert.equal(pc.transceivers[0].sender.track, null);
  assert.equal(pc.removeTrackCalls, 0);

  await ctrl.startHostSource('screenVideo', { selectedSourceId: 'screen:0:0' });
  assert.equal(ctrl.getSnapshot().hostMediaState.screenVideo.active, true);
  assert.equal(pc.addTrackCalls, 1, 'Restarting after Stop Sharing must reuse existing sender');
  assert.equal(pc.transceivers.length, 1);

  // 4 & 5: Concurrent negotiation serialization & stale answer rejection
  const r1 = (ctrl as unknown as { renegotiateHostToGuest: () => Promise<void> }).renegotiateHostToGuest();
  const r2 = (ctrl as unknown as { renegotiateHostToGuest: () => Promise<void> }).renegotiateHostToGuest();
  await new Promise((r) => setTimeout(r, 20));
  const offersSoFar = env.sentSignals.filter((s) => s.payload.type === 'offer');
  const offer1 = offersSoFar[offersSoFar.length - 1];
  assert.ok(offer1 && offer1.payload.type === 'offer');
  const countDuringOffer1 = offersSoFar.length;

  // Inject stale answer with wrong negotiationId -> must be ignored, r2 must NOT fire yet
  await ctrl.injectRemoteSignalForTest('host', {
    type: 'answer',
    sdp: 'stale-answer',
    negotiationId: 'wrong-neg-id',
  });
  assert.equal(pc.signalingState, 'have-local-offer');
  assert.equal(
    env.sentSignals.filter((s) => s.payload.type === 'offer').length,
    countDuringOffer1,
    'Second queued negotiation must wait until matching answer arrives'
  );

  // Inject matching answer for offer1 -> r1 completes, r2 starts
  await ctrl.injectRemoteSignalForTest('host', {
    type: 'answer',
    sdp: 'valid-answer-1',
    negotiationId: offer1.payload.negotiationId,
  });
  await r1;
  await new Promise((r) => setTimeout(r, 20));
  const offersAfterR1 = env.sentSignals.filter((s) => s.payload.type === 'offer');
  assert.equal(offersAfterR1.length, countDuringOffer1 + 1);
  const offer2 = offersAfterR1[offersAfterR1.length - 1];
  assert.ok(offer2 && offer2.payload.type === 'offer');
  await ctrl.injectRemoteSignalForTest('host', {
    type: 'answer',
    sdp: 'valid-answer-2',
    negotiationId: offer2.payload.negotiationId,
  });
  await r2;
  assert.equal(pc.signalingState, 'stable');

  // 10: Explicit session termination after multiple source changes
  await ctrl.executeIdempotentTeardown('user_top_bar_disconnect', {
    subReason: 'test_end',
  });
  assert.equal(pc.connectionState, 'closed');
});
