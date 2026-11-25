import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WIN32_AFFINITY_EXCLUDE_FROM_CAPTURE,
  WIN32_AFFINITY_NONE,
  isAlwaysProtectedWindowKey,
  resolveEffectiveCaptureProtection,
  resolveHostVisibilityVerification,
  shouldAllowCaptureProtectionToggle,
} from '../src/shared/capture-protection.ts';

test('Host Visibility toggle is permitted in all builds while sensitive popups stay always protected', () => {
  assert.equal(
    shouldAllowCaptureProtectionToggle({
      isPackaged: true,
      argv: ['Elm-AnyDesk.exe'],
      env: {},
    }),
    true
  );
  assert.equal(
    shouldAllowCaptureProtectionToggle({
      isPackaged: false,
      argv: ['electron.exe', '.'],
      env: {},
    }),
    true
  );
  assert.equal(isAlwaysProtectedWindowKey('chat'), true);
  assert.equal(isAlwaysProtectedWindowKey('sourcePicker'), true);
  assert.equal(isAlwaysProtectedWindowKey('settings'), true);
  assert.equal(isAlwaysProtectedWindowKey('main'), false);
  assert.equal(isAlwaysProtectedWindowKey('hostToolbar'), false);
});

test('resolveEffectiveCaptureProtection respects requested state when allowed and locks ON if disallowed', () => {
  assert.equal(
    resolveEffectiveCaptureProtection({
      toggleAllowed: false,
      requestedEnabled: false,
    }),
    true
  );
  assert.equal(
    resolveEffectiveCaptureProtection({
      toggleAllowed: true,
      requestedEnabled: false,
    }),
    false
  );
  assert.equal(
    resolveEffectiveCaptureProtection({
      toggleAllowed: true,
      requestedEnabled: true,
    }),
    true
  );
});

test('resolveHostVisibilityVerification validates actual Win32 display affinity and reports unverified on mismatch or error', () => {
  const verifiedOn = resolveHostVisibilityVerification({
    platform: 'win32',
    requestedEnabled: true,
    applyFailed: false,
    openControlledKeys: ['main', 'hostToolbar'],
    affinities: {
      main: WIN32_AFFINITY_EXCLUDE_FROM_CAPTURE,
      hostToolbar: WIN32_AFFINITY_EXCLUDE_FROM_CAPTURE,
    },
  });
  assert.equal(verifiedOn.verificationStatus, 'verified_on');
  assert.equal(verifiedOn.error, null);

  const verifiedOff = resolveHostVisibilityVerification({
    platform: 'win32',
    requestedEnabled: false,
    applyFailed: false,
    openControlledKeys: ['main', 'hostToolbar'],
    affinities: {
      main: WIN32_AFFINITY_NONE,
      hostToolbar: WIN32_AFFINITY_NONE,
    },
  });
  assert.equal(verifiedOff.verificationStatus, 'verified_off');
  assert.equal(verifiedOff.error, null);

  const mismatch = resolveHostVisibilityVerification({
    platform: 'win32',
    requestedEnabled: true,
    applyFailed: false,
    openControlledKeys: ['main', 'hostToolbar'],
    affinities: {
      main: WIN32_AFFINITY_EXCLUDE_FROM_CAPTURE,
      hostToolbar: WIN32_AFFINITY_NONE,
    },
  });
  assert.equal(mismatch.verificationStatus, 'unverified');
  assert.ok(mismatch.error?.includes('hostToolbar'));

  const unreadable = resolveHostVisibilityVerification({
    platform: 'win32',
    requestedEnabled: true,
    applyFailed: false,
    openControlledKeys: ['hostToolbar'],
    affinities: { hostToolbar: null },
  });
  assert.equal(unreadable.verificationStatus, 'unverified');
  assert.ok(unreadable.error);

  const applyErr = resolveHostVisibilityVerification({
    platform: 'win32',
    requestedEnabled: true,
    applyFailed: true,
    openControlledKeys: ['hostToolbar'],
    affinities: { hostToolbar: WIN32_AFFINITY_EXCLUDE_FROM_CAPTURE },
  });
  assert.equal(applyErr.verificationStatus, 'unverified');
});

test('HostOverlayWindows renders read-only Hidden: ON/OFF badge and Host Settings Visibility toggle (no Test ON/OFF button)', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'renderer', 'HostOverlayWindows.tsx'),
    'utf8'
  );
  assert.match(source, /data-testid="host-hidden-status-indicator"/);
  assert.match(source, /Hidden: ON/);
  assert.match(source, /Hidden: OFF/);
  assert.match(source, /data-testid="host-visibility-toggle"/);
  assert.match(source, /Hide Elm-AnyDesk UI/);
  assert.equal(
    source.includes('data-testid="capture-protection-test-toggle"'),
    false,
    'Old clickable Test ON/OFF button must be replaced by read-only indicator'
  );
});
