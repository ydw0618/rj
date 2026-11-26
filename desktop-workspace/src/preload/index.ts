import { contextBridge, ipcRenderer } from 'electron';
import type { WorkspaceApi } from '../shared/contracts';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke('workspace:' + channel, ...args);
const listen = <T>(channel: string, callback: (payload: T) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on('workspace:' + channel, listener);
  return () => ipcRenderer.removeListener('workspace:' + channel, listener);
};

const api: WorkspaceApi = {
  setAffineBounds: (bounds) => invoke('setAffineBounds', bounds),
  reloadAffine: () => invoke('reloadAffine'),
  openAffineInBrowser: () => invoke('openAffineInBrowser'),
  onAffineStatus: (callback) => listen('affineStatus', callback),
  overview: () => invoke('overview'),
  searchDocuments: (search) => invoke('searchDocuments', search),
  createProject: (name) => invoke('createProject', name),
  deleteProject: (id) => invoke('deleteProject', id),
  createDocument: (title, projectId) => invoke('createDocument', title, projectId),
  importDocuments: (projectId) => invoke('importDocuments', projectId),
  document: (id) => invoke('document', id),
  updateDocument: (id, title, projectId) => invoke('updateDocument', id, title, projectId),
  deleteDocument: (id) => invoke('deleteDocument', id),
  saveMarkdown: (id, markdown, revision) => invoke('saveMarkdown', id, markdown, revision),
  setTags: (id, names) => invoke('setTags', id, names),
  openDocument: (source) => invoke('openDocument', source),
  asset: (id) => invoke('asset', id),
  annotations: (id) => invoke('annotations', id),
  addAnnotation: (id, anchor, text) => invoke('addAnnotation', id, anchor, text),
  updateAnnotation: (id, text) => invoke('updateAnnotation', id, text),
  deleteAnnotation: (id) => invoke('deleteAnnotation', id),
  history: (id) => invoke('history', id),
  version: (id, versionId) => invoke('version', id, versionId),
  restoreVersion: (id, versionId, revision) => invoke('restoreVersion', id, versionId, revision),
  tasks: () => invoke('tasks'),
  createTask: (input) => invoke('createTask', input),
  updateTask: (id, input) => invoke('updateTask', id, input),
  toggleTask: (id, done) => invoke('toggleTask', id, done),
  deleteTask: (id) => invoke('deleteTask', id),
  reorderTasks: (ids) => invoke('reorderTasks', ids),
  resetTaskOrder: () => invoke('resetTaskOrder'),
  markdownLayout: () => invoke('markdownLayout'),
  saveMarkdownLayout: (layout) => invoke('saveMarkdownLayout', layout),
  exportDocument: (id, format) => invoke('exportDocument', id, format),
  exportWorkspace: () => invoke('exportWorkspace'),
  previewImport: () => invoke('previewImport'),
  finishImport: (token) => invoke('finishImport', token),
  cancelImport: (token) => invoke('cancelImport', token),
  chatSettings: () => invoke('chatSettings'),
  saveChatSettings: (model, key) => invoke('saveChatSettings', model, key),
  sendChat: (messages) => invoke('sendChat', messages),
  onWorkspaceChange: (callback) => listen('changed', callback),
  onMarkdownLayoutChange: (callback) => listen('markdownLayout', callback),
  onOpenSource: (callback) => listen('source', callback),
  onFlushDocument: (callback) => listen('flush', callback),
  completeFlush: (ticket, error) => ipcRenderer.send('workspace:flush-result', ticket, error),
};

contextBridge.exposeInMainWorld('workspace', api);
