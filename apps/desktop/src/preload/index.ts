import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopRuntimeMetadata, ElmDesktopBridge } from '../shared/bridge';

const bridge: ElmDesktopBridge = Object.freeze({
  getRuntimeMetadata: (): Promise<DesktopRuntimeMetadata> =>
    ipcRenderer.invoke('elm:get-runtime-metadata'),
  openSeparateChatWindow: (): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke('elm:open-separate-chat-window'),
});

contextBridge.exposeInMainWorld('elmDesktop', bridge);
