import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildBackgroundRgba,
  clampFloatingPanelLayout,
  DEFAULT_FLOATING_PANEL_APPEARANCE,
  sanitizeFloatingPanelAppearance,
} from '../src/shared/floating-panel.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Floating panel appearance clamps bar and chat opacity & text sizes independently', () => {
  const sanitized = sanitizeFloatingPanelAppearance({
    barBgOpacity: 0.1,
    chatBgOpacity: 0.85,
    barTextSizePx: 24,
    chatTextSizePx: 9,
  });
  assert.equal(sanitized.barBgOpacity, 0.35);
  assert.equal(sanitized.chatBgOpacity, 0.85);
  assert.equal(sanitized.barTextSizePx, 16);
  assert.equal(sanitized.chatTextSizePx, 12);

  assert.equal(
    buildBackgroundRgba('light', DEFAULT_FLOATING_PANEL_APPEARANCE.barBgOpacity),
    'rgba(255, 255, 255, 0.92)'
  );
  assert.equal(
    buildBackgroundRgba('dark', 0.5),
    'rgba(17, 17, 17, 0.50)'
  );
});

test('clampFloatingPanelLayout keeps controls reachable on small viewports with Chat only, Settings only, and both open', () => {
  // Compact + Settings only on a narrow 700x500 window
  const settingsOnly = clampFloatingPanelLayout(
    { x: 600, y: 450, width: 560, chatHeight: 260 },
    700,
    500,
    { chatOpen: false, settingsOpen: true }
  );
  assert.ok(settingsOnly.width <= 700 - 276 - 16);
  assert.ok(settingsOnly.x + settingsOnly.width + 276 <= 700 - 8);
  assert.ok(settingsOnly.y <= 500 - 16);

  // Chat + Settings both open on 900x600 window
  const bothOpen = clampFloatingPanelLayout(
    { x: 100, y: 80, width: 480, chatHeight: 300 },
    900,
    600,
    { chatOpen: true, settingsOpen: true }
  );
  assert.equal(bothOpen.width, 480);
  assert.equal(bothOpen.chatHeight, 300);
  assert.ok(bothOpen.x + bothOpen.width + 276 <= 900 - 8);
});

test('styles.css gives active viewer full available area without 68vh/190px cap and defines presentation viewport', () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/styles.css'),
    'utf8'
  );
  assert.ok(css.includes('.active-viewer-viewport'));
  assert.ok(css.includes('.floating-panel-assembly'));
  assert.ok(css.includes('.floating-settings-sidebar'));
  assert.ok(css.includes('.presentation-viewport'));
  assert.ok(!css.includes('max-height: 68vh'));
  assert.ok(!css.includes('max-height: 66vh'));
});
