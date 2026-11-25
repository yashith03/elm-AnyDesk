export interface CaptureProtectionWindowStatus {
  readonly main: boolean;
  readonly hostToolbar: boolean;
  readonly chat: boolean;
  readonly sourcePicker: boolean;
  readonly settings: boolean;
}

export type CaptureProtectionVerificationStatus =
  | 'verified_on'
  | 'verified_off'
  | 'unverified';

export interface CaptureProtectionState {
  /** Requested Host Visibility state for main + hostToolbar (defaults ON; never persisted OFF). */
  readonly enabled: boolean;
  /** Whether the user is allowed to toggle Host Visibility (main + hostToolbar). */
  readonly toggleAllowed: boolean;
  /** Actual verified protection status based on OS display affinity (Windows) or apply result. */
  readonly verificationStatus: CaptureProtectionVerificationStatus;
  /** Non-null when protection could not be applied or verified. */
  readonly error?: string | null;
  readonly windows: CaptureProtectionWindowStatus;
  readonly windowDisplayAffinities?: Partial<
    Record<keyof CaptureProtectionWindowStatus, number | null>
  >;
}

/** Windows display affinity exclude-from-capture value (0x11 = 17). */
export const WIN32_AFFINITY_EXCLUDE_FROM_CAPTURE = 0x11;
/** Windows display affinity none value (0x00 = 0). */
export const WIN32_AFFINITY_NONE = 0x00;

/**
 * Sensitive popups (private Chat, Settings, Source Picker) stay capture-protected
 * even when the Host toggles "Hide Elm-AnyDesk UI" OFF for the main window and toolbar.
 */
export function isAlwaysProtectedWindowKey(
  key: keyof CaptureProtectionWindowStatus
): boolean {
  return key === 'chat' || key === 'sourcePicker' || key === 'settings';
}

/**
 * Host Visibility ("Hide Elm-AnyDesk UI") is user-controlled in all builds (defaults ON,
 * never persisted OFF across restarts). Private Chat and sensitive popups remain always protected.
 */
export function shouldAllowCaptureProtectionToggle(_params?: {
  isPackaged?: boolean;
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
}): boolean {
  return true;
}

export function resolveEffectiveCaptureProtection(params: {
  toggleAllowed: boolean;
  requestedEnabled: boolean;
}): boolean {
  if (!params.toggleAllowed) {
    return true;
  }
  return Boolean(params.requestedEnabled);
}

/**
 * Computes actual verified Host Visibility state from Win32 GetWindowDisplayAffinity readings
 * on the toggle-controlled windows (`main` and `hostToolbar`).
 */
export function resolveHostVisibilityVerification(params: {
  platform: string;
  requestedEnabled: boolean;
  applyFailed: boolean;
  openControlledKeys: readonly ('main' | 'hostToolbar')[];
  affinities: Partial<Record<keyof CaptureProtectionWindowStatus, number | null>>;
}): {
  readonly verificationStatus: CaptureProtectionVerificationStatus;
  readonly error: string | null;
} {
  if (params.applyFailed) {
    return {
      verificationStatus: 'unverified',
      error: 'Failed to apply capture protection to Host window.',
    };
  }
  if (params.platform !== 'win32') {
    return {
      verificationStatus: params.requestedEnabled ? 'verified_on' : 'verified_off',
      error: null,
    };
  }
  if (params.openControlledKeys.length === 0) {
    return {
      verificationStatus: params.requestedEnabled ? 'verified_on' : 'verified_off',
      error: null,
    };
  }

  const expectedAffinity = params.requestedEnabled
    ? WIN32_AFFINITY_EXCLUDE_FROM_CAPTURE
    : WIN32_AFFINITY_NONE;

  for (const key of params.openControlledKeys) {
    const actual = params.affinities[key];
    if (actual === null || actual === undefined) {
      return {
        verificationStatus: 'unverified',
        error: `Could not verify Windows display affinity for ${key}.`,
      };
    }
    if (actual !== expectedAffinity) {
      return {
        verificationStatus: 'unverified',
        error: `Unexpected display affinity for ${key} (expected ${expectedAffinity}, got ${actual}).`,
      };
    }
  }

  return {
    verificationStatus: params.requestedEnabled ? 'verified_on' : 'verified_off',
    error: null,
  };
}
