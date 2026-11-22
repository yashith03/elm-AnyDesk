import test from 'node:test';
import assert from 'node:assert/strict';
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
