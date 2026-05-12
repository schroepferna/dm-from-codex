import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ndaDm', {
  openAuthUrl: (url: string) => ipcRenderer.invoke('auth:open-url', url),
  getPendingAuthCallback: () => ipcRenderer.invoke('auth:get-pending-callback'),
  completeSignIn: (request: unknown) => ipcRenderer.invoke('auth:complete-sign-in', request),
  verifySession: (request: unknown) => ipcRenderer.invoke('auth:verify-session', request),
  getDefaultDownloadDirectory: () => ipcRenderer.invoke('fs:get-default-download-directory'),
  getAvailableSpace: (targetDir: string) => ipcRenderer.invoke('fs:get-available-space', targetDir),
  chooseDownloadDirectory: () => ipcRenderer.invoke('fs:choose-directory'),
  scanDownloadDirectory: (request: unknown) => ipcRenderer.invoke('fs:scan-downloads', request),
  startDownloadJob: (request: unknown) => ipcRenderer.invoke('download:start', request),
  cancelDownloadJob: (jobId: string) => ipcRenderer.invoke('download:cancel', jobId),
  sendHelpRequest: (request: unknown) => ipcRenderer.invoke('help:submit', request),
  onAuthCallback: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('auth:callback', listener);
    return () => ipcRenderer.removeListener('auth:callback', listener);
  },
  onDownloadEvent: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('download:event', listener);
    return () => ipcRenderer.removeListener('download:event', listener);
  }
});
