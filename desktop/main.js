const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

let mainWindow = null;

const PREFS_PATH = path.join(app.getPath('userData'), 'prefs.json');

function getPrefs() {
  try {
    if (fs.existsSync(PREFS_PATH)) {
      const raw = fs.readFileSync(PREFS_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (_) {}
  return {};
}

function savePrefs(prefs) {
  try {
    const dir = path.dirname(PREFS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2), 'utf-8');
  } catch (_) {}
}

/** Load KEY=value lines from a file; return object (no comments, no empty keys). */
function loadEnvFile(filePath) {
  const out = {};
  try {
    if (!filePath || !fs.existsSync(filePath)) return out;
    const raw = fs.readFileSync(filePath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (key) out[key] = value;
    }
  } catch (_) {}
  return out;
}

/** Encrypted API key storage (86, 90): key never stored in plaintext in prefs. */
const ENCRYPT_SALT = 'skate-desktop-api-key';
function getEncryptionKey() {
  return crypto.scryptSync(app.getPath('userData') + process.execPath, ENCRYPT_SALT, 32);
}
function getStoredApiKeyEncrypted() {
  const prefs = getPrefs();
  return prefs.apiKeyEncrypted || null;
}
function setStoredApiKey(plainKey) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(plainKey, 'utf8'), cipher.final()]);
  const blob = iv.toString('hex') + ':' + enc.toString('hex');
  savePrefs({ ...getPrefs(), apiKeyEncrypted: blob });
}
function getStoredApiKeyPlain() {
  const blob = getStoredApiKeyEncrypted();
  if (!blob) return null;
  try {
    const [ivHex, encHex] = blob.split(':');
    if (!ivHex || !encHex) return null;
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
  } catch (_) {
    return null;
  }
}
function clearStoredApiKey() {
  const prefs = getPrefs();
  const next = { ...prefs };
  delete next.apiKeyEncrypted;
  savePrefs(next);
}

/** Build env for CLI child: process.env + ~/.skate/env + cwd/.env; then stored API key (86), GTD_*, etc. Keys from Keychain never written to config (90). */
function buildEnvForTask(cwd) {
  const base = { ...process.env };
  const homeEnv = path.join(os.homedir(), '.skate', 'env');
  const cwdEnv = cwd ? path.join(cwd, '.env') : null;
  Object.assign(base, loadEnvFile(homeEnv), loadEnvFile(cwdEnv));
  const stored = getStoredApiKeyPlain();
  if (stored) base.OPENAI_API_KEY = stored;
  const prefs = getPrefs();
  if (prefs.sessionId) base.GTD_SESSION_ID = prefs.sessionId;
  if (prefs.qualityProfile) base.GTD_QUALITY_PROFILE = prefs.qualityProfile;
  if (prefs.approvalPolicy) base.GTD_APPROVAL_POLICY = prefs.approvalPolicy;
  if (prefs.model) base.GTD_MODEL = prefs.model;
  if (prefs.profile) base.GTD_ENV = prefs.profile;
  if (prefs.contextSize != null && prefs.contextSize !== '') base.GTD_CONTEXT_SIZE = String(prefs.contextSize);
  const flags = prefs.featureFlags || {};
  if (flags.streaming) base.GTD_STREAMING = '1';
  if (flags.mcp) base.GTD_MCP = '1';
  if (prefs.noColor) base.NO_COLOR = '1';
  return base;
}

function getOrCreateSessionId() {
  const prefs = getPrefs();
  if (prefs.sessionId) return prefs.sessionId;
  const id = require('crypto').randomUUID();
  savePrefs({ ...prefs, sessionId: id });
  return id;
}

/** Resolve path to gtd CLI: GTD_CLI_PATH env, or repo dist (dev), or bundled. */
function getGtdPath() {
  const envPath = process.env.GTD_CLI_PATH;
  if (envPath) return envPath;
  const isPackaged = app.isPackaged;
  const base = isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  const distJs = path.join(base, 'dist', 'cli', 'index.js');
  if (fs.existsSync(distJs)) return distJs;
  const binGtd = path.join(base, 'node_modules', '.bin', 'gtd');
  if (fs.existsSync(binGtd)) return binGtd;
  return distJs;
}

let currentTaskChild = null;

