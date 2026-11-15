export interface FloatingPanelAppearance {
  readonly barBgOpacity: number;
  readonly chatBgOpacity: number;
  readonly barTextSizePx: number;
  readonly chatTextSizePx: number;
}

export interface FloatingPanelLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly chatHeight: number;
}

export const DEFAULT_FLOATING_PANEL_APPEARANCE: FloatingPanelAppearance =
  Object.freeze({
    barBgOpacity: 0.92,
    chatBgOpacity: 0.92,
    barTextSizePx: 13,
    chatTextSizePx: 14,
  });

export const DEFAULT_FLOATING_PANEL_LAYOUT: FloatingPanelLayout = Object.freeze({
  x: 16,
  y: 16,
  width: 560,
  chatHeight: 260,
});

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function sanitizeFloatingPanelAppearance(
  raw?: Partial<FloatingPanelAppearance> | null
): FloatingPanelAppearance {
  return {
    barBgOpacity: clampNumber(
      raw?.barBgOpacity ?? DEFAULT_FLOATING_PANEL_APPEARANCE.barBgOpacity,
      0.35,
      1.0
    ),
    chatBgOpacity: clampNumber(
      raw?.chatBgOpacity ?? DEFAULT_FLOATING_PANEL_APPEARANCE.chatBgOpacity,
      0.35,
      1.0
    ),
    barTextSizePx: Math.round(
      clampNumber(
        raw?.barTextSizePx ?? DEFAULT_FLOATING_PANEL_APPEARANCE.barTextSizePx,
        11,
        16
      )
    ),
    chatTextSizePx: Math.round(
      clampNumber(
        raw?.chatTextSizePx ?? DEFAULT_FLOATING_PANEL_APPEARANCE.chatTextSizePx,
        12,
        18
      )
    ),
  };
}

export function buildBackgroundRgba(
  mode: 'light' | 'dark',
  opacity: number
): string {
  const alpha = clampNumber(opacity, 0.35, 1.0);
  return mode === 'dark'
    ? `rgba(17, 17, 17, ${alpha.toFixed(2)})`
    : `rgba(255, 255, 255, ${alpha.toFixed(2)})`;
}

export function clampFloatingPanelLayout(
  layout: FloatingPanelLayout,
  viewportWidth: number,
  viewportHeight: number,
  options: { chatOpen: boolean; settingsOpen: boolean }
): FloatingPanelLayout {
  const safeVw = Math.max(360, viewportWidth);
  const safeVh = Math.max(240, viewportHeight);
  const sidebarWidth = options.settingsOpen ? 276 : 0;
  const maxAllowedWidth = Math.max(320, safeVw - sidebarWidth - 16);
  const width = Math.round(clampNumber(layout.width, 320, maxAllowedWidth));

  const maxChatHeight = Math.max(160, safeVh - 140);
  const chatHeight = Math.round(
    clampNumber(layout.chatHeight, 160, maxChatHeight)
  );

  const totalWidth = width + sidebarWidth;
  const maxX = Math.max(8, safeVw - totalWidth - 8);
  const approxHeight = 52 + (options.chatOpen ? chatHeight : 0);
  const maxY = Math.max(8, safeVh - Math.min(approxHeight, safeVh - 16) - 8);

  return {
    x: Math.round(clampNumber(layout.x, 8, maxX)),
    y: Math.round(clampNumber(layout.y, 8, maxY)),
    width,
    chatHeight,
  };
}
