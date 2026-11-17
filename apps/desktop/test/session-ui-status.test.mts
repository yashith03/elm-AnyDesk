import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostMediaRuntimeState } from '@elm/protocol';
import {
  getChatStatusDisplay,
  getSessionStageStatus,
  getTransportStatusDisplay,
} from '../src/shared/session-ui-status.ts';

function makeHostMedia(
  overrides?: Partial<HostMediaRuntimeState>
): HostMediaRuntimeState {
  return {
    screenVideo: {
      source: 'screenVideo',
      approved: false,
      active: false,
      status: 'off',
      message: 'Screen Video is OFF.',
      trackId: null,
      streamId: null,
      label: null,
    },
    microphoneAudio: {
      source: 'microphoneAudio',
      approved: false,
      active: false,
      status: 'off',
      message: 'Microphone Audio is OFF.',
      trackId: null,
      streamId: null,
      label: null,
    },
    deviceAudio: {
      source: 'deviceAudio',
      approved: false,
      active: false,
      status: 'off',
      message: 'Device Audio is OFF.',
      trackId: null,
      streamId: null,
      label: null,
    },
    ...overrides,
  };
}

test('getTransportStatusDisplay reflects actual WebRTC transport and ICE state instead of hardcoded Connected', () => {
  assert.equal(
    getTransportStatusDisplay({
      connectionState: 'connecting',
      iceConnectionState: 'checking',
      teardownReceipt: null,
    }).label,
    'Connecting'
  );
  assert.equal(
    getTransportStatusDisplay({
      connectionState: 'connected',
      iceConnectionState: 'connected',
      teardownReceipt: null,
    }).label,
    'Connected'
  );
  assert.equal(
    getTransportStatusDisplay({
      connectionState: 'failed',
      iceConnectionState: 'failed',
      teardownReceipt: null,
    }).label,
    'Connection Failed'
  );
  assert.equal(
    getTransportStatusDisplay({
      connectionState: 'disconnected',
      iceConnectionState: 'disconnected',
      teardownReceipt: null,
    }).label,
    'Reconnecting'
  );
});

test('getChatStatusDisplay reports Chat Connected only when DataChannel is open', () => {
  assert.deepEqual(getChatStatusDisplay({ dataChannelState: 'closed' }), {
    label: 'Chat Offline',
    isOpen: false,
  });
  assert.deepEqual(getChatStatusDisplay({ dataChannelState: 'connecting' }), {
    label: 'Chat Connecting',
    isOpen: false,
  });
  assert.deepEqual(getChatStatusDisplay({ dataChannelState: 'open' }), {
    label: 'Chat Connected',
    isOpen: true,
  });
});

test('getSessionStageStatus gives role-specific Host status from local capture state', () => {
  const readySnap = {
    connectionState: 'connected' as const,
    iceConnectionState: 'connected' as const,
    hostMediaState: makeHostMedia({
      screenVideo: {
        source: 'screenVideo',
        approved: true,
        active: false,
        status: 'approved_awaiting_start',
        message: 'Awaiting Start Sharing.',
        trackId: null,
        streamId: null,
        label: null,
      },
    }),
    guestVideoTracksCount: 0,
    teardownReceipt: null,
  };

  assert.equal(
    getSessionStageStatus({
      isLocalHost: true,
      isStartingShare: false,
      webrtcSnap: readySnap,
    }).headline,
    'Ready to Share'
  );

  assert.equal(
    getSessionStageStatus({
      isLocalHost: true,
      isStartingShare: true,
      webrtcSnap: readySnap,
    }).headline,
    'Starting'
  );

  const sharingSnap = {
    ...readySnap,
    hostMediaState: makeHostMedia({
      screenVideo: {
        source: 'screenVideo',
        approved: true,
        active: true,
        status: 'active',
        message: 'Sharing Screen Video (Notepad).',
        trackId: 't1',
        streamId: 's1',
        label: 'Notepad',
      },
    }),
  };
  assert.equal(
    getSessionStageStatus({
      isLocalHost: true,
      isStartingShare: false,
      webrtcSnap: sharingSnap,
    }).headline,
    'Sharing Your Screen'
  );

  const errorSnap = {
    ...readySnap,
    hostMediaState: makeHostMedia({
      screenVideo: {
        source: 'screenVideo',
        approved: true,
        active: false,
        status: 'permission_denied',
        message: 'Screen capture permission denied.',
        trackId: null,
        streamId: null,
        label: null,
      },
    }),
  };
  const errStatus = getSessionStageStatus({
    isLocalHost: true,
    isStartingShare: false,
    webrtcSnap: errorSnap,
  });
  assert.equal(errStatus.headline, 'Capture Error');
  assert.equal(errStatus.detail, 'Screen capture permission denied.');
});

test('getSessionStageStatus gives Guest status distinguishing connecting, waiting for host, and receiving video', () => {
  const baseMedia = makeHostMedia();

  assert.equal(
    getSessionStageStatus({
      isLocalHost: false,
      isStartingShare: false,
      webrtcSnap: {
        connectionState: 'connecting',
        iceConnectionState: 'checking',
        hostMediaState: baseMedia,
        guestVideoTracksCount: 0,
        teardownReceipt: null,
      },
    }).headline,
    'Connecting'
  );

  assert.equal(
    getSessionStageStatus({
      isLocalHost: false,
      isStartingShare: false,
      webrtcSnap: {
        connectionState: 'connected',
        iceConnectionState: 'connected',
        hostMediaState: baseMedia,
        guestVideoTracksCount: 0,
        teardownReceipt: null,
      },
    }).headline,
    'Waiting for Host'
  );

  assert.equal(
    getSessionStageStatus({
      isLocalHost: false,
      isStartingShare: false,
      webrtcSnap: {
        connectionState: 'connected',
        iceConnectionState: 'connected',
        hostMediaState: baseMedia,
        guestVideoTracksCount: 1,
        teardownReceipt: null,
      },
    }).headline,
    'Receiving Video'
  );
});