/** Run gtd CLI (non-streaming). Returns stdout + stderr. */
function runGtd(args, cwd) {
  return new Promise((resolve, reject) => {
    const gtdPath = getGtdPath();
    const isJs = gtdPath.endsWith('.js');
    const cmd = isJs ? process.execPath : gtdPath;
    const cmdArgs = isJs ? [gtdPath, ...args] : args;
    const resolvedCwd = cwd || getPrefs().lastCwd || process.cwd();
    getOrCreateSessionId();
    const opts = { cwd: resolvedCwd, env: buildEnvForTask(resolvedCwd) };
    const child = spawn(cmd, cmdArgs, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Run gtd task with streaming and cancel support. Sends task-stream-chunk to renderer; resolves with { code, stdout, stderr }. */
function runGtdStream(args, cwd, webContents) {
  return new Promise((resolve, reject) => {
    const gtdPath = getGtdPath();
    const isJs = gtdPath.endsWith('.js');
    const cmd = isJs ? process.execPath : gtdPath;
    const cmdArgs = isJs ? [gtdPath, ...args] : args;
    const resolvedCwd = cwd || getPrefs().lastCwd || process.cwd();
    getOrCreateSessionId();
    const opts = { cwd: resolvedCwd, env: buildEnvForTask(resolvedCwd) };
    const child = spawn(cmd, cmdArgs, opts);
    currentTaskChild = child;
    let stdout = '';
    let stderr = '';
    const send = (stream, data) => {
      if (webContents && !webContents.isDestroyed()) webContents.send('task-stream-chunk', { stream, data });
    };
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      send('stdout', s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      send('stderr', s);
    });
    child.on('error', (e) => {
      currentTaskChild = null;
      if (process.platform === 'darwin' && app.dock) app.dock.setBadge('');
      reject(e);
    });
    child.on('close', (code) => {
      currentTaskChild = null;
      if (process.platform === 'darwin' && app.dock) app.dock.setBadge('');
      if (webContents && !webContents.isDestroyed()) webContents.send('task-stream-done', { code, stdout, stderr });
      resolve({ code, stdout, stderr });
    });
    if (process.platform === 'darwin' && app.dock) app.dock.setBadge('1');
  });
}

function createWindow() {
  const prefs = getPrefs();
  const bounds = prefs.windowBounds || { width: 900, height: 700, x: undefined, y: undefined };
  mainWindow = new BrowserWindow({
    width: bounds.width || 900,
    height: bounds.height || 700,
    x: bounds.x,
    y: bounds.y,
    minWidth: 600,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    title: 'Skate',
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  // 91: Secure transport only — block non-HTTPS navigation (no mixed content)
  mainWindow.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (details, callback) => {
    const u = new URL(details.url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      callback({});
      return;
    }
    callback({ cancel: true });
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('resize', () => {
    const b = mainWindow.getBounds();
    savePrefs({ ...getPrefs(), windowBounds: { width: b.width, height: b.height, x: b.x, y: b.y } });
  });
  mainWindow.on('move', () => {
    const b = mainWindow.getBounds();
    savePrefs({ ...getPrefs(), windowBounds: { ...getPrefs().windowBounds, x: b.x, y: b.y } });
  });
}

// Deep link (82): register skate:// before ready (macOS)
if (process.platform === 'darwin') app.setAsDefaultProtocolClient('skate');

app.whenReady().then(() => {
  createWindow();
  // Deep link (82): handle skate://task/<id> or skate://open
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const m = /^skate:\/\/task\/([a-f0-9-]+)/i.exec(url);
    if (m) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('deep-link-task', m[1]);
      }
    } else if (url === 'skate://open' || url.startsWith('skate://open?')) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
  // Drag-drop folder on dock (84): set workspace when user drops folder on app icon
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        savePrefs({ ...getPrefs(), lastCwd: filePath });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('workspace-dropped', filePath);
        }
      }
    } catch (_) {}
  });
  // Auto-update (item 5): check when packaged and publish config is set
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = false;
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } catch (_) {}
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', (event, hasVisibleWindows) => {
  if (mainWindow === null) createWindow();
  else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
});

ipcMain.handle('run-task', async (_, description, cwd) => {
  const win = mainWindow || BrowserWindow.getFocusedWindow();
  const webContents = win && !win.isDestroyed() ? win.webContents : null;
  const { code, stdout, stderr } = await runGtdStream(['task', description], cwd || undefined, webContents);
  return { code, stdout, stderr };
});

