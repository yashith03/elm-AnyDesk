import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { INVITE_TIMEOUT_MS } from '@elm/protocol';
import {
  formatCountdownMmSs,
  resolveWaitingPeerName,
} from '../src/shared/request-ui.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.resolve(__dirname, '../src/renderer');

test('formatCountdownMmSs formats 120s and partial durations cleanly', () => {
  assert.equal(INVITE_TIMEOUT_MS, 120_000);
  assert.equal(formatCountdownMmSs(120_000), '02:00');
  assert.equal(formatCountdownMmSs(105_000), '01:45');
  assert.equal(formatCountdownMmSs(9_100), '00:10');
  assert.equal(formatCountdownMmSs(0), '00:00');
  assert.equal(formatCountdownMmSs(-5_000), '00:00');
});

test('resolveWaitingPeerName prefers recent alias, then non-generic displayName, then Friend Code', () => {
  const recents = [
    {
      friendCode: 'ELM-Z6Q3-G5JF',
      alias: 'Nimal',
      favorite: true,
      lastConnectedAt: '2026-11-20T10:00:00.000Z',
    },
  ];
  assert.equal(
    resolveWaitingPeerName('elm-z6q3-g5jf', 'Elm Device', recents),
    'Nimal'
  );
  assert.equal(
    resolveWaitingPeerName('ELM-AAAA-BBBB', 'Alex Laptop', recents),
    'Alex Laptop'
  );
  assert.equal(
    resolveWaitingPeerName('elm-aaaa-bbbb', 'Elm Device', recents),
    'ELM-AAAA-BBBB'
  );
});

test('simplified Home UI omits session tabs, cancel alert banner, and New Session hero placeholder', () => {
  const appSource = fs.readFileSync(path.join(rendererDir, 'App.tsx'), 'utf8');
  assert.equal(appSource.includes('session-tabs'), false);
  assert.equal(appSource.includes('chrome-tab-strip'), false);
  assert.equal(appSource.includes('tab-add-button'), false);
  assert.equal(appSource.includes('new-session-hero-card'), false);
  assert.equal(appSource.includes('Connection request cancelled.'), false);
  assert.equal(appSource.includes('Connection request sent to '), false);
  assert.equal(appSource.includes('settings-modal-backdrop'), true);
  assert.equal(appSource.includes('aria-modal="true"'), true);
  assert.equal(appSource.includes('bottom-center-toast'), true);
  assert.equal(appSource.includes('setStatusMessage(\n                                    `Copied'), false);
  assert.equal(appSource.includes('setStatusMessage(`Copied'), false);
  assert.equal(appSource.includes("document.addEventListener('pointerdown', handlePointerDown)"), true);
  assert.equal(appSource.includes("document.addEventListener('keydown', handleKeyDown)"), true);
  assert.equal(appSource.includes('aria-haspopup="menu"'), true);
  assert.equal(appSource.includes('aria-expanded={menuOpen}'), true);
  assert.equal(appSource.includes('settings-share-email-checkbox'), false);
  assert.equal(appSource.includes('settings-share-phone-checkbox'), false);
  assert.equal(appSource.includes('peer-card-email-'), true);
  assert.equal(appSource.includes('peer-card-phone-'), true);
  assert.equal(appSource.includes("showToast('You cannot connect to your code.', 'error')"), true);
});
