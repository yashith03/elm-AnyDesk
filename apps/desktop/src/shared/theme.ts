export type ThemeMode = 'light' | 'dark';

export type ThemeSource = 'system_default' | 'user_persisted';

export interface ThemeStateSnapshot {
  readonly mode: ThemeMode;
  readonly source: ThemeSource;
  readonly systemPrefersDark: boolean;
  readonly updatedAt: string;
}

export interface ThemeTokenPalette {
  readonly mode: ThemeMode;
  readonly bgCanvas: string;
  readonly surfacePrimary: string;
  readonly surfaceSecondary: string;
  readonly surfaceElevated: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textMuted: string;
  readonly accentPrimary: string;
  readonly accentHover: string;
  readonly accentActionBg: string;
  readonly accentActionText: string;
  readonly accentSubtleBg: string;
  readonly borderSubtle: string;
  readonly borderStrong: string;
  readonly controlHoverBg: string;
  readonly focusRing: string;
  readonly disabledBg: string;
  readonly disabledText: string;
  readonly dangerPrimary: string;
  readonly dangerHover: string;
  readonly dangerText: string;
}

/**
 * Centralized theme tokens for Light and Dark modes using white, near-black, and blue.
 * Zero gradients, zero glow effects, and WCAG AA/AAA text contrast in both modes.
 */
export const THEME_TOKENS: Readonly<Record<ThemeMode, ThemeTokenPalette>> =
  Object.freeze({
    light: Object.freeze({
      mode: 'light',
      bgCanvas: '#F8FAFC',
      surfacePrimary: '#FFFFFF',
      surfaceSecondary: '#F3F4F6',
      surfaceElevated: '#FFFFFF',
      textPrimary: '#111827',
      textSecondary: '#1F2937',
      textMuted: '#4B5563',
      accentPrimary: '#2563EB',
      accentHover: '#1D4ED8',
      accentActionBg: '#2563EB',
      accentActionText: '#FFFFFF',
      accentSubtleBg: '#EFF6FF',
      borderSubtle: '#D1D5DB',
      borderStrong: '#9CA3AF',
      controlHoverBg: '#E5E7EB',
      focusRing: '#2563EB',
      disabledBg: '#E5E7EB',
      disabledText: '#6B7280',
      dangerPrimary: '#DC2626',
      dangerHover: '#B91C1C',
      dangerText: '#FFFFFF',
    }),
    dark: Object.freeze({
      mode: 'dark',
      bgCanvas: '#0A0A0A',
      surfacePrimary: '#111111',
      surfaceSecondary: '#18181B',
      surfaceElevated: '#1F2937',
      textPrimary: '#F5F7FA',
      textSecondary: '#E5E7EB',
      textMuted: '#9CA3AF',
      accentPrimary: '#60A5FA',
      accentHover: '#93C5FD',
      accentActionBg: '#2563EB',
      accentActionText: '#FFFFFF',
      accentSubtleBg: '#172554',
      borderSubtle: '#27272A',
      borderStrong: '#3F3F46',
      controlHoverBg: '#27272A',
      focusRing: '#60A5FA',
      disabledBg: '#1F1F23',
      disabledText: '#71717A',
      dangerPrimary: '#DC2626',
      dangerHover: '#B91C1C',
      dangerText: '#FFFFFF',
    }),
  });

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Computes WCAG 2.1 contrast ratio between two hex colors (1.0 to 21.0).
 */
export function computeWcagContrastRatio(
  foregroundHex: string,
  backgroundHex: string
): number {
  const l1 = relativeLuminance(foregroundHex);
  const l2 = relativeLuminance(backgroundHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}
