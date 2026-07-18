const { contextBridge, ipcRenderer } = require('electron');

// Sync read at page-load time so the renderer has config before it initializes.
const initialConfig = ipcRenderer.sendSync('config-get-sync') || {};

contextBridge.exposeInMainWorld('api', {
  getInitialConfig: () => initialConfig,
  persistConfig: (cfg) => ipcRenderer.invoke('config-save', cfg),
  getConfigPath: () => ipcRenderer.invoke('config-path'),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  listOllamaModels: () => ipcRenderer.invoke('list-ollama-models'),
  transcribe: (wavBuffer) => ipcRenderer.invoke('whisper-transcribe', { wavBuffer }),
  testWhisper: () => ipcRenderer.invoke('whisper-test'),
  setWindowOpacity: (v) => ipcRenderer.send('set-window-opacity', v),
  setCollapsed: (v) => ipcRenderer.send('set-collapsed', v),
  growWindow: (delta) => ipcRenderer.send('grow-window', delta),
  startResize: () => ipcRenderer.send('start-resize'),
  endResize: () => ipcRenderer.send('end-resize'),
  onTriggerScreenAsk: (cb) => ipcRenderer.on('trigger-screen-ask', cb),
  onToggleListen: (cb) => ipcRenderer.on('toggle-listen', cb),
  onCancelAll: (cb) => ipcRenderer.on('cancel-all', cb),
  onToggleCollapse: (cb) => ipcRenderer.on('toggle-collapse', cb),
  onFontDelta: (cb) => ipcRenderer.on('font-delta', (_e, d) => cb(d)),
  onOpacityDelta: (cb) => ipcRenderer.on('opacity-delta', (_e, d) => cb(d)),
  onInteractiveMode: (cb) => ipcRenderer.on('interactive-mode', (_e, v) => cb(v)),
});
