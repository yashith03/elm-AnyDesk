import { app, type BrowserWindow } from 'electron';
import koffi from 'koffi';
import {
  resolveEffectiveCaptureProtection,
  shouldAllowCaptureProtectionToggle,
  type CaptureProtectionState,
  type CaptureProtectionWindowStatus,
} from '../shared/capture-protection';

export interface ProtectedWindowRegistry {
  readonly main: BrowserWindow | null;
  readonly hostToolbar: BrowserWindow | null;
  readonly chat: BrowserWindow | null;
  readonly sourcePicker: BrowserWindow | null;
  readonly settings: BrowserWindow | null;
}

type GetWindowDisplayAffinityFn = (
  hwnd: bigint,
  pdwAffinity: Buffer
) => number;

let cachedGetWindowDisplayAffinity: GetWindowDisplayAffinityFn | null | undefined;

function getDisplayAffinityReader(): GetWindowDisplayAffinityFn | null {
  if (cachedGetWindowDisplayAffinity !== undefined) {
    return cachedGetWindowDisplayAffinity;
  }
  if (process.platform !== 'win32') {
    cachedGetWindowDisplayAffinity = null;
    return null;
  }
  try {
    const user32 = koffi.load('user32.dll');
    cachedGetWindowDisplayAffinity = user32.func(
      'int32 __stdcall GetWindowDisplayAffinity(uintptr_t hWnd, void* pdwAffinity)'
    );
  } catch {
    cachedGetWindowDisplayAffinity = null;
  }
  return cachedGetWindowDisplayAffinity;
}

function readWindowDisplayAffinity(win: BrowserWindow | null): number | null {
  if (!win || win.isDestroyed() || process.platform !== 'win32') {
    return null;
  }
  const reader = getDisplayAffinityReader();
  if (!reader) return null;
  try {
    const handleBuf = win.getNativeWindowHandle();
    const hwnd =
      handleBuf.length >= 8
        ? handleBuf.readBigUInt64LE(0)
        : BigInt(handleBuf.readUInt32LE(0));
    const outBuf = Buffer.alloc(4);
    const ok = reader(hwnd, outBuf);
    if (ok === 0) return null;
    return outBuf.readUInt32LE(0);
  } catch {
    return null;
  }
}

export class CaptureProtectionController {
  private requestedTestEnabled = true;

  public isToggleAllowed(): boolean {
    return shouldAllowCaptureProtectionToggle({
      isPackaged: app.isPackaged,
      argv: process.argv,
      env: process.env,
    });
  }

  public getEffectiveEnabled(): boolean {
    return resolveEffectiveCaptureProtection({
      toggleAllowed: this.isToggleAllowed(),
      requestedEnabled: this.requestedTestEnabled,
    });
  }

  public setTestEnabled(
    enabled: boolean,
    registry: ProtectedWindowRegistry
  ): CaptureProtectionState {
    if (this.isToggleAllowed()) {
      this.requestedTestEnabled = Boolean(enabled);
    } else {
      this.requestedTestEnabled = true;
    }
    return this.applyToAll(registry);
  }

  public resetToDefaultOn(
    registry: ProtectedWindowRegistry
  ): CaptureProtectionState {
    this.requestedTestEnabled = true;
    return this.applyToAll(registry);
  }

  public applyToWindow(win: BrowserWindow | null): boolean {
    if (!win || win.isDestroyed()) {
      return false;
    }
    const effective = this.getEffectiveEnabled();
    try {
      win.setContentProtection(effective);
    } catch {
      // Best-effort on unsupported environments
    }
    return effective;
  }

  public applyToAll(registry: ProtectedWindowRegistry): CaptureProtectionState {
    const effective = this.getEffectiveEnabled();
    const keys: Array<keyof CaptureProtectionWindowStatus> = [
      'main',
      'hostToolbar',
      'chat',
      'sourcePicker',
      'settings',
    ];
    for (const key of keys) {
      const win = registry[key];
      if (win && !win.isDestroyed()) {
        try {
          win.setContentProtection(effective);
        } catch {
          // Ignore unsupported platform failure
        }
      }
    }
    return this.getState(registry);
  }

  public getState(registry: ProtectedWindowRegistry): CaptureProtectionState {
    const effective = this.getEffectiveEnabled();
    const isWinProtected = (win: BrowserWindow | null): boolean =>
      Boolean(win && !win.isDestroyed() && effective);

    const affinities: Partial<
      Record<keyof CaptureProtectionWindowStatus, number | null>
    > = {};
    if (process.platform === 'win32') {
      if (registry.main && !registry.main.isDestroyed()) {
        affinities.main = readWindowDisplayAffinity(registry.main);
      }
      if (registry.hostToolbar && !registry.hostToolbar.isDestroyed()) {
        affinities.hostToolbar = readWindowDisplayAffinity(registry.hostToolbar);
      }
      if (registry.chat && !registry.chat.isDestroyed()) {
        affinities.chat = readWindowDisplayAffinity(registry.chat);
      }
      if (registry.sourcePicker && !registry.sourcePicker.isDestroyed()) {
        affinities.sourcePicker = readWindowDisplayAffinity(
          registry.sourcePicker
        );
      }
      if (registry.settings && !registry.settings.isDestroyed()) {
        affinities.settings = readWindowDisplayAffinity(registry.settings);
      }
    }

    return {
      enabled: effective,
      toggleAllowed: this.isToggleAllowed(),
      windows: {
        main: isWinProtected(registry.main),
        hostToolbar: isWinProtected(registry.hostToolbar),
        chat: isWinProtected(registry.chat),
        sourcePicker: isWinProtected(registry.sourcePicker),
        settings: isWinProtected(registry.settings),
      },
      windowDisplayAffinities: affinities,
    };
  }
}
