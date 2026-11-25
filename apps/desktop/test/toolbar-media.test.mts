import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { HostMediaRuntimeState } from '@elm/protocol';
import { computeHostToolbarMediaControls } from '../src/shared/toolbar-media.ts';

function makeHostMediaState(
  overrides?: Partial<HostMediaRuntimeState>
): HostMediaRuntimeState {
  return {
    screenVideo: {
      source: 'screenVideo',
      approved: true,
      active: false,
      status: 'approved_awaiting_start',
      message: '',
      trackId: null,
      streamId: null,
      label: null,
      ...(overrides?.screenVideo ?? {}),
    },
    microphoneAudio: {
      source: 'microphoneAudio',
      approved: true,
      active: false,
      status: 'approved_awaiting_start',
      message: '',
      trackId: null,
      streamId: null,
      label: null,
      ...(overrides?.microphoneAudio ?? {}),
    },
    deviceAudio: {
      source: 'deviceAudio',
      approved: true,
      active: false,
      status: 'approved_awaiting_start',
      message: '',
      trackId: null,
      streamId: null,
      label: null,
      ...(overrides?.deviceAudio ?? {}),
    },
  };
}

test('computeHostToolbarMediaControls maps approved, starting, active, muted, unavailable, and denied states', () => {
  const approvedAll = computeHostToolbarMediaControls({
    hostMediaState: makeHostMediaState(),
    hostMicMutedLocally: false,
    isStartingShare: false,
  });
  assert.equal(approvedAll.myMic.state, 'approved');
  assert.equal(approvedAll.myMic.disabled, false);
  assert.equal(approvedAll.deviceSound.state, 'approved');
  assert.equal(approvedAll.deviceSound.disabled, false);
  assert.equal(approvedAll.myScreen.state, 'approved');
  assert.equal(approvedAll.myScreen.disabled, false);
  assert.equal(approvedAll.sourcePicker.disabled, false);

  const startingAll = computeHostToolbarMediaControls({
    hostMediaState: makeHostMediaState({
      microphoneAudio: {
        source: 'microphoneAudio',
        approved: true,
        active: false,
        status: 'starting',
        message: '',
        trackId: null,
        streamId: null,
        label: null,
      },
      deviceAudio: {
        source: 'deviceAudio',
        approved: true,
        active: false,
        status: 'starting',
        message: '',
        trackId: null,
        streamId: null,
        label: null,
      },
      screenVideo: {
        source: 'screenVideo',
        approved: true,
        active: false,
        status: 'starting',
        message: '',
        trackId: null,
        streamId: null,
        label: null,
      },
    }),
    hostMicMutedLocally: false,
    isStartingShare: false,
  });
  assert.equal(startingAll.myMic.state, 'starting');
  assert.equal(startingAll.myMic.disabled, true);
  assert.equal(startingAll.deviceSound.state, 'starting');
  assert.equal(startingAll.deviceSound.disabled, true);
  assert.equal(startingAll.myScreen.state, 'starting');
  assert.equal(startingAll.myScreen.disabled, true);

  const activeAll = computeHostToolbarMediaControls({
    hostMediaState: makeHostMediaState({
      microphoneAudio: {
        source: 'microphoneAudio',
        approved: true,
        active: true,
        status: 'active',
        message: '',
        trackId: null,
        streamId: null,
        label: null,
      },
      deviceAudio: {
        source: 'deviceAudio',
        approved: true,
        active: true,
        status: 'active',
        message: '',
        trackId: null,
        streamId: null,
        label: null,
      },
      screenVideo: {
        source: 'screenVideo',
        approved: true,
        active: true,
        status: 'active',
        message: '',
        trackId: null,
        streamId: null,
        label: null,
      },
    }),
    hostMicMutedLocally: true,
    isStartingShare: false,
  });
  assert.equal(activeAll.myMic.state, 'muted');
  assert.equal(activeAll.deviceSound.state, 'active');
  assert.equal(activeAll.myScreen.state, 'sharing');

  const deniedAndUnsupported = computeHostToolbarMediaControls({
    hostMediaState: makeHostMediaState({
      microphoneAudio: {
        source: 'microphoneAudio',
        approved: true,
        active: false,
        status: 'permission_denied',
        message: 'Denied',
        trackId: null,
        streamId: null,
        label: null,
      },
      deviceAudio: {
        source: 'deviceAudio',
        approved: true,
        active: false,
        status: 'unsupported',
        message: 'No endpoint',
        trackId: null,
        streamId: null,
        label: null,
      },
    }),
    hostMicMutedLocally: false,
    isStartingShare: false,
  });
  assert.equal(deniedAndUnsupported.myMic.state, 'denied');
  assert.equal(deniedAndUnsupported.myMic.disabled, true);
  assert.equal(deniedAndUnsupported.deviceSound.state, 'unavailable');
  assert.equal(deniedAndUnsupported.deviceSound.disabled, true);

  const unapprovedAll = computeHostToolbarMediaControls({
    hostMediaState: makeHostMediaState({
      microphoneAudio: {
        source: 'microphoneAudio',
        approved: false,
        active: false,
        status: 'off',
        message: '',
        trackId: null,
        streamId: null,
        label: null,
      },
      deviceAudio: {
        source: 'deviceAudio',
        approved: false,
        active: false,
        status: 'off',
        message: '',
        trackId: null,
        streamId: null,
        label: null,
      },
      screenVideo: {
        source: 'screenVideo',
        approved: false,
        active: false,
        status: 'off',
        message: '',
        trackId: null,
        streamId: null,
        label: null,
      },
    }),
    hostMicMutedLocally: false,
    isStartingShare: false,
  });
  assert.equal(unapprovedAll.myMic.state, 'unavailable');
  assert.equal(unapprovedAll.myMic.disabled, true);
  assert.equal(unapprovedAll.deviceSound.state, 'unavailable');
  assert.equal(unapprovedAll.deviceSound.disabled, true);
  assert.equal(unapprovedAll.myScreen.state, 'unavailable');
  assert.equal(unapprovedAll.myScreen.disabled, true);
  assert.equal(unapprovedAll.sourcePicker.disabled, true);
});

