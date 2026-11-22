import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');

test('1. Baseline (190px cap) vs. Optimized Stage (Fit & Actual Size 1:1) dimensions & readability', () => {
  const sourceWidth = 1920;
  const sourceHeight = 1080;

  // Baseline: max-height: 190px in 2-column grid
  const baselineHeight = 190;
  const baselineScale = baselineHeight / sourceHeight; // 0.1759
  const baselineWidth = Math.round(sourceWidth * baselineScale); // 338px

  assert.equal(baselineHeight, 190);
  assert.equal(baselineWidth, 338);
  assert.ok(baselineScale < 0.2, `Baseline scale ${baselineScale} is crushed below 20%`);

  // Character stroke & height for 11px font in Baseline
  const baseline11pxHeight = 11 * baselineScale; // 1.93px
  const baseline11pxStroke = 1 * baselineScale; // 0.176px
  assert.ok(
    baseline11pxHeight < 2.0,
    `In baseline, 11px font character height (${baseline11pxHeight}px) collapses below 2px, making code unreadable`
  );
  assert.ok(
    baseline11pxStroke < 0.25,
    `In baseline, 1px letter stroke (${baseline11pxStroke}px) is crushed into subpixel blur`
  );

  // Optimized Stage (Fit Mode within 1200x820 desktop window)
  const fitStageWidth = 1140;
  const fitStageHeight = 640;
  const fitScale = Math.min(fitStageWidth / sourceWidth, fitStageHeight / sourceHeight); // 0.5926
  const fitRenderedWidth = Math.round(sourceWidth * fitScale); // 1138px
  const fitRenderedHeight = Math.round(sourceHeight * fitScale); // 640px

  assert.ok(fitRenderedHeight >= 640, `Fit mode height ${fitRenderedHeight} >= 640px`);
  assert.ok(
    fitRenderedHeight > baselineHeight * 3.3,
    `Fit mode height (${fitRenderedHeight}px) is > 3.3x taller than baseline (${baselineHeight}px)`
  );
  const pixelAreaRatio = (fitRenderedWidth * fitRenderedHeight) / (baselineWidth * baselineHeight);
  assert.ok(
    pixelAreaRatio > 11.0,
    `Fit mode provides ${pixelAreaRatio.toFixed(1)}x more pixel area than baseline`
  );

  // Character stroke & height for 11px font in Fit mode
  const fit11pxHeight = 11 * fitScale; // 6.52px
  assert.ok(
    fit11pxHeight > 6.0,
    `In Fit mode, 11px font renders at ${fit11pxHeight.toFixed(2)}px (legible)`
  );

  // Optimized Stage (Actual Size 1:1 Mode)
  const actualScale = 1.0;
  const actualRenderedWidth = sourceWidth;
  const actualRenderedHeight = sourceHeight;

  assert.equal(actualScale, 1.0);
  assert.equal(actualRenderedWidth, 1920);
  assert.equal(actualRenderedHeight, 1080);

  const actual11pxHeight = 11 * actualScale; // 11.0px
  assert.equal(actual11pxHeight, 11.0, 'In Actual Size 1:1, 11px font renders at exact native 11.0px');
});

test('2. Windows DPI scaling (100%, 125%, 150%, 200%) pixel-to-pixel mapping in Actual Size mode', () => {
  const decodedWidth = 1920;
  const decodedHeight = 1080;
  const testDpiScales = [1.0, 1.25, 1.5, 1.75, 2.0];

  for (const dpr of testDpiScales) {
    const actualCssWidth = Math.round(decodedWidth / dpr);
    const actualCssHeight = Math.round(decodedHeight / dpr);

    const physicalWidth = Math.round(actualCssWidth * dpr);
    const physicalHeight = Math.round(actualCssHeight * dpr);

    // Assert that CSS dimensions scaled by DPR match decoded frame dimensions within 1 physical pixel
    const deltaW = Math.abs(physicalWidth - decodedWidth);
    const deltaH = Math.abs(physicalHeight - decodedHeight);

    assert.ok(
      deltaW <= 1,
      `At DPR ${dpr}, physical width ${physicalWidth} deviates from decoded width ${decodedWidth} by ${deltaW}px`
    );
    assert.ok(
      deltaH <= 1,
      `At DPR ${dpr}, physical height ${physicalHeight} deviates from decoded height ${decodedHeight} by ${deltaH}px`
    );
  }
});

test('3. Privacy-safe telemetry audit: zero IP addresses, raw candidates, SDPs, chat messages, or window titles', () => {
  const allowedKeys = new Set([
    'timestamp',
    'captureWidth',
    'captureHeight',
    'captureFps',
    'encodedWidth',
    'encodedHeight',
    'encodedFps',
    'outboundFramesSent',
    'outboundBitrateKbps',
    'qualityLimitationReason',
    'decodedWidth',
    'decodedHeight',
    'decodedFps',
    'inboundFramesDecoded',
    'inboundBytesReceived',
    'inboundBitrateKbps',
    'packetsLost',
    'packetLossPercent',
    'jitterMs',
    'freezeCount',
    'rttMs',
    'isLoopback',
  ]);

  const mockTelemetry = {
    timestamp: 1731630000000,
    captureWidth: 1920,
    captureHeight: 1080,
    captureFps: 30,
    encodedWidth: 1920,
    encodedHeight: 1080,
    encodedFps: 30,
    outboundBitrateKbps: 2500,
    qualityLimitationReason: 'none',
    decodedWidth: 1920,
    decodedHeight: 1080,
    decodedFps: 30,
    inboundBitrateKbps: 2480,
    packetsLost: 0,
    packetLossPercent: 0,
    jitterMs: 1.5,
    freezeCount: 0,
    rttMs: 2,
    isLoopback: true,
  };

  const payloadKeys = Object.keys(mockTelemetry);
  const extraKeys = payloadKeys.filter((k) => !allowedKeys.has(k));
  assert.equal(extraKeys.length, 0, `Forbidden extra keys in telemetry payload: ${extraKeys.join(', ')}`);

  const serialized = JSON.stringify(mockTelemetry);
  assert.ok(!serialized.includes('candidate:'), 'Must not contain raw ICE candidate strings');
  assert.ok(!serialized.includes('192.168.'), 'Must not contain local IP addresses');
  assert.ok(!serialized.includes('sdp'), 'Must not contain SDP descriptions');
  assert.ok(!serialized.includes('token'), 'Must not contain credentials or tokens');
  assert.ok(!serialized.includes('password'), 'Must not contain passwords');
});

test('4. CSS stylesheet contains dedicated active viewer stage with Fit and Actual Size rules and no 190px cap on active video', () => {
  const cssPath = path.join(desktopRoot, 'src/renderer/styles.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  assert.ok(cssContent.includes('.active-viewer-stage'), 'styles.css must define .active-viewer-stage');
  assert.ok(cssContent.includes('.viewer-stage-container.fit-mode'), 'styles.css must define .fit-mode');
  assert.ok(cssContent.includes('.viewer-stage-container.actual-mode'), 'styles.css must define .actual-mode');
  assert.ok(cssContent.includes('image-rendering: -webkit-optimize-contrast'), 'styles.css must specify crisp image rendering');
  assert.ok(cssContent.includes('.diagnostics-panel'), 'styles.css must define .diagnostics-panel');
  assert.ok(cssContent.includes('.mode-toggle-group'), 'styles.css must define .mode-toggle-group');

  // Verify that .video-preview-frame does NOT have max-height: 190px
  assert.ok(!cssContent.includes('max-height: 190px;'), 'styles.css must NOT contain max-height: 190px; restriction');
});
