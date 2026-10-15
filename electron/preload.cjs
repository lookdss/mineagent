const { contextBridge, ipcRenderer } = require('electron')

const on = (channel) => (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on(channel, h); return () => ipcRenderer.removeListener(channel, h) }

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  listModels: (baseUrl, apiKey) => ipcRenderer.invoke('llm:models', { baseUrl, apiKey }),
  start: () => ipcRenderer.invoke('bot:start'),
  stop: () => ipcRenderer.invoke('bot:stop'),
  getState: () => ipcRenderer.invoke('bot:state'),
  send: (msg) => ipcRenderer.invoke('bot:send', msg),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  version: () => ipcRenderer.invoke('app:version'),
  onLog: on('bot:log'),
  onState: on('bot:state'),
  onStatus: on('bot:status'),
  onChat: on('bot:chat'),
  onReady: on('bot:ready')
})
