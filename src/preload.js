const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  getAudioSources: () => ipcRenderer.invoke('get-audio-sources'),
  onTriggerScreenAsk: (cb) => ipcRenderer.on('trigger-screen-ask', cb),
  onToggleListen: (cb) => ipcRenderer.on('toggle-listen', cb),
  onInteractiveMode: (cb) => ipcRenderer.on('interactive-mode', (_e, v) => cb(v)),
});
