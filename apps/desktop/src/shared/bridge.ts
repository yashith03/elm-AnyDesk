import type { HostMediaSelection, SessionLifecycleState } from '@elm/protocol';

export type DesktopWindowRole = 'main' | 'chat';

export interface DesktopSecurityPosture {
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly webSecurity: true;
  readonly narrowPreloadBridge: true;
}

export interface DesktopRuntimeMetadata {
  readonly appName: string;
  readonly appVersion: string;
  readonly protocolVersion: string;
  readonly platform: string;
  readonly windowRole: DesktopWindowRole;
  readonly phase: 'Phase 1 — Project Brief & Scaffold Only';
  readonly defaultMediaSelection: HostMediaSelection;
  readonly initialSessionState: SessionLifecycleState;
  readonly securityPosture: DesktopSecurityPosture;
}

/**
 * Narrow preload bridge contract exposed on `window.elmDesktop`.
 * Raw Electron IPC primitives are never exposed to the renderer.
 */
export interface ElmDesktopBridge {
  getRuntimeMetadata: () => Promise<DesktopRuntimeMetadata>;
  openSeparateChatWindow: () => Promise<{ opened: boolean }>;
}

declare global {
  interface Window {
    elmDesktop: ElmDesktopBridge;
  }
}