ipcMain.handle('cancel-task', () => {
  if (currentTaskChild && currentTaskChild.kill) {
    currentTaskChild.kill('SIGINT');
    return true;
  }
  return false;
});

ipcMain.handle('list-tasks', async (_, cwd) => {
  const { code, stdout, stderr } = await runGtd(['session', 'list', '--format', 'json'], cwd || undefined);
  if (code !== 0) return { error: stderr || stdout };
  try {
    const data = JSON.parse(stdout);
    return { tasks: data.sessions || [] };
  } catch {
    return { error: stdout || stderr };
  }
});

ipcMain.handle('get-cwd', () => {
  const prefs = getPrefs();
  return prefs.lastCwd || process.cwd();
});

ipcMain.handle('set-workspace', (_, dir) => {
  const prefs = getPrefs();
  savePrefs({ ...prefs, lastCwd: dir || undefined });
  return true;
});

ipcMain.handle('show-folder-dialog', async () => {
  const win = mainWindow || BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win || null, {
    properties: ['openDirectory'],
    title: 'Choose project folder',
  });
  if (canceled || !filePaths || filePaths.length === 0) return null;
  return filePaths[0];
});

ipcMain.handle('show-file-dialog', async () => {
  const win = mainWindow || BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win || null, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach files',
  });
  if (canceled || !filePaths || filePaths.length === 0) return [];
  return filePaths;
});

// Prefs for layout (items 22, 27, 28): sidebar width, collapsed, theme, font size
ipcMain.handle('get-prefs', () => getPrefs());
ipcMain.handle('set-prefs', (_, patch) => {
  savePrefs({ ...getPrefs(), ...patch });
  return true;
});

// Window title (item 30)
ipcMain.handle('set-window-title', (_, title) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(title || 'Skate');
});

// Last run summary and task transcripts (items 35, 38, 39)
ipcMain.handle('get-last-run', () => {
  const prefs = getPrefs();
  return prefs.lastRun || null;
});

ipcMain.handle('set-last-run', (_, summary) => {
  const prefs = getPrefs();
  savePrefs({ ...prefs, lastRun: summary || undefined });
  return true;
});

ipcMain.handle('get-task-transcript', (_, taskId) => {
  const prefs = getPrefs();
  const map = prefs.taskTranscripts || {};
  return map[taskId] || null;
});

ipcMain.handle('set-task-transcript', (_, taskId, data) => {
  const prefs = getPrefs();
  const map = { ...(prefs.taskTranscripts || {}) };
  if (data) map[taskId] = data;
  else delete map[taskId];
  savePrefs({ ...prefs, taskTranscripts: map });
  return true;
});

ipcMain.handle('get-templates', () => {
  const prefs = getPrefs();
  return prefs.templates || [{ id: 'default', name: 'Default', body: '' }, { id: 'plan', name: 'Plan', body: 'Create a step-by-step plan for: ' }, { id: 'review', name: 'Review', body: 'Review the following and suggest improvements: ' }];
});

ipcMain.handle('set-templates', (_, list) => {
  const prefs = getPrefs();
  savePrefs({ ...prefs, templates: list || [] });
  return true;
});

/** Write pasted file (base64) to temp; return path. For attachments (item 42). */
ipcMain.handle('write-temp-file', (_, name, base64Data) => {
  try {
    const ext = path.extname(name) || '.bin';
    const baseName = (path.basename(name, ext) || 'paste').replace(/[^a-zA-Z0-9_-]/g, '_');
    const tmpPath = path.join(os.tmpdir(), 'skate-paste-' + Date.now() + '-' + baseName + ext);
    const buf = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(tmpPath, buf);
    return tmpPath;
  } catch (e) {
    return null;
  }
});

const CONFIG_DIR = path.join(os.homedir(), '.skate');

ipcMain.handle('get-config-path', () => CONFIG_DIR);

ipcMain.handle('open-config-folder', async () => {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    await shell.openPath(CONFIG_DIR);
    return true;
  } catch {
    return false;
  }
});

const CONFIG_JSON_PATH = path.join(CONFIG_DIR, 'config.json');

