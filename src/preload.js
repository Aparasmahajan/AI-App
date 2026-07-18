const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  listOllamaModels: () => ipcRenderer.invoke('list-ollama-models'),
  transcribe: (url, wavBuffer) => ipcRenderer.invoke('whisper-transcribe', { url, wavBuffer }),
  testWhisper: (url) => ipcRenderer.invoke('whisper-test', url),
  setWindowOpacity: (v) => ipcRenderer.send('set-window-opacity', v),
  onTriggerScreenAsk: (cb) => ipcRenderer.on('trigger-screen-ask', cb),
  onToggleListen: (cb) => ipcRenderer.on('toggle-listen', cb),
  onCancelAll: (cb) => ipcRenderer.on('cancel-all', cb),
  onToggleCollapse: (cb) => ipcRenderer.on('toggle-collapse', cb),
  onFontDelta: (cb) => ipcRenderer.on('font-delta', (_e, d) => cb(d)),
  onOpacityDelta: (cb) => ipcRenderer.on('opacity-delta', (_e, d) => cb(d)),
  onInteractiveMode: (cb) => ipcRenderer.on('interactive-mode', (_e, v) => cb(v)),
});
