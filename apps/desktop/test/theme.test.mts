import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  THEME_TOKENS,
  computeWcagContrastRatio,
} from '../src/shared/theme.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');

test('Light and Dark theme tokens match specification and meet WCAG AA contrast ratios', () => {
  // Light palette: #FFFFFF surface, #111827 text, #2563EB action blue
  assert.equal(THEME_TOKENS.light.surfacePrimary, '#FFFFFF');
  assert.equal(THEME_TOKENS.light.textPrimary, '#111827');
  assert.equal(THEME_TOKENS.light.accentPrimary, '#2563EB');
  assert.equal(THEME_TOKENS.light.accentActionBg, '#2563EB');

  // Dark palette: #111111 surface, #F5F7FA text, #60A5FA accent
  assert.equal(THEME_TOKENS.dark.surfacePrimary, '#111111');
  assert.equal(THEME_TOKENS.dark.textPrimary, '#F5F7FA');
  assert.equal(THEME_TOKENS.dark.accentPrimary, '#60A5FA');
  assert.equal(THEME_TOKENS.dark.accentActionBg, '#2563EB');

  // Contrast ratios (WCAG AA requires >= 4.5:1 for normal text)
  const lightPrimaryContrast = computeWcagContrastRatio(
    THEME_TOKENS.light.textPrimary,
    THEME_TOKENS.light.surfacePrimary
  );
  const lightMutedContrast = computeWcagContrastRatio(
    THEME_TOKENS.light.textMuted,
    THEME_TOKENS.light.surfacePrimary
  );
  const lightButtonContrast = computeWcagContrastRatio(
    THEME_TOKENS.light.accentActionText,
    THEME_TOKENS.light.accentActionBg
  );

  const darkPrimaryContrast = computeWcagContrastRatio(
    THEME_TOKENS.dark.textPrimary,
    THEME_TOKENS.dark.surfacePrimary
  );
  const darkMutedContrast = computeWcagContrastRatio(
    THEME_TOKENS.dark.textMuted,
    THEME_TOKENS.dark.surfacePrimary
  );
  const darkAccentContrast = computeWcagContrastRatio(
    THEME_TOKENS.dark.accentPrimary,
    THEME_TOKENS.dark.surfacePrimary
  );

  assert.ok(lightPrimaryContrast >= 15, `Expected light primary contrast >= 15, got ${lightPrimaryContrast}`);
  assert.ok(lightMutedContrast >= 4.5, `Expected light muted contrast >= 4.5, got ${lightMutedContrast}`);
  assert.ok(lightButtonContrast >= 4.5, `Expected light button contrast >= 4.5, got ${lightButtonContrast}`);
  assert.ok(darkPrimaryContrast >= 15, `Expected dark primary contrast >= 15, got ${darkPrimaryContrast}`);
  assert.ok(darkMutedContrast >= 4.5, `Expected dark muted contrast >= 4.5, got ${darkMutedContrast}`);
  assert.ok(darkAccentContrast >= 4.5, `Expected dark accent contrast >= 4.5, got ${darkAccentContrast}`);
});

test('Chakra Petch fonts are bundled locally with OFL license and CSS uses zero CDN fonts or gradients', () => {
  const fontsDir = path.join(desktopRoot, 'src/renderer/fonts');
  const mediumFont = path.join(fontsDir, 'ChakraPetch-Medium.woff2');
  const semiBoldFont = path.join(fontsDir, 'ChakraPetch-SemiBold.woff2');
  const licenseFile = path.join(fontsDir, 'OFL-LICENSE.txt');

  assert.ok(fs.existsSync(mediumFont), 'ChakraPetch-Medium.woff2 must exist locally');
  assert.ok(fs.existsSync(semiBoldFont), 'ChakraPetch-SemiBold.woff2 must exist locally');
  assert.ok(fs.existsSync(licenseFile), 'OFL-LICENSE.txt must exist locally');
  assert.ok(fs.statSync(mediumFont).size > 5000);
  assert.ok(fs.statSync(semiBoldFont).size > 5000);

  const cssContent = fs.readFileSync(
    path.join(desktopRoot, 'src/renderer/styles.css'),
    'utf8'
  );
  assert.ok(cssContent.includes("font-family: 'Chakra Petch'"));
  assert.ok(cssContent.includes(":root[data-theme='light']"));
  assert.ok(cssContent.includes(":root[data-theme='dark']"));
  assert.ok(cssContent.includes('-webkit-app-region: drag'));
  assert.ok(cssContent.includes('-webkit-app-region: no-drag'));
  assert.ok(cssContent.includes(':focus-visible'));
  assert.ok(!/linear-gradient|radial-gradient/i.test(cssContent), 'Styles must avoid gradients');
  assert.ok(!/https?:\/\//i.test(cssContent), 'Styles must not load remote CDN assets at runtime');
});

test('Multi-resolution Windows .ico asset contains 16x16, 24x24, 32x32, 48x48, 64x64, and 256x256 frames', () => {
  const icoPath = path.join(desktopRoot, 'assets/elm-icon.ico');
  assert.ok(fs.existsSync(icoPath), 'assets/elm-icon.ico must exist');
  const buf = fs.readFileSync(icoPath);
  assert.equal(buf.readUInt16LE(0), 0, 'ICO reserved field must be 0');
  assert.equal(buf.readUInt16LE(2), 1, 'ICO type field must be 1');
  const count = buf.readUInt16LE(4);
  assert.equal(count, 6, 'ICO must contain 6 resolution frames');

  const widths: number[] = [];
  for (let i = 0; i < count; i++) {
    const rawW = buf[6 + i * 16];
    widths.push(rawW === 0 ? 256 : rawW);
  }
  assert.deepEqual(widths, [16, 24, 32, 48, 64, 256]);
});

