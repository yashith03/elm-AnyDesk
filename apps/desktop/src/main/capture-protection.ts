import { app, type BrowserWindow } from 'electron';
import koffi from 'koffi';
import {
  WIN32_AFFINITY_EXCLUDE_FROM_CAPTURE,
  isAlwaysProtectedWindowKey,
  resolveEffectiveCaptureProtection,
  resolveHostVisibilityVerification,
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
  private lastApplyFailed = false;

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
    this.lastApplyFailed = false;
    return this.applyToAll(registry);
  }

  public applyToWindow(
    win: BrowserWindow | null,
    key: keyof CaptureProtectionWindowStatus = 'main'
  ): boolean {
    if (!win || win.isDestroyed()) {
      return false;
    }
    const targetEnabled = isAlwaysProtectedWindowKey(key)
      ? true
      : this.getEffectiveEnabled();
    try {
      win.setContentProtection(targetEnabled);
      if (!targetEnabled && !win.webContents.isDestroyed()) {
        // Trigger DWM recomposite when transitioning transparent overlay back to visible
        win.webContents.invalidate();
      }
      return targetEnabled;
    } catch {
      if (!isAlwaysProtectedWindowKey(key)) {
        this.lastApplyFailed = true;
      }
      return false;
    }
  }

  public applyToAll(registry: ProtectedWindowRegistry): CaptureProtectionState {
    const effective = this.getEffectiveEnabled();
    this.lastApplyFailed = false;
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
        const targetEnabled = isAlwaysProtectedWindowKey(key) ? true : effective;
        try {
          win.setContentProtection(targetEnabled);
          if (!targetEnabled && !win.webContents.isDestroyed()) {
            win.webContents.invalidate();
          }
        } catch {
          if (!isAlwaysProtectedWindowKey(key)) {
            this.lastApplyFailed = true;
          }
        }
      }
    }
    return this.getState(registry);
  }

  public getState(registry: ProtectedWindowRegistry): CaptureProtectionState {
    const effective = this.getEffectiveEnabled();
    const affinities: Partial<
      Record<keyof CaptureProtectionWindowStatus, number | null>
    > = {};
    const keys: Array<keyof CaptureProtectionWindowStatus> = [
      'main',
      'hostToolbar',
      'chat',
      'sourcePicker',
      'settings',
    ];

    if (process.platform === 'win32') {
      for (const key of keys) {
        const win = registry[key];
        if (win && !win.isDestroyed()) {
          affinities[key] = readWindowDisplayAffinity(win);
        }
      }
    }

    const isWinActuallyProtected = (
      key: keyof CaptureProtectionWindowStatus
    ): boolean => {
      const win = registry[key];
      if (!win || win.isDestroyed()) return false;
      if (process.platform === 'win32') {
        return affinities[key] === WIN32_AFFINITY_EXCLUDE_FROM_CAPTURE;
      }
      return isAlwaysProtectedWindowKey(key) ? true : effective;
    };

    const openControlledKeys: Array<'main' | 'hostToolbar'> = [];
    if (registry.main && !registry.main.isDestroyed()) {
      openControlledKeys.push('main');
    }
    if (registry.hostToolbar && !registry.hostToolbar.isDestroyed()) {
      openControlledKeys.push('hostToolbar');
    }

    const verification = resolveHostVisibilityVerification({
      platform: process.platform,
      requestedEnabled: effective,
      applyFailed: this.lastApplyFailed,
      openControlledKeys,
      affinities,
    });

    return {
      enabled: effective,
      toggleAllowed: this.isToggleAllowed(),
      verificationStatus: verification.verificationStatus,
      error: verification.error,
      windows: {
        main: isWinActuallyProtected('main'),
        hostToolbar: isWinActuallyProtected('hostToolbar'),
        chat: isWinActuallyProtected('chat'),
        sourcePicker: isWinActuallyProtected('sourcePicker'),
        settings: isWinActuallyProtected('settings'),
      },
      windowDisplayAffinities: affinities,
    };
  }
}