ipcMain.handle('get-config-json', () => {
  try {
    if (fs.existsSync(CONFIG_JSON_PATH)) return fs.readFileSync(CONFIG_JSON_PATH, 'utf-8');
  } catch (_) {}
  return '';
});

ipcMain.handle('set-config-json', (_, content) => {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_JSON_PATH, typeof content === 'string' ? content : '', 'utf-8');
    return true;
  } catch {
    return false;
  }
});

// MCP servers (61)
ipcMain.handle('get-mcp-servers', () => {
  const prefs = getPrefs();
  return prefs.mcpServers || [];
});

ipcMain.handle('set-mcp-servers', (_, list) => {
  const prefs = getPrefs();
  savePrefs({ ...prefs, mcpServers: Array.isArray(list) ? list : [] });
  return true;
});

// Rules path (62)
ipcMain.handle('get-rules-path', (_, cwd) => {
  if (!cwd) return null;
  const p = path.join(cwd, '.gtd', 'rules');
  return fs.existsSync(p) ? p : path.join(cwd, '.skate', 'rules');
});

// Config layers and diagnostics (63)
ipcMain.handle('get-config-layers', () => {
  const prefs = getPrefs();
  const layers = [];
  layers.push({ name: 'prefs', path: PREFS_PATH, exists: fs.existsSync(PREFS_PATH) });
  layers.push({ name: 'config', path: CONFIG_JSON_PATH, exists: fs.existsSync(CONFIG_JSON_PATH) });
  layers.push({ name: 'userData', path: app.getPath('userData'), exists: true });
  return layers;
});

function getDiagnosticsPayload() {
  const prefs = getPrefs();
  return {
    version: app.getVersion?.() || '1.0.0',
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    sessionId: prefs.sessionId || null,
    model: prefs.model || null,
    profile: prefs.profile || null,
    cwd: prefs.lastCwd || null,
    prefsPath: PREFS_PATH,
    configPath: CONFIG_JSON_PATH,
  };
}

ipcMain.handle('get-diagnostics', () => getDiagnosticsPayload());

