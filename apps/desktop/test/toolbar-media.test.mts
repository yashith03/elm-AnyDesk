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
      approved: true,
      active: false,
      status: 'stopped',
      message: '',
      ...(overrides?.screenVideo ?? {}),
    },
    microphoneAudio: {
      approved: true,
      active: false,
      status: 'stopped',
      message: '',
      ...(overrides?.microphoneAudio ?? {}),
    },
    deviceAudio: {
      approved: true,
      active: false,
      status: 'stopped',
      message: '',
      ...(overrides?.deviceAudio ?? {}),
    },
  };
}

test('computeHostToolbarMediaControls maps mic, device sound, and screen states independently', () => {
  const stoppedAll = computeHostToolbarMediaControls({
    hostMediaState: makeHostMediaState(),
    hostMicMutedLocally: false,
    isStartingShare: false,
  });
  assert.equal(stoppedAll.myMic.state, 'stopped');
  assert.equal(stoppedAll.myMic.disabled, false);
  assert.equal(stoppedAll.deviceSound.state, 'stopped');
  assert.equal(stoppedAll.deviceSound.disabled, false);
  assert.equal(stoppedAll.myScreen.state, 'stopped');
  assert.equal(stoppedAll.sourcePicker.disabled, false);

  const activeAll = computeHostToolbarMediaControls({
    hostMediaState: makeHostMediaState({
      microphoneAudio: { approved: true, active: true, status: 'live', message: '' },
      deviceAudio: { approved: true, active: true, status: 'live', message: '' },
      screenVideo: { approved: true, active: true, status: 'live', message: '' },
    }),
    hostMicMutedLocally: true,
    isStartingShare: false,
  });
  assert.equal(activeAll.myMic.state, 'muted');
  assert.equal(activeAll.deviceSound.state, 'active');
  assert.equal(activeAll.myScreen.state, 'sharing');

  const unapprovedAll = computeHostToolbarMediaControls({
    hostMediaState: makeHostMediaState({
      microphoneAudio: { approved: false, active: false, status: 'idle', message: '' },
      deviceAudio: { approved: false, active: false, status: 'idle', message: '' },
      screenVideo: { approved: false, active: false, status: 'idle', message: '' },
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
