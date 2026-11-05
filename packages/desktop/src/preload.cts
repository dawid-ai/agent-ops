import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

type Listener = (payload: unknown) => void;

function subscribe(channel: string, fn: Listener): () => void {
  const handler = (_e: IpcRendererEvent, payload: unknown): void => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

// The page talks to opsd only through the main process, which holds the API token.
contextBridge.exposeInMainWorld('agentOps', {
  info: () => ipcRenderer.invoke('ops:info'),
  setupStatus: () => ipcRenderer.invoke('ops:setup-status'),
  setup: (me: string, roots: string[]) => ipcRenderer.invoke('ops:setup', me, roots),
  restart: () => ipcRenderer.invoke('ops:restart'),
  runtime: (name: string, input: unknown) => ipcRenderer.invoke('ops:runtime', name, input),
  service: (action: string) => ipcRenderer.invoke('ops:service', action),
  desktop: () => ipcRenderer.invoke('ops:desktop'),
  update: (action?: 'check' | 'install') => ipcRenderer.invoke('ops:update', action),
  onUpdate: (fn: Listener) => subscribe('ops:update', fn),
  desktopSet: (patch: unknown) => ipcRenderer.invoke('ops:desktop-set', patch),
  voice: () => ipcRenderer.invoke('ops:voice'),
  voiceSet: (patch: unknown) => ipcRenderer.invoke('ops:voice-set', patch),
  voiceBrowse: (kind: 'program' | 'model') => ipcRenderer.invoke('ops:voice-browse', kind),
  transcribe: (wav: Uint8Array) => ipcRenderer.invoke('ops:transcribe', wav),
  call: (method: 'GET' | 'POST', path: string, body?: unknown) =>
    ipcRenderer.invoke('ops:call', method, path, body),
  onEvent: (fn: Listener) => subscribe('ops:event', fn),
  onStatus: (fn: Listener) => subscribe('ops:status', fn),
  onNavigate: (fn: Listener) => subscribe('ops:navigate', fn),
  onService: (fn: Listener) => subscribe('ops:service', fn),
});
