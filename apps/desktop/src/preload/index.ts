import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  DesktopRuntimeMetadata,
  ElmDesktopBridge,
  ShareableSourceDescriptor,
  TaskbarDwmTelemetry,
  WasapiAudioChunkPayload,
  WasapiEndpointProbeResult,
} from '../shared/bridge';

const bridge: ElmDesktopBridge = Object.freeze({
  getRuntimeMetadata: (): Promise<DesktopRuntimeMetadata> =>
    ipcRenderer.invoke('elm:get-runtime-metadata'),
  openSeparateChatWindow: (): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke('elm:open-separate-chat-window'),

  getTaskbarDwmTelemetry: (): Promise<TaskbarDwmTelemetry> =>
    ipcRenderer.invoke('elm:get-taskbar-dwm-telemetry'),
  minimizeMainWindow: (): Promise<TaskbarDwmTelemetry> =>
    ipcRenderer.invoke('elm:minimize-main-window'),
  restoreMainWindow: (): Promise<TaskbarDwmTelemetry> =>
    ipcRenderer.invoke('elm:restore-main-window'),
  runTaskbarMinimizeRestoreCycle: (): Promise<TaskbarDwmTelemetry> =>
    ipcRenderer.invoke('elm:run-taskbar-minimize-restore-cycle'),
  verifyStaticThumbnailAndPeek: (): Promise<TaskbarDwmTelemetry> =>
    ipcRenderer.invoke('elm:verify-static-thumbnail-and-peek'),

  listShareableSources: (): Promise<ShareableSourceDescriptor[]> =>
    ipcRenderer.invoke('elm:list-shareable-sources'),
  selectShareableSource: (
    sourceId: string
  ): Promise<{ selectedSourceId: string; sourceName: string }> =>
    ipcRenderer.invoke('elm:select-shareable-source', sourceId),

  probeWasapiLoopback: (): Promise<WasapiEndpointProbeResult> =>
    ipcRenderer.invoke('elm:probe-wasapi-loopback'),
  startWasapiLoopback: (options: {
    playTestTone: boolean;
  }): Promise<WasapiEndpointProbeResult> =>
    ipcRenderer.invoke('elm:start-wasapi-loopback', options),
  stopWasapiLoopback: (): Promise<{ stopped: boolean }> =>
    ipcRenderer.invoke('elm:stop-wasapi-loopback'),
  onWasapiAudioChunk: (
    listener: (chunk: WasapiAudioChunkPayload) => void
  ): (() => void) => {
    const wrapped = (_event: IpcRendererEvent, payload: WasapiAudioChunkPayload) => {
      listener(payload);
    };
    ipcRenderer.on('elm:wasapi-loopback-chunk', wrapped);
    return () => {
      ipcRenderer.removeListener('elm:wasapi-loopback-chunk', wrapped);
    };
  },
});

contextBridge.exposeInMainWorld('elmDesktop', bridge);
