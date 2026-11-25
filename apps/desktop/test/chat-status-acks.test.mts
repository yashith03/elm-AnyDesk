import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ApprovedSessionSummary } from '@elm/protocol';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !path.extname(specifier) &&
      context.parentURL?.startsWith('file:')
    ) {
      const candidate = path.resolve(
        path.dirname(fileURLToPath(context.parentURL)),
        `${specifier}.ts`
      );
      if (fs.existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

test('WhatsApp-style Chat: real names, sent -> delivered -> seen ACKs for text & chunked images, monotonic/cross-session guards, and teardown cleanup', async () => {
  const sentFramesHost: string[] = [];
  const sentFramesGuest: string[] = [];

  class MockPeerConnection {
    signalingState: RTCSignalingState = 'stable';
    connectionState: RTCPeerConnectionState = 'connected';
    iceConnectionState: RTCIceConnectionState = 'connected';
    remoteDescription: RTCSessionDescription | null = null;
    localDescription: RTCSessionDescription | null = null;
    ondatachannel: ((ev: { channel: MockDataChannel }) => void) | null = null;
    createDataChannel(label: string) {
      return new MockDataChannel(label, sentFramesHost);
    }
    getSenders() {
      return [];
    }
    getTransceivers() {
      return [];
    }
    async createOffer() {
      return { type: 'offer' as const, sdp: 'v=0' };
    }
    async setLocalDescription(d: RTCSessionDescriptionInit) {
      this.localDescription = d as RTCSessionDescription;
    }
    async setRemoteDescription(d: RTCSessionDescriptionInit) {
      this.remoteDescription = d as RTCSessionDescription;
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

  class MockDataChannel {
    readonly label: string;
    readyState: RTCDataChannelState = 'open';
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    private readonly sink: string[];
    constructor(label: string, sink: string[]) {
      this.label = label;
      this.sink = sink;
    }
    send(data: string) {
      this.sink.push(data);
    }
    close() {
      this.readyState = 'closed';
    }
  }

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: {} },
  });
  let lastOfferNegId: string | undefined;
  Object.assign(globalThis, {
    RTCPeerConnection: MockPeerConnection,
    MediaStream: class {},
    window: {
      elmDesktop: {
        async sendSessionSignal(params: { payload: { type: string; negotiationId?: string } }) {
          if (params.payload.type === 'offer') {
            lastOfferNegId = params.payload.negotiationId;
          }
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

  const { ApprovedWebRtcSessionController } = await import(
    '../src/renderer/webrtc-session.ts'
  );

  const session: ApprovedSessionSummary = {
    sessionId: 'sess-chat-ack-1',
    inviteId: 'inv-chat-1',
    hostAccountId: 'acct-host',
    guestAccountId: 'acct-guest',
    hostFriendCode: 'ELM-HOST-1111',
    guestFriendCode: 'ELM-GUES-2222',
    hostDisplayName: 'Elm Device',
    guestDisplayName: 'Elm Device',
    hostMediaSelection: {
      screenVideo: false,
      microphoneAudio: false,
      deviceAudio: false,
    },
    acceptedAt: new Date().toISOString(),
  };

  const ctrl = new ApprovedWebRtcSessionController(session, () => {}, {
    mode: 'remote',
    localRole: 'host',
    enableBackgroundLivenessTimer: false,
  });
  ctrl.setLocalDisplayName('Alice Host');

  // Attach open DataChannel on host
  const connectPromise = ctrl.connectAcceptedSession();
  await new Promise((r) => setTimeout(r, 15));
  await ctrl.injectRemoteSignalForTest('host', {
    type: 'answer',
    sdp: 'v=0',
    negotiationId: lastOfferNegId,
  });
  await connectPromise;
  const hostChannel = (ctrl as unknown as { hostDataChannel: MockDataChannel })
    .hostDataChannel;
  assert.ok(hostChannel);
  hostChannel.onopen?.();

  // 1. Outgoing text message uses local profile name ("Alice Host") and starts as 'sent'
  const sentText = await ctrl.sendChatMessageOverDataChannel({
    sender: 'host',
    text: 'Hello Bob',
  });
  assert.equal(sentText.senderDisplayName, 'Alice Host');
  assert.equal(ctrl.getSnapshot().messageStatusesById[sentText.messageId], 'sent');

  // 2. Cross-session chat-delivered ACK is ignored
  hostChannel.onmessage?.({
    data: JSON.stringify({
      __elmControl: 'chat-delivered',
      sender: 'guest',
      sessionId: 'other-session-id',
      messageId: sentText.messageId,
    }),
  });
  assert.equal(ctrl.getSnapshot().messageStatusesById[sentText.messageId], 'sent');

  // 3. Matching-session chat-delivered ACK -> 'delivered'
  hostChannel.onmessage?.({
    data: JSON.stringify({
      __elmControl: 'chat-delivered',
      sender: 'guest',
      sessionId: session.sessionId,
      messageId: sentText.messageId,
    }),
  });
  assert.equal(
    ctrl.getSnapshot().messageStatusesById[sentText.messageId],
    'delivered'
  );

  // 4. chat-seen ACK -> 'seen', and late/duplicate chat-delivered never regresses 'seen'
  hostChannel.onmessage?.({
    data: JSON.stringify({
      __elmControl: 'chat-seen',
      sender: 'guest',
      sessionId: session.sessionId,
      messageIds: [sentText.messageId],
    }),
  });
  assert.equal(ctrl.getSnapshot().messageStatusesById[sentText.messageId], 'seen');
  hostChannel.onmessage?.({
    data: JSON.stringify({
      __elmControl: 'chat-delivered',
      sender: 'guest',
      sessionId: session.sessionId,
      messageId: sentText.messageId,
    }),
  });
  assert.equal(ctrl.getSnapshot().messageStatusesById[sentText.messageId], 'seen');

  // 5. Outgoing image attachment starts as 'sent' and transitions delivered -> seen
  const imgRes = ctrl.sendChatImageOverDataChannel({
    sender: 'host',
    senderAccountId: session.hostAccountId,
    senderDisplayName: 'Elm Device',
    text: 'pic.png',
    mimeType: 'image/png',
    byteLength: 16,
    dataUrl: 'data:image/png;base64,AAAA',
  });
  assert.equal(imgRes.ok, true);
  if (imgRes.ok) {
    assert.equal(imgRes.message.senderDisplayName, 'Alice Host');
    assert.equal(
      ctrl.getSnapshot().messageStatusesById[imgRes.message.messageId],
      'sent'
    );
    hostChannel.onmessage?.({
      data: JSON.stringify({
        __elmControl: 'chat-seen',
        sender: 'guest',
        sessionId: session.sessionId,
        messageIds: [imgRes.message.messageId],
      }),
    });
    assert.equal(
      ctrl.getSnapshot().messageStatusesById[imgRes.message.messageId],
      'seen'
    );
  }

  // 6. Incoming message with generic "Elm Device" adopts peer-contact-card name & sends chat-delivered + chat-seen
  hostChannel.onmessage?.({
    data: JSON.stringify({
      __elmControl: 'peer-contact-card',
      sender: 'guest',
      name: 'Bob Viewer',
      email: 'bob@example.com',
      phone: '+1 555-0100',
    }),
  });
  sentFramesHost.length = 0;
  const incomingId = 'incoming-msg-1';
  hostChannel.onmessage?.({
    data: JSON.stringify({
      messageId: incomingId,
      sessionId: session.sessionId,
      senderAccountId: session.guestAccountId,
      senderDisplayName: 'Elm Device',
      text: 'Hi Alice!',
      sentAt: new Date().toISOString(),
    }),
  });
  const incomingMsg = ctrl
    .getSnapshot()
    .messages.find((m) => m.messageId === incomingId);
  assert.equal(incomingMsg?.senderDisplayName, 'Bob Viewer');
  assert.ok(
    sentFramesHost.some((f) => {
      const p = JSON.parse(f);
      return p.__elmControl === 'chat-delivered' && p.messageId === incomingId;
    }),
    'Must send chat-delivered ACK on incoming message arrival'
  );

  ctrl.markMessagesSeen([incomingId]);
  assert.ok(
    sentFramesHost.some((f) => {
      const p = JSON.parse(f);
      return (
        p.__elmControl === 'chat-seen' &&
        Array.isArray(p.messageIds) &&
        p.messageIds.includes(incomingId)
      );
    }),
    'Must send chat-seen ACK when markMessagesSeen is called'
  );

  // 7. Teardown clears all messages and statuses
  await ctrl.executeIdempotentTeardown('user_top_bar_disconnect', {
    subReason: 'test_end',
  });
  assert.equal(ctrl.getSnapshot().messages.length, 0);
  assert.deepEqual(ctrl.getSnapshot().messageStatusesById, {});
  void sentFramesGuest;
});