test('Host overlay UI is icon-only, tooltip-free, arrow-cursor scoped, and transparent-ready', () => {
  const hostOverlaySrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/renderer/HostOverlayWindows.tsx'),
    'utf8'
  );
  const stylesSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/renderer/styles.css'),
    'utf8'
  );
  const mainSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/main/index.ts'),
    'utf8'
  );

  // Zero title="..." or title={...} attributes in HostOverlayWindows.tsx
  assert.equal(/\btitle=/.test(hostOverlaySrc), false, 'HostOverlayWindows must not render HTML title tooltips');
  assert.equal(/<title>/.test(hostOverlaySrc), false, 'HostOverlayWindows must not render SVG <title> tooltips');

  // Old visible action text labels removed from Host toolbar buttons
  for (const forbidden of ['>Device Sound<', '>Start Sharing<', '>Stop Sharing<', '>Source ▾<', '>End Session<']) {
    assert.equal(hostOverlaySrc.includes(forbidden), false, `Forbidden Host toolbar label remained: ${forbidden}`);
  }

  // Host-scoped arrow cursor and transparent overlay root CSS rules exist
  assert.ok(stylesSrc.includes('.host-ui-scope button'), 'Host-scoped cursor: default rule must exist');
  assert.ok(stylesSrc.includes("data-overlay-window='true'"), 'Transparent overlay window CSS rule must exist');

  // Main process allows display-capture permission for getDisplayMedia
  assert.ok(mainSrc.includes("permission === 'display-capture'"), 'Main process must grant display-capture permission');

  // Custom React Host toolbar tooltip rendered inside capture-protected toolbar window (no native title)
  assert.ok(hostOverlaySrc.includes('data-testid="host-toolbar-tooltip"'), 'Custom React tooltip element must exist');
  assert.ok(hostOverlaySrc.includes('HOST_TOOLTIP_DELAY_MS = 400'), 'Custom tooltip must use 350-500ms hover delay');
  assert.ok(stylesSrc.includes('.host-toolbar-tooltip'), 'Custom tooltip CSS styling must exist');

  // Host PeerMic button and Viewer MyMic + consent banner exist
  assert.ok(hostOverlaySrc.includes('data-testid="toolbar-peer-mic-btn"'), 'Host toolbar must render PeerMic button');
  assert.ok(hostOverlaySrc.includes("type: 'toggle-peer-mic'"), 'Host PeerMic button must dispatch toggle-peer-mic');
  const appSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/renderer/App.tsx'),
    'utf8'
  );
  assert.ok(appSrc.includes('data-testid="viewer-mic-request-banner"'), 'Viewer must render mic consent banner');
  assert.ok(appSrc.includes('handleToggleViewerMic'), 'Viewer MyMic button must toggle Viewer microphone');
});
