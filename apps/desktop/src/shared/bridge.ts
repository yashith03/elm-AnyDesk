import type {
  AllowedScreenSurface,
  HostMediaSelection,
  SessionLifecycleState,
} from '@elm/protocol';

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
  readonly electronVersion: string;
  readonly chromeVersion: string;
  readonly nodeVersion: string;
  readonly osRelease: string;
  readonly protocolVersion: string;
  readonly platform: string;
  readonly windowRole: DesktopWindowRole;
  readonly phase: 'Phase 2 — Local Windows 11 Prototype (Taskbar/DWM & Media Capture)';
  readonly defaultMediaSelection: HostMediaSelection;
  readonly initialSessionState: SessionLifecycleState;
  readonly securityPosture: DesktopSecurityPosture;
}

export interface TaskbarTransitionEvent {
  readonly timestamp: string;
  readonly action: string;
  readonly isMinimized: boolean;
  readonly win32IsIconic: boolean;
  readonly skipTaskbarApplied: boolean;
  readonly wsExAppWindow: boolean;
  readonly wsExToolWindow: boolean;
}

export interface TaskbarDwmTelemetry {
  readonly hwndHex: string;
  readonly isMinimized: boolean;
  readonly win32IsIconic: boolean;
  readonly win32IsVisible: boolean;
  readonly skipTaskbarApplied: boolean;
  readonly wsExAppWindow: boolean;
  readonly wsExToolWindow: boolean;
  readonly dwmAttributes: {
    readonly forceIconicRepresentation: string;
    readonly hasIconicBitmap: string;
    readonly disallowPeek: string;
    readonly excludedFromPeek: string;
    readonly invalidateIconicBitmaps: string;
  };
  readonly iconicThumbnail: {
    readonly callbackCount: number;
    readonly lastHResult: string;
    readonly lastWidth: number;
    readonly lastHeight: number;
  };
  readonly livePreview: {
    readonly callbackCount: number;
    readonly lastHResult: string;
  };
  readonly transitions: readonly TaskbarTransitionEvent[];
}

export interface ShareableSourceDescriptor {
  readonly id: string;
  readonly name: string;
  readonly surfaceType: AllowedScreenSurface;
  readonly displayId: string;
  readonly thumbnailDataUrl: string;
}

export interface WasapiEndpointProbeResult {
  readonly ok: boolean;
  readonly endpointId: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly error?: string;
}

export interface WasapiAudioChunkPayload {
  readonly sampleRate: number;
  readonly frames: number;
  readonly rms: number;
  readonly peak: number;
  readonly pcmFloat32Base64: string;
}

/**
 * Narrow preload bridge contract exposed on `window.elmDesktop`.
 * Raw Electron IPC primitives are never exposed to the renderer.
 */
export interface ElmDesktopBridge {
  getRuntimeMetadata: () => Promise<DesktopRuntimeMetadata>;
  openSeparateChatWindow: () => Promise<{ opened: boolean }>;

  // Windows 11 Taskbar & DWM Preview Prototype
  getTaskbarDwmTelemetry: () => Promise<TaskbarDwmTelemetry>;
  minimizeMainWindow: () => Promise<TaskbarDwmTelemetry>;
  restoreMainWindow: () => Promise<TaskbarDwmTelemetry>;
  runTaskbarMinimizeRestoreCycle: () => Promise<TaskbarDwmTelemetry>;
  verifyStaticThumbnailAndPeek: () => Promise<TaskbarDwmTelemetry>;

  // Explicit Source Picker (Displays & Windows only, never webcam)
  listShareableSources: () => Promise<ShareableSourceDescriptor[]>;
  selectShareableSource: (
    sourceId: string
  ) => Promise<{ selectedSourceId: string; sourceName: string }>;

  // Windows-native WASAPI Loopback Prototype (Device Audio independent of Screen Video)
  probeWasapiLoopback: () => Promise<WasapiEndpointProbeResult>;
  startWasapiLoopback: (options: {
    playTestTone: boolean;
  }) => Promise<WasapiEndpointProbeResult>;
  stopWasapiLoopback: () => Promise<{ stopped: boolean }>;
  onWasapiAudioChunk: (
    listener: (chunk: WasapiAudioChunkPayload) => void
  ) => () => void;
}

declare global {
  interface Window {
    elmDesktop: ElmDesktopBridge;
  }
}
