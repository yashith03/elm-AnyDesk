export interface CaptureProtectionWindowStatus {
  readonly main: boolean;
  readonly hostToolbar: boolean;
  readonly chat: boolean;
  readonly sourcePicker: boolean;
  readonly settings: boolean;
}

export interface CaptureProtectionState {
  readonly enabled: boolean;
  readonly toggleAllowed: boolean;
  readonly windows: CaptureProtectionWindowStatus;
  readonly windowDisplayAffinities?: Partial<Record<keyof CaptureProtectionWindowStatus, number | null>>;
}

export function shouldAllowCaptureProtectionToggle(params: {
  isPackaged: boolean;
  argv: readonly string[];
  env: Record<string, string | undefined>;
}): boolean {
  if (!params.isPackaged) {
    return true;
  }
  return (
    params.argv.includes('--dev-mode') ||
    params.argv.includes('--run-prototype-suite') ||
    params.env.ELM_DEV_MODE === '1' ||
    params.env.ELM_CAPTURE_TEST_MODE === '1'
  );
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
