import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveEffectiveCaptureProtection,
  shouldAllowCaptureProtectionToggle,
} from '../src/shared/capture-protection.ts';

test('shouldAllowCaptureProtectionToggle disables toggle in packaged production builds without dev flags', () => {
  assert.equal(
    shouldAllowCaptureProtectionToggle({
      isPackaged: true,
      argv: ['Elm-AnyDesk.exe'],
      env: {},
    }),
    false
  );
  assert.equal(
    shouldAllowCaptureProtectionToggle({
      isPackaged: false,
      argv: ['electron.exe', '.'],
      env: {},
    }),
    true
  );
  assert.equal(
    shouldAllowCaptureProtectionToggle({
      isPackaged: true,
      argv: ['Elm-AnyDesk.exe', '--dev-mode'],
      env: {},
    }),
    true
  );
  assert.equal(
    shouldAllowCaptureProtectionToggle({
      isPackaged: true,
      argv: ['Elm-AnyDesk.exe'],
      env: { ELM_CAPTURE_TEST_MODE: '1' },
    }),
    true
  );
});

test('resolveEffectiveCaptureProtection enforces protection ON when toggle is disallowed', () => {
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

test('HostOverlayWindows omits the Test capture-protection button when toggleAllowed is false', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'src', 'renderer', 'HostOverlayWindows.tsx'),
    'utf8'
  );
  assert.match(source, /protection\.toggleAllowed/);
  assert.match(source, /data-testid="capture-protection-test-toggle"/);
  assert.match(source, /protection\.enabled \? 'Test ON' : 'Test OFF'/);
});
