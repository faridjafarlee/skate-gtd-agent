const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gtd', {
  runTask: (description, cwd) => ipcRenderer.invoke('run-task', description, cwd),
  listTasks: (cwd) => ipcRenderer.invoke('list-tasks', cwd),
  getCwd: () => ipcRenderer.invoke('get-cwd'),
  setWorkspace: (dir) => ipcRenderer.invoke('set-workspace', dir),
  showFolderDialog: () => ipcRenderer.invoke('show-folder-dialog'),
  showFileDialog: () => ipcRenderer.invoke('show-file-dialog'),
  getTemplates: () => ipcRenderer.invoke('get-templates'),
  setTemplates: (list) => ipcRenderer.invoke('set-templates', list),
  getPrefs: () => ipcRenderer.invoke('get-prefs'),
  setPrefs: (patch) => ipcRenderer.invoke('set-prefs', patch),
  setWindowTitle: (title) => ipcRenderer.invoke('set-window-title', title),
  cancelTask: () => ipcRenderer.invoke('cancel-task'),
  onTaskChunk: (cb) => {
    const fn = (_, payload) => cb(payload);
    ipcRenderer.on('task-stream-chunk', fn);
    return () => ipcRenderer.removeListener('task-stream-chunk', fn);
  },
  onTaskDone: (cb) => {
    const fn = (_, payload) => cb(payload);
    ipcRenderer.on('task-stream-done', fn);
    return () => ipcRenderer.removeListener('task-stream-done', fn);
  },
  getLastRun: () => ipcRenderer.invoke('get-last-run'),
  setLastRun: (summary) => ipcRenderer.invoke('set-last-run', summary),
  getTaskTranscript: (taskId) => ipcRenderer.invoke('get-task-transcript', taskId),
  setTaskTranscript: (taskId, data) => ipcRenderer.invoke('set-task-transcript', taskId, data),
  writeTempFile: (name, base64Data) => ipcRenderer.invoke('write-temp-file', name, base64Data),
  getConfigPath: () => ipcRenderer.invoke('get-config-path'),
  openConfigFolder: () => ipcRenderer.invoke('open-config-folder'),
  getConfigJson: () => ipcRenderer.invoke('get-config-json'),
  setConfigJson: (content) => ipcRenderer.invoke('set-config-json', content),
  getMcpServers: () => ipcRenderer.invoke('get-mcp-servers'),
  setMcpServers: (list) => ipcRenderer.invoke('set-mcp-servers', list),
  getRulesPath: (cwd) => ipcRenderer.invoke('get-rules-path', cwd),
  getConfigLayers: () => ipcRenderer.invoke('get-config-layers'),
  getDiagnostics: () => ipcRenderer.invoke('get-diagnostics'),
  exportDiagnosticsToFile: () => ipcRenderer.invoke('export-diagnostics-to-file'),
  getLastRunByWorkspace: () => ipcRenderer.invoke('get-last-run-by-workspace'),
  setLastRunByWorkspace: (cwd, summary) => ipcRenderer.invoke('set-last-run-by-workspace', cwd, summary),
  getArchivedSessions: () => ipcRenderer.invoke('get-archived-sessions'),
  setArchivedSessions: (ids) => ipcRenderer.invoke('set-archived-sessions', ids),
  exportTranscriptToFile: (content, format) => ipcRenderer.invoke('export-transcript-to-file', content, format),
  openInTerminal: (cwd) => ipcRenderer.invoke('open-in-terminal', cwd),
  showNotification: (title, body, type) => ipcRenderer.invoke('show-notification', title, body, type),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  getGitBranch: (cwd) => ipcRenderer.invoke('get-git-branch', cwd),
  openDiff: (cwd) => ipcRenderer.invoke('open-diff', cwd),
  handoffImportFile: () => ipcRenderer.invoke('handoff-import-file'),
  openQuickLook: (filePath) => ipcRenderer.invoke('open-quicklook', filePath),
  getLoginStatus: () => ipcRenderer.invoke('get-login-status'),
  loginSaveKey: (apiKey) => ipcRenderer.invoke('login-save-key', apiKey),
  logoutRemoveKey: () => ipcRenderer.invoke('logout-remove-key'),
  validateApiKey: (apiKey) => ipcRenderer.invoke('validate-api-key', apiKey),
  openFeedbackUrl: () => ipcRenderer.invoke('open-feedback-url'),
  onDeepLinkTask: (cb) => {
    const fn = (_, taskId) => cb(taskId);
    ipcRenderer.on('deep-link-task', fn);
    return () => ipcRenderer.removeListener('deep-link-task', fn);
  },
  onWorkspaceDropped: (cb) => {
    const fn = (_, path) => cb(path);
    ipcRenderer.on('workspace-dropped', fn);
    return () => ipcRenderer.removeListener('workspace-dropped', fn);
  },
});