// 100: Report issue / Send feedback — open GitHub new issue with env summary
const FEEDBACK_ISSUES_BASE = 'https://github.com/faridjafarlee/scaling-octo-eureka/issues/new';
ipcMain.handle('open-feedback-url', async () => {
  const d = getDiagnosticsPayload();
  const body = [
    '**Desktop app feedback**',
    '',
    '**Environment (please do not edit):**',
    '```',
    JSON.stringify({ version: d.version, platform: d.platform, arch: d.arch, release: d.release, cwd: d.cwd }, null, 2),
    '```',
    '',
    '**Description:**',
    '',
  ].join('\n');
  const url = FEEDBACK_ISSUES_BASE + '?title=Desktop%20feedback&body=' + encodeURIComponent(body);
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('export-diagnostics-to-file', async () => {
  const win = mainWindow || BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win || null, {
    defaultPath: 'skate-diagnostics.json',
    title: 'Export diagnostics',
  });
  if (canceled || !filePath) return false;
  try {
    fs.writeFileSync(filePath, JSON.stringify(getDiagnosticsPayload(), null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
});

// Last run by workspace (68)
ipcMain.handle('get-last-run-by-workspace', () => {
  const prefs = getPrefs();
  return prefs.lastRunByWorkspace || {};
});

ipcMain.handle('set-last-run-by-workspace', (_, cwd, summary) => {
  const prefs = getPrefs();
  const map = { ...(prefs.lastRunByWorkspace || {}) };
  if (summary) map[cwd || ''] = summary;
  else if (cwd) delete map[cwd];
  savePrefs({ ...prefs, lastRunByWorkspace: map });
  return true;
});

// Archived sessions (70)
ipcMain.handle('get-archived-sessions', () => {
  const prefs = getPrefs();
  return prefs.archivedSessions || [];
});

ipcMain.handle('set-archived-sessions', (_, ids) => {
  const prefs = getPrefs();
  savePrefs({ ...prefs, archivedSessions: Array.isArray(ids) ? ids : [] });
  return true;
});

// Export transcript to file (71)
ipcMain.handle('export-transcript-to-file', async (_, content, format) => {
  const win = mainWindow || BrowserWindow.getFocusedWindow();
  const ext = format === 'markdown' ? '.md' : '.json';
  const defaultName = 'skate-transcript-' + Date.now() + ext;
  const { canceled, filePath } = await dialog.showSaveDialog(win || null, {
    defaultPath: defaultName,
    title: 'Export transcript',
    filters: format === 'markdown' ? [{ name: 'Markdown', extensions: ['md'] }] : [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return false;
  try {
    const out = format === 'markdown' ? content : JSON.stringify({ transcript: content, exportedAt: new Date().toISOString() }, null, 2);
    fs.writeFileSync(filePath, out, 'utf-8');
    return true;
  } catch {
    return false;
  }
});

// Open in Terminal (76): open system terminal at cwd
ipcMain.handle('open-in-terminal', async (_, cwd) => {
  if (!cwd) return false;
  try {
    if (process.platform === 'darwin') {
      const { execFileSync } = require('child_process');
      const script = 'tell application "Terminal" to do script "cd " & quoted form of ' + JSON.stringify(cwd);
      execFileSync('osascript', ['-e', script]);
    } else {
      await shell.openPath(cwd);
    }
    return true;
  } catch {
    return false;
  }
});

// Notifications (80)
ipcMain.handle('show-notification', (_, title, body) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  } catch (_) {}
});

// Open folder in file manager (73)
ipcMain.handle('open-folder', async (_, dirPath) => {
  if (!dirPath) return false;
  try {
    await shell.openPath(dirPath);
    return true;
  } catch {
    return false;
  }
});

// Git branch and open diff (79)
ipcMain.handle('get-git-branch', async (_, cwd) => {
  if (!cwd) return null;
  try {
    const { execFileSync } = require('child_process');
    return execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
});

ipcMain.handle('open-diff', async (_, cwd) => {
  if (!cwd) return { ok: false, diff: null };
  try {
    const { execFileSync } = require('child_process');
    const diff = execFileSync('git', ['-C', cwd, 'diff'], { encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 });
    return { ok: true, diff: diff || '(no changes)' };
  } catch (e) {
    return { ok: false, diff: null, error: e.message };
  }
});

// Quick Look (85): preview file or folder on macOS
ipcMain.handle('open-quicklook', async (_, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    if (process.platform === 'darwin') {
      const { execFileSync } = require('child_process');
      execFileSync('qlmanage', ['-p', filePath], { stdio: 'ignore' });
      return true;
    }
    return false;
  } catch {
    return false;
  }
});

// Auth (86–90): API key in encrypted storage, never plaintext in config
ipcMain.handle('get-login-status', () => ({ loggedIn: !!getStoredApiKeyEncrypted() }));
ipcMain.handle('login-save-key', async (_, apiKey) => {
  if (!apiKey || typeof apiKey !== 'string') return { ok: false, error: 'Key required' };
  const trimmed = apiKey.trim();
  if (!trimmed) return { ok: false, error: 'Key required' };
  setStoredApiKey(trimmed);
  return { ok: true };
});
ipcMain.handle('logout-remove-key', () => {
  clearStoredApiKey();
  return true;
});
ipcMain.handle('validate-api-key', async (_, apiKey) => {
  const key = (apiKey && apiKey.trim()) || getStoredApiKeyPlain();
  if (!key) return { ok: false, error: 'No key' };
  try {
    const cwd = getPrefs().lastCwd || process.cwd();
    const env = { ...buildEnvForTask(cwd), OPENAI_API_KEY: key };
    const gtdPath = getGtdPath();
    const isJs = gtdPath.endsWith('.js');
    const cmd = isJs ? process.execPath : gtdPath;
    const cmdArgs = isJs ? [gtdPath, 'session', 'list', '--format', 'json'] : ['session', 'list', '--format', 'json'];
    const { code } = await new Promise((resolve, reject) => {
      const child = spawn(cmd, cmdArgs, { cwd, env });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code }));
    });
    return { ok: code === 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Handoff import (78): run gtd handoff-import <file>
ipcMain.handle('handoff-import-file', async () => {
  const win = mainWindow || BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win || null, {
    properties: ['openFile'],
    title: 'Import handoff bundle',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePaths || filePaths.length === 0) return { ok: false };
  try {
    const cwd = getPrefs().lastCwd || process.cwd();
    const { code, stdout, stderr } = await runGtd(['handoff-import', filePaths[0]], cwd);
    return { ok: code === 0, stdout, stderr };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
