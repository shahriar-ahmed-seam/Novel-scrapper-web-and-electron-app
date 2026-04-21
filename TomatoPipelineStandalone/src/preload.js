import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('tp', {
  loadNovel: (novelId, showBrowser) => ipcRenderer.invoke('tp:novel:load', { novelId, showBrowser }),
  runStart: (opts) => ipcRenderer.invoke('tp:run:start', opts),
  runPause: (jobId, reason) => ipcRenderer.invoke('tp:run:pause', { jobId, reason }),
  runResume: (jobId) => ipcRenderer.invoke('tp:run:resume', { jobId }),
  runStop: (jobId) => ipcRenderer.invoke('tp:run:stop', { jobId }),
  runStatus: (jobId, sinceSeq) => ipcRenderer.invoke('tp:run:status', { jobId, sinceSeq }),
  runDetails: (jobId) => ipcRenderer.invoke('tp:run:details', { jobId }),
  jobsList: (novelId) => ipcRenderer.invoke('tp:jobs:list', { novelId })
});
