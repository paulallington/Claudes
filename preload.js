const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openDirectoryDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
  getProjects: () => ipcRenderer.invoke('config:getProjects'),
  saveProjects: (config) => ipcRenderer.invoke('config:saveProjects', config),
  getRecentSessions: (projectPath) => ipcRenderer.invoke('sessions:getRecent', projectPath),
  saveSessions: (projectPath, sessionIds) => ipcRenderer.invoke('sessions:save', projectPath, sessionIds),
  loadSessions: (projectPath) => ipcRenderer.invoke('sessions:load', projectPath)
});
