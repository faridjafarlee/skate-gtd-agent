const taskInput = document.getElementById('taskInput');
const runBtn = document.getElementById('runBtn');
const cancelBtn = document.getElementById('cancelBtn');
const outputEl = document.getElementById('output');
const taskListEl = document.getElementById('taskList');
const cwdEl = document.getElementById('cwd');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarResize = document.getElementById('sidebarResize');
const themeSelect = document.getElementById('themeSelect');
const fontSizeRange = document.getElementById('fontSizeRange');
const fontSizeValue = document.getElementById('fontSizeValue');
const copyTranscriptBtn = document.getElementById('copyTranscriptBtn');
const runningStateEl = document.getElementById('runningState');
const stepNameEl = document.getElementById('stepName');
const completionSummaryEl = document.getElementById('completionSummary');
const failureActionsEl = document.getElementById('failureActions');
const retryBtn = document.getElementById('retryBtn');
const approveBtn = document.getElementById('approveBtn');
const continueLastWrap = document.getElementById('continueLastWrap');
const continueLastBtn = document.getElementById('continueLastBtn');
const templateSelect = document.getElementById('templateSelect');
const attachBtn = document.getElementById('attachBtn');
const attachPathBtn = document.getElementById('attachPathBtn');
const ephemeralCheck = document.getElementById('ephemeralCheck');
const attachmentsList = document.getElementById('attachmentsList');
const blockedApproval = document.getElementById('blockedApproval');
const approveBlockedBtn = document.getElementById('approveBlockedBtn');
const rejectBlockedBtn = document.getElementById('rejectBlockedBtn');
const qualityProfileSelect = document.getElementById('qualityProfileSelect');
const approvalPolicySelect = document.getElementById('approvalPolicySelect');
const keepDraftCheck = document.getElementById('keepDraftCheck');
const composerMeta = document.getElementById('composerMeta');
const commandPalette = document.getElementById('commandPalette');
const commandPaletteInput = document.getElementById('commandPaletteInput');
const commandPaletteList = document.getElementById('commandPaletteList');
const modelSelect = document.getElementById('modelSelect');
const profileSelect = document.getElementById('profileSelect');
const contextSizeSelect = document.getElementById('contextSizeSelect');
const configPathDisplay = document.getElementById('configPathDisplay');
const openConfigBtn = document.getElementById('openConfigBtn');
const configJson = document.getElementById('configJson');
const flagStreaming = document.getElementById('flagStreaming');
const flagMcp = document.getElementById('flagMcp');
const noColorCheck = document.getElementById('noColorCheck');
const mcpServerList = document.getElementById('mcpServerList');
const mcpServerInput = document.getElementById('mcpServerInput');
const mcpAddBtn = document.getElementById('mcpAddBtn');
const rulesPathDisplay = document.getElementById('rulesPathDisplay');
const reloadRulesBtn = document.getElementById('reloadRulesBtn');
const showConfigLayersBtn = document.getElementById('showConfigLayersBtn');
const exportDiagnosticsBtn = document.getElementById('exportDiagnosticsBtn');
const historySearchInput = document.getElementById('historySearchInput');
const historyStatusFilter = document.getElementById('historyStatusFilter');
const historyLoadMoreBtn = document.getElementById('historyLoadMoreBtn');
const resumeAllBtn = document.getElementById('resumeAllBtn');
const historyList = document.getElementById('historyList');
const statusLine = document.getElementById('statusLine');
const exportTranscriptBtn = document.getElementById('exportTranscriptBtn');
const shareTranscriptBtn = document.getElementById('shareTranscriptBtn');
const copyCommandBtn = document.getElementById('copyCommandBtn');
const openInTerminalBtn = document.getElementById('openInTerminalBtn');
const gitBranchDisplay = document.getElementById('gitBranchDisplay');
const gitRow = document.getElementById('gitRow');
const openDiffBtn = document.getElementById('openDiffBtn');

let attachmentPaths = [];
const DRAFT_HISTORY_MAX = 20;
let draftHistory = [];
let draftIndex = -1;
let templates = [];

const MIN_SIDEBAR = 48;
const MAX_SIDEBAR = 400;
const DEFAULT_SIDEBAR = 220;

function setOutput(text, isError) {
  outputEl.innerHTML = '';
  if (!text) {
    outputEl.textContent = '';
  } else {
    appendTranscriptHtml(outputEl, text);
  }
  outputEl.classList.toggle('error', !!isError);
  outputEl.scrollTop = outputEl.scrollHeight;
}

/** Append raw text to transcript (for streaming). */
function appendOutputText(text) {
  const span = document.createElement('span');
  span.textContent = text;
  outputEl.appendChild(span);
  outputEl.scrollTop = outputEl.scrollHeight;
}

/** Parse plain text for ``` code blocks and diff lines; return HTML string. */
function transcriptToHtml(text) {
  if (!text) return '';
  const parts = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    parts.push({ type: 'text', value: text.slice(lastIndex, m.index) });
    parts.push({ type: 'code', lang: (m[1] || '').trim(), value: m[2].replace(/\n$/, '') });
    lastIndex = m.index + m[0].length;
  }
  parts.push({ type: 'text', value: text.slice(lastIndex) });
  let html = '';
  for (const p of parts) {
    if (p.type === 'text') {
      const escaped = escapeHtml(p.value);
      const withDiff = escaped.replace(/^([+\-].*)$/gm, (_, line) => {
        const cls = line.startsWith('+') ? 'diff-add' : 'diff-remove';
        return '<span class="' + cls + '">' + escapeHtml(line) + '</span>';
      });
      html += withDiff;
    } else {
      html += '<div class="code-block">';
      if (p.lang) html += '<div class="lang">' + escapeHtml(p.lang) + '</div>';
      html += '<pre><code>' + escapeHtml(p.value) + '</code></pre></div>';
    }
  }
  return html;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function appendTranscriptHtml(container, text) {
  const frag = document.createRange().createContextualFragment(transcriptToHtml(text));
  container.appendChild(frag);
}

function setRunning(running, stepName) {
  runBtn.disabled = running;
  runBtn.textContent = running ? 'Running…' : 'Run task';
  runBtn.hidden = running;
  if (cancelBtn) cancelBtn.hidden = !running;
  if (runningStateEl) {
    runningStateEl.hidden = !running;
    if (stepNameEl) stepNameEl.textContent = stepName || 'Running…';
  }
  if (!running) {
    failureActionsEl.hidden = true;
    completionSummaryEl.hidden = true;
    if (blockedApproval) blockedApproval.hidden = true;
  }
}

/** Expand /plan, /review, /diff at start of text. */
function expandSlashCommand(text) {
  const t = text.trim();
  const m = t.match(/^\/(plan|review|diff)(?:\s+(.*))?$/i);
  if (!m) return t;
  const rest = (m[2] || '').trim();
  if (m[1].toLowerCase() === 'plan') return rest ? 'Create a step-by-step plan: ' + rest : t;
  if (m[1].toLowerCase() === 'review') return rest ? 'Review the following and suggest improvements: ' + rest : t;
  if (m[1].toLowerCase() === 'diff') return rest ? 'Show diff for: ' + rest : t;
  return t;
}

/** Build final description: expand slash, optionally expand /template:name, append attachments. */
function buildDescription() {
  let text = taskInput.value.trim();
  const templateMatch = text.match(/^\/template:(\w+)(?:\s+(.*))?$/i);
  if (templateMatch && window.gtd.getTemplates) {
    const name = templateMatch[1].toLowerCase();
    const rest = (templateMatch[2] || '').trim();
    const t = templates.find((x) => (x.id || x.name || '').toLowerCase() === name);
    if (t && t.body) text = (t.body + (rest ? ' ' + rest : '')).trim();
    else text = rest;
  }
  text = expandSlashCommand(text);
  if (attachmentPaths.length) text += '\n\nAttachments: ' + attachmentPaths.join(', ');
  return text;
}

function renderAttachments() {
  if (!attachmentsList) return;
  if (attachmentPaths.length === 0) {
    attachmentsList.hidden = true;
    attachmentsList.innerHTML = '';
    return;
  }
  attachmentsList.hidden = false;
  attachmentsList.innerHTML = attachmentPaths.map((p, i) => {
    const name = p.split(/[/\\]/).pop();
    return '<span>' + escapeHtml(name) + '<button type="button" class="remove-attach" data-index="' + i + '" aria-label="Remove">×</button></span>';
  }).join('');
  attachmentsList.querySelectorAll('.remove-attach').forEach((btn) => {
    btn.addEventListener('click', () => {
      attachmentPaths = attachmentPaths.filter((_, idx) => idx !== parseInt(btn.getAttribute('data-index'), 10));
      renderAttachments();
    });
  });
}

/** Update char/word/token count (item 52). */
function updateComposerMeta() {
  if (!composerMeta) return;
  const text = (taskInput && taskInput.value) || '';
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const tokens = Math.round(chars / 4);
  composerMeta.textContent = chars + ' chars · ' + words + ' words · ~' + tokens + ' tokens';
}

if (taskInput && composerMeta) {
  taskInput.addEventListener('input', updateComposerMeta);
}

async function loadPrefs() {
  try {
    const p = await window.gtd.getPrefs();
    return p || {};
  } catch {
    return {};
  }
}

async function applyPrefs() {
  const p = await loadPrefs();
  const sidebarWidth = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, p.sidebarWidth || DEFAULT_SIDEBAR));
  document.documentElement.style.setProperty('--sidebar-width', sidebarWidth + 'px');
  if (p.sidebarCollapsed) {
    sidebar.classList.add('collapsed');
    sidebarToggle.setAttribute('aria-label', 'Expand sidebar');
  } else {
    sidebar.classList.remove('collapsed');
    sidebarToggle.setAttribute('aria-label', 'Collapse sidebar');
  }
  const theme = p.theme || 'system';
  themeSelect.value = theme;
  document.documentElement.removeAttribute('data-theme');
  if (theme !== 'system') document.documentElement.setAttribute('data-theme', theme);
  const fontSize = Math.max(12, Math.min(20, Number(p.fontSize) || 14));
  fontSizeRange.value = fontSize;
  fontSizeValue.textContent = fontSize;
  document.documentElement.style.setProperty('--font-size', fontSize + 'px');
  if (qualityProfileSelect) qualityProfileSelect.value = p.qualityProfile || '';
  if (approvalPolicySelect) approvalPolicySelect.value = p.approvalPolicy || '';
  if (modelSelect) modelSelect.value = p.model || '';
  if (profileSelect) profileSelect.value = p.profile || '';
  if (contextSizeSelect) contextSizeSelect.value = p.contextSize != null ? String(p.contextSize) : '';
  if (keepDraftCheck) keepDraftCheck.checked = !!p.keepDraft;
  const flags = p.featureFlags || {};
  if (flagStreaming) flagStreaming.checked = !!flags.streaming;
  if (flagMcp) flagMcp.checked = !!flags.mcp;
  if (noColorCheck) noColorCheck.checked = !!p.noColor;
  updateStatusLine();
}

async function loadCwd() {
  try {
    const cwd = await window.gtd.getCwd();
    cwdEl.textContent = cwd || '—';
  } catch {
    cwdEl.textContent = '—';
  }
}

function formatContextSize(n) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  const num = Number(n);
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (num >= 1000) return (num / 1000).toFixed(0) + 'k';
  return String(num);
}

function updateStatusLine() {
  if (!statusLine) return;
  (async () => {
    try {
      const p = await window.gtd.getPrefs();
      const model = p.model || 'Default';
      const context = formatContextSize(p.contextSize);
      const session = (p.sessionId || '').slice(0, 8) || '—';
      statusLine.textContent = 'Model: ' + model + ' · Context: ' + context + ' · Session: ' + session;
    } catch {
      statusLine.textContent = 'Model: — · Context: — · Session: —';
    }
  })();
}

async function loadTasks() {
  try {
    const cwd = await window.gtd.getCwd();
    const result = await window.gtd.listTasks(cwd);
    if (result.error) {
      taskListEl.innerHTML = '<span class="task-item">No tasks or gtd not in PATH.</span>';
      return;
    }
    let tasks = result.tasks || [];
    if (window.gtd.getArchivedSessions) {
      const archived = await window.gtd.getArchivedSessions();
      if (archived.length) tasks = tasks.filter((t) => !archived.includes(t.id || t.taskId));
    }
    if (tasks.length === 0) {
      taskListEl.innerHTML = '<span class="task-item">No tasks yet.</span>';
      return;
    }
    const attr = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const tid = (t) => (t.id || t.taskId || '');
    taskListEl.innerHTML = tasks.slice(0, 15).map((t) => {
      const statusClass = t.status === 'completed' ? 'done' : t.status === 'failed' ? 'fail' : '';
      const id = tid(t);
      const desc = (t.description || '').slice(0, 50) + ((t.description || '').length > 50 ? '…' : '');
      return `<div class="task-item" data-task-id="${attr(id)}" data-description="${attr(t.description || '')}" role="button" tabindex="0"><span class="id">${escapeHtml(id.slice(0, 8))}</span><span class="status ${statusClass}">${escapeHtml(t.status || '')}</span> ${escapeHtml(desc)}<button type="button" class="fork-btn" data-task-id="${attr(id)}" data-description="${attr(t.description || '')}">Fork</button></div>`;
    }).join('');
    taskListEl.querySelectorAll('.task-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('fork-btn')) return;
        const id = el.getAttribute('data-task-id');
        const desc = el.getAttribute('data-description') || '';
        loadTaskTranscript(id, desc);
      });
    });
    taskListEl.querySelectorAll('.fork-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const desc = btn.getAttribute('data-description') || '';
        if (desc) taskInput.value = desc;
        taskInput.focus();
      });
    });
  } catch (e) {
    taskListEl.innerHTML = '<span class="task-item">Failed to load tasks.</span>';
  }
}

async function loadTaskTranscript(taskId, description) {
  if (!window.gtd.getTaskTranscript) return;
  try {
    const data = await window.gtd.getTaskTranscript(taskId);
    if (data && data.transcript) setOutput(data.transcript, false);
    else setOutput(description ? 'Task: ' + description + '\n\n(No transcript saved for this task.)' : '(No transcript)', false);
    if (description) taskInput.placeholder = 'Follow-up for: ' + description.slice(0, 30) + '…';
  } catch {
    setOutput('(Could not load transcript)', false);
  }
}

function switchPane(name) {
  document.querySelectorAll('.sidebar-nav .nav-link').forEach((el) => el.classList.remove('active'));
  const activeNav = document.querySelector('.sidebar-nav [data-pane="' + name + '"]');
  if (activeNav) activeNav.classList.add('active');
  document.querySelectorAll('.pane').forEach((p) => {
    p.hidden = p.id !== 'pane' + name.charAt(0).toUpperCase() + name.slice(1);
  });
}

// Sidebar resize
let resizing = false;
sidebarResize.addEventListener('mousedown', () => { resizing = true; });
window.addEventListener('mouseup', () => { resizing = false; });
window.addEventListener('mousemove', async (e) => {
  if (!resizing) return;
  const w = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, e.clientX));
  document.documentElement.style.setProperty('--sidebar-width', w + 'px');
  await window.gtd.setPrefs({ sidebarWidth: w });
});

sidebarToggle.addEventListener('click', async () => {
  const p = await loadPrefs();
  const next = !p.sidebarCollapsed;
  await window.gtd.setPrefs({ sidebarCollapsed: next });
  sidebar.classList.toggle('collapsed', next);
  sidebarToggle.setAttribute('aria-label', next ? 'Expand sidebar' : 'Collapse sidebar');
});

document.querySelectorAll('.sidebar-nav [data-pane]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    switchPane(el.getAttribute('data-pane'));
  });
});

themeSelect.addEventListener('change', async () => {
  const theme = themeSelect.value;
  await window.gtd.setPrefs({ theme });
  document.documentElement.removeAttribute('data-theme');
  if (theme !== 'system') document.documentElement.setAttribute('data-theme', theme);
});

fontSizeRange.addEventListener('input', async () => {
  const v = parseInt(fontSizeRange.value, 10);
  fontSizeValue.textContent = v;
  document.documentElement.style.setProperty('--font-size', v + 'px');
  await window.gtd.setPrefs({ fontSize: v });
});

copyTranscriptBtn.addEventListener('click', () => {
  const text = outputEl.innerText || outputEl.textContent || '';
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    copyTranscriptBtn.textContent = 'Copied';
    setTimeout(() => { copyTranscriptBtn.textContent = 'Copy'; }, 1500);
  });
});

// Export transcript (71): Markdown or JSON
function doExportTranscript(format) {
  const text = outputEl.innerText || outputEl.textContent || '';
  if (!text || !window.gtd.exportTranscriptToFile) return;
  window.gtd.exportTranscriptToFile(text, format).then((ok) => {
    if (ok) setOutput('Transcript exported to file.', false);
  });
}
if (exportTranscriptBtn) exportTranscriptBtn.addEventListener('click', () => doExportTranscript('markdown'));
if (document.getElementById('exportTranscriptJsonBtn')) {
  document.getElementById('exportTranscriptJsonBtn').addEventListener('click', () => doExportTranscript('json'));
}

// Share session (72): copy as markdown for handoff
if (shareTranscriptBtn) {
  shareTranscriptBtn.addEventListener('click', () => {
    const text = outputEl.innerText || outputEl.textContent || '';
    if (!text) return;
    const markdown = '# Skate session\n\n' + text;
    navigator.clipboard.writeText(markdown).then(() => {
      shareTranscriptBtn.textContent = 'Copied';
      setTimeout(() => { shareTranscriptBtn.textContent = 'Share'; }, 1500);
    });
  });
}

// Copy run command (77): one-liner for terminal
if (copyCommandBtn) {
  copyCommandBtn.addEventListener('click', async () => {
    const desc = lastRunDescription || (taskInput && taskInput.value.trim()) || '(task)';
    const oneLiner = 'gtd task "' + desc.replace(/"/g, '\\"') + '"';
    await navigator.clipboard.writeText(oneLiner);
    copyCommandBtn.textContent = 'Copied';
    setTimeout(() => { copyCommandBtn.textContent = 'Copy command'; }, 1500);
  });
}

let lastRunDescription = '';
let offChunk = null;
let offDone = null;

function isBlockedOutput(stdout, stderr) {
  const out = (stdout || '') + (stderr || '');
  return /blocked|approval\s+required|awaiting\s+approval/i.test(out);
}

runBtn.addEventListener('click', async () => {
  const desc = buildDescription();
  if (!desc.replace(/Attachments:.*/s, '').trim()) return;
  lastRunDescription = desc;
  taskInput.placeholder = 'Describe your task… (Cmd+Enter to run)';
  const ephemeral = ephemeralCheck && ephemeralCheck.checked;
  if (!ephemeral && draftHistory.indexOf(desc) === -1) {
    draftHistory.unshift(desc);
    if (draftHistory.length > DRAFT_HISTORY_MAX) draftHistory.pop();
  }
  draftIndex = -1;
  setRunning(true, desc.slice(0, 60) + (desc.length > 60 ? '…' : ''));
  if (window.gtd.setWindowTitle) await window.gtd.setWindowTitle(desc.slice(0, 50));
  setOutput('Running: ' + desc + '\n\n');
  if (window.gtd.onTaskChunk) {
    offChunk = window.gtd.onTaskChunk(({ stream, data }) => { appendOutputText(data); });
  }
  if (window.gtd.onTaskDone) {
    offDone = window.gtd.onTaskDone(() => {});
  }
  try {
    const cwd = await window.gtd.getCwd();
    const result = await window.gtd.runTask(desc, cwd);
    if (offChunk) { offChunk(); offChunk = null; }
    if (offDone) { offDone(); offDone = null; }
    const out = (result.stdout || '') + (result.stderr ? '\n' + result.stderr : '');
    const isError = result.code !== 0;
    const blocked = isBlockedOutput(result.stdout, result.stderr);
    setOutput(out.trim() || (isError ? 'Exit ' + result.code : 'Done.'), isError && !blocked);
    let taskId = parseTaskIdFromOutput(result.stdout) || parseTaskIdFromOutput(result.stderr);
    if (!taskId) {
      const list = await window.gtd.listTasks(await window.gtd.getCwd());
      if (list.tasks && list.tasks.length) taskId = list.tasks[0].id || list.tasks[0].taskId;
    }
    const runSummary = { description: desc, code: result.code, taskId, blocked, stdout: result.stdout, stderr: result.stderr };
    if (!ephemeral && window.gtd.setLastRun) await window.gtd.setLastRun(runSummary);
    if (!ephemeral && window.gtd.setLastRunByWorkspace && cwd) await window.gtd.setLastRunByWorkspace(cwd, runSummary);
    if (!ephemeral && taskId && window.gtd.setTaskTranscript) await window.gtd.setTaskTranscript(taskId, { description: desc, transcript: (result.stdout || '') + (result.stderr ? '\n' + result.stderr : '') });
    if (blocked && blockedApproval) {
      blockedApproval.hidden = false;
      failureActionsEl.hidden = true;
    } else if (result.code === 0) {
      completionSummaryEl.hidden = false;
      completionSummaryEl.innerHTML = formatCompletionSummary(taskId, result.stdout, cwd);
      const previewBtn = completionSummaryEl.querySelector('.preview-file-btn');
      if (previewBtn && window.gtd.openQuickLook) {
        previewBtn.addEventListener('click', () => { const p = previewBtn.getAttribute('data-path'); if (p) window.gtd.openQuickLook(p); });
      }
      if (blockedApproval) blockedApproval.hidden = true;
      if (!(keepDraftCheck && keepDraftCheck.checked)) {
        taskInput.value = '';
        attachmentPaths = [];
        renderAttachments();
        updateComposerMeta();
      }
    } else {
      failureActionsEl.hidden = false;
      if (blockedApproval) blockedApproval.hidden = true;
    }
    if (window.gtd.showNotification) {
      if (result.code === 0) window.gtd.showNotification('Task completed', desc.slice(0, 50) + (desc.length > 50 ? '…' : ''));
      else window.gtd.showNotification('Task failed', desc.slice(0, 50) + (desc.length > 50 ? '…' : ''));
    }
    await loadTasks();
    updateContinueLastVisibility();
  } catch (e) {
    if (offChunk) { offChunk(); offChunk = null; }
    if (offDone) { offDone(); offDone = null; }
    setOutput('Error: ' + (e.message || e), true);
    failureActionsEl.hidden = false;
    if (blockedApproval) blockedApproval.hidden = true;
    if (window.gtd.showNotification) window.gtd.showNotification('Task failed', e.message || 'Error');
    const errSummary = { description: desc, error: e.message };
    if (!ephemeral && window.gtd.setLastRun) await window.gtd.setLastRun(errSummary);
    try {
      const cwd = await window.gtd.getCwd();
      if (!ephemeral && window.gtd.setLastRunByWorkspace && cwd) await window.gtd.setLastRunByWorkspace(cwd, errSummary);
    } catch (_) {}
    updateContinueLastVisibility();
  } finally {
    setRunning(false);
    if (window.gtd.setWindowTitle) await window.gtd.setWindowTitle('Skate');
    updateStatusLine();
  }
});

function parseTaskIdFromOutput(text) {
  if (!text) return null;
  const m = text.match(/(?:task[-\s]?id|id):\s*([a-f0-9-]+)/i) || text.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return m ? m[1].trim() : null;
}

function formatCompletionSummary(taskId, stdout, cwdForPreview) {
  let html = '';
  if (taskId) html += '<span class="task-id">Task ID: ' + escapeHtml(taskId) + '</span><br>';
  const written = (stdout || '').match(/(?:written|wrote|saved)[:\s]*([^\n]+)/gi);
  const writtenTrimmed = written && written.length ? written[written.length - 1].replace(/^(?:written|wrote|saved)[:\s]*/i, '').trim() : '';
  if (writtenTrimmed) {
    html += 'Written: ' + escapeHtml(writtenTrimmed);
    if (cwdForPreview && window.gtd.openQuickLook) {
      const pathForPreview = writtenTrimmed.startsWith('/') ? writtenTrimmed : (cwdForPreview + '/' + writtenTrimmed.replace(/^\s+|\s+$/g, ''));
      html += ' <button type="button" class="link-btn preview-file-btn" data-path="' + escapeHtml(pathForPreview) + '" aria-label="Preview in Quick Look">Preview</button>';
    }
  }
  return html || 'Task completed.';
}

cancelBtn.addEventListener('click', async () => {
  if (window.gtd.cancelTask && (await window.gtd.cancelTask())) {
    appendOutputText('\n[Cancelled]\n');
  }
});

retryBtn.addEventListener('click', () => {
  failureActionsEl.hidden = true;
  if (lastRunDescription) {
    taskInput.value = lastRunDescription;
    runBtn.click();
  }
});

approveBtn.addEventListener('click', () => {
  failureActionsEl.hidden = true;
});

if (approveBlockedBtn) {
  approveBlockedBtn.addEventListener('click', () => {
    if (blockedApproval) blockedApproval.hidden = true;
    if (lastRunDescription) runBtn.click();
  });
}
if (rejectBlockedBtn) {
  rejectBlockedBtn.addEventListener('click', () => {
    if (blockedApproval) blockedApproval.hidden = true;
  });
}

async function updateContinueLastVisibility() {
  if (!window.gtd.getLastRun || !continueLastWrap) return;
  try {
    const last = await window.gtd.getLastRun();
    continueLastWrap.hidden = !(last && last.description);
  } catch {
    continueLastWrap.hidden = true;
  }
}

continueLastBtn.addEventListener('click', async () => {
  try {
    const last = await window.gtd.getLastRun();
    if (last && last.description) {
      taskInput.value = last.description;
      taskInput.focus();
    }
  } catch (_) {}
});

taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    taskInput.blur();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    runBtn.click();
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const ta = taskInput;
    const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    if (atStart && draftHistory.length) {
      e.preventDefault();
      if (e.key === 'ArrowUp') {
        if (draftIndex < draftHistory.length - 1) draftIndex += 1;
        ta.value = draftHistory[draftIndex] || '';
      } else {
        if (draftIndex > 0) draftIndex -= 1;
        else if (draftIndex === 0) draftIndex = -1;
        ta.value = draftIndex >= 0 ? draftHistory[draftIndex] : '';
      }
    }
  }
});

document.getElementById('changeFolderBtn').addEventListener('click', async () => {
  const path = await window.gtd.showFolderDialog();
  if (!path) return;
  await window.gtd.setWorkspace(path);
  await loadCwd();
  await loadTasks();
});

// Deep link (82): skate://task/<id> opens task transcript
if (window.gtd.onDeepLinkTask) {
  window.gtd.onDeepLinkTask(async (taskId) => {
    if (!taskId || !window.gtd.getTaskTranscript) return;
    try {
      const data = await window.gtd.getTaskTranscript(taskId);
      if (data && data.transcript) {
        setOutput(data.transcript, false);
        if (data.description) lastRunDescription = data.description;
      }
      switchPane('main');
    } catch (_) {}
  });
}
// Drag-drop folder on dock (84): refresh cwd when workspace set from dock
if (window.gtd.onWorkspaceDropped) {
  window.gtd.onWorkspaceDropped(async () => {
    await loadCwd();
    await loadTasks();
  });
}

async function loadTemplates() {
  if (!window.gtd.getTemplates) return;
  try {
    templates = await window.gtd.getTemplates();
    if (!Array.isArray(templates)) templates = [];
    if (templateSelect) {
      const sel = templateSelect.value;
      templateSelect.innerHTML = '<option value="">No template</option>' + templates.map((t) => '<option value="' + escapeHtml(t.id || t.name || '') + '">' + escapeHtml(t.name || t.id || '') + '</option>').join('');
          if (sel) templateSelect.value = sel;
        }
  } catch (_) {}
}

if (templateSelect) {
  templateSelect.addEventListener('change', () => {
    const id = templateSelect.value;
    const t = templates.find((x) => (x.id || x.name) === id);
    if (t && t.body) {
      taskInput.value = t.body;
      taskInput.focus();
    }
    templateSelect.value = '';
  });
}

if (attachBtn && window.gtd.showFileDialog) {
  attachBtn.addEventListener('click', async () => {
    const paths = await window.gtd.showFileDialog();
    if (paths && paths.length) {
      attachmentPaths = attachmentPaths.concat(paths);
      renderAttachments();
    }
  });
}

function insertAtCursor(text) {
  const ta = taskInput;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  ta.value = before + text + after;
  ta.selectionStart = ta.selectionEnd = start + text.length;
  ta.focus();
}

if (attachPathBtn && window.gtd.showFileDialog) {
  attachPathBtn.addEventListener('click', async () => {
    const paths = await window.gtd.showFileDialog();
    if (paths && paths.length) insertAtCursor('@path:' + paths[0] + ' ');
  });
}

// Paste image/file: add to attachments and insert inline marker (items 42, 51)
if (taskInput && window.gtd.writeTempFile) {
  taskInput.addEventListener('paste', async (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    const names = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const m = (reader.result || '').match(/^data:[^;]+;base64,(.+)$/);
          resolve(m ? m[1] : null);
        };
        reader.readAsDataURL(file);
      });
      if (base64) {
        const p = await window.gtd.writeTempFile(file.name || 'paste', base64);
        if (p) {
          attachmentPaths.push(p);
          names.push(file.name || 'image');
        }
      }
    }
    if (names.length) {
      renderAttachments();
      const inline = names.map((n) => '[image: ' + n + ']').join(' ');
      insertAtCursor(inline + ' ');
    }
  });
}

if (qualityProfileSelect) {
  qualityProfileSelect.addEventListener('change', async () => {
    await window.gtd.setPrefs({ qualityProfile: qualityProfileSelect.value || undefined });
  });
}
if (approvalPolicySelect) {
  approvalPolicySelect.addEventListener('change', async () => {
    await window.gtd.setPrefs({ approvalPolicy: approvalPolicySelect.value || undefined });
  });
}

// Cmd+N / Ctrl+N: focus composer (item 29)
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault();
    taskInput.focus();
  }
});

// Cmd+K: command palette (55, 76, 77, 78)
const COMMAND_PALETTE_ACTIONS = [
  { id: 'run', label: 'Run task', fn: () => { runBtn.focus(); runBtn.click(); } },
  { id: 'new', label: 'New task', fn: () => { taskInput.value = ''; taskInput.focus(); } },
  { id: 'settings', label: 'Open Settings', fn: () => { switchPane('settings'); } },
  { id: 'tasks', label: 'Open Tasks', fn: () => { switchPane('tasks'); } },
  { id: 'continue', label: 'Continue last task', fn: () => { continueLastBtn.click(); } },
  { id: 'folder', label: 'Change project folder', fn: () => { document.getElementById('changeFolderBtn').click(); } },
  { id: 'copy', label: 'Copy transcript', fn: () => { copyTranscriptBtn.click(); } },
  { id: 'terminal', label: 'Open in Terminal', fn: async () => { const cwd = await window.gtd.getCwd(); if (cwd && window.gtd.openInTerminal) await window.gtd.openInTerminal(cwd); } },
  { id: 'copyCmd', label: 'Copy run command', fn: async () => { const cwd = await window.gtd.getCwd(); const desc = lastRunDescription || taskInput.value.trim() || '(task)'; const oneLiner = 'gtd task "' + desc.replace(/"/g, '\\"') + '"'; await navigator.clipboard.writeText(oneLiner); } },
  { id: 'handoff', label: 'Import handoff bundle', fn: async () => { if (window.gtd.handoffImportFile) { const r = await window.gtd.handoffImportFile(); if (r.ok) { loadTasks(); setOutput('Handoff imported. ' + (r.stdout || ''), false); } else setOutput((r.stderr || r.error || 'Import failed') + '', true); } } },
];
let commandPaletteSelected = 0;

function openCommandPalette() {
  if (!commandPalette || !commandPaletteInput || !commandPaletteList) return;
  commandPalette.hidden = false;
  commandPaletteInput.value = '';
  commandPaletteSelected = 0;
  renderCommandPaletteList();
  commandPaletteInput.focus();
}

function closeCommandPalette() {
  if (commandPalette) commandPalette.hidden = true;
}

function getFilteredCommands() {
  const q = (commandPaletteInput && commandPaletteInput.value) ? commandPaletteInput.value.trim().toLowerCase() : '';
  return q ? COMMAND_PALETTE_ACTIONS.filter((c) => c.label.toLowerCase().includes(q)) : COMMAND_PALETTE_ACTIONS;
}

function renderCommandPaletteList() {
  if (!commandPaletteList) return;
  const filtered = getFilteredCommands();
  commandPaletteSelected = Math.max(0, Math.min(commandPaletteSelected, filtered.length - 1));
  commandPaletteList.innerHTML = filtered.map((c, i) => '<li data-index="' + i + '" class="' + (i === commandPaletteSelected ? 'selected' : '') + '">' + escapeHtml(c.label) + '</li>').join('');
  commandPaletteList.querySelectorAll('li').forEach((li, i) => {
    li.addEventListener('click', () => { filtered[i].fn(); closeCommandPalette(); });
  });
}

if (commandPalette && commandPaletteInput && commandPaletteList) {
  commandPaletteInput.addEventListener('input', renderCommandPaletteList);
  commandPaletteInput.addEventListener('keydown', (e) => {
    const filtered = getFilteredCommands();
    const list = commandPaletteList.querySelectorAll('li');
    if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); commandPaletteSelected = Math.min(commandPaletteSelected + 1, list.length - 1); renderCommandPaletteList(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); commandPaletteSelected = Math.max(commandPaletteSelected - 1, 0); renderCommandPaletteList(); return; }
    if (e.key === 'Enter' && filtered[commandPaletteSelected]) { e.preventDefault(); filtered[commandPaletteSelected].fn(); closeCommandPalette(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openCommandPalette(); }
  });
}

// Model, profile, feature flags (56, 57, 58, 60)
if (modelSelect) modelSelect.addEventListener('change', async () => { await window.gtd.setPrefs({ model: modelSelect.value || undefined }); });
if (profileSelect) profileSelect.addEventListener('change', async () => { await window.gtd.setPrefs({ profile: profileSelect.value || undefined }); });
if (contextSizeSelect) contextSizeSelect.addEventListener('change', async () => {
  const v = contextSizeSelect.value;
  await window.gtd.setPrefs({ contextSize: v ? Number(v) : undefined });
  updateStatusLine();
});
if (keepDraftCheck) keepDraftCheck.addEventListener('change', async () => { await window.gtd.setPrefs({ keepDraft: !!keepDraftCheck.checked }); });
if (flagStreaming) flagStreaming.addEventListener('change', async () => {
  const p = await loadPrefs();
  const flags = p.featureFlags || {};
  await window.gtd.setPrefs({ featureFlags: { ...flags, streaming: !!flagStreaming.checked } });
});
if (flagMcp) flagMcp.addEventListener('change', async () => {
  const p = await loadPrefs();
  const flags = p.featureFlags || {};
  await window.gtd.setPrefs({ featureFlags: { ...flags, mcp: !!flagMcp.checked } });
});

// Open in Terminal (76), Git (79)
if (openInTerminalBtn && window.gtd.openInTerminal) {
  openInTerminalBtn.addEventListener('click', async () => {
    const cwd = await window.gtd.getCwd();
    if (cwd) await window.gtd.openInTerminal(cwd);
  });
}
if (openDiffBtn && window.gtd.openDiff) {
  openDiffBtn.addEventListener('click', async () => {
    const cwd = await window.gtd.getCwd();
    if (!cwd) return;
    const r = await window.gtd.openDiff(cwd);
    if (r && r.ok && r.diff != null) setOutput(r.diff, false);
    else setOutput((r && r.error) || 'Could not get git diff.', true);
  });
}

// Settings pane: config, MCP (61), rules (62), debug (63), NO_COLOR (64), status (65), git (79)
async function loadSettingsPane() {
  updateStatusLine();
  if (configPathDisplay && window.gtd.getConfigPath) configPathDisplay.textContent = await window.gtd.getConfigPath() || '—';
  if (configJson && window.gtd.getConfigJson) configJson.value = await window.gtd.getConfigJson() || '';
  if (gitRow && gitBranchDisplay && window.gtd.getGitBranch) {
    const cwd = await window.gtd.getCwd();
    const branch = cwd ? await window.gtd.getGitBranch(cwd) : null;
    if (branch) { gitRow.hidden = false; gitBranchDisplay.textContent = branch; } else { gitRow.hidden = true; }
  }
  if (rulesPathDisplay && window.gtd.getRulesPath) {
    const cwd = await window.gtd.getCwd();
    const rp = await window.gtd.getRulesPath(cwd);
    rulesPathDisplay.textContent = rp || '—';
  }
  if (mcpServerList && window.gtd.getMcpServers) {
    const servers = await window.gtd.getMcpServers();
    mcpServerList.innerHTML = (servers || []).map((s, i) => {
      const name = escapeHtml(s.name || s.url || s.id || 'Server');
      const en = s.enabled !== false;
      return '<li class="mcp-item"><label class="mcp-enable"><input type="checkbox" ' + (en ? 'checked' : '') + ' data-index="' + i + '" /> ' + name + '</label><button type="button" class="mcp-remove" data-index="' + i + '" aria-label="Remove">×</button></li>';
    }).join('');
    mcpServerList.querySelectorAll('.mcp-enable input').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const list = await window.gtd.getMcpServers();
        const idx = parseInt(cb.getAttribute('data-index'), 10);
        if (list[idx]) { list[idx] = { ...list[idx], enabled: cb.checked }; await window.gtd.setMcpServers(list); }
      });
    });
    mcpServerList.querySelectorAll('.mcp-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const list = (await window.gtd.getMcpServers()).filter((_, i) => i !== parseInt(btn.getAttribute('data-index'), 10));
        await window.gtd.setMcpServers(list);
        loadSettingsPane();
      });
    });
  }
  if (window.gtd.getLoginStatus) {
    const st = await window.gtd.getLoginStatus();
    const loginSection = document.getElementById('loginSection');
    const logoutSection = document.getElementById('logoutSection');
    const apiKeyInput = document.getElementById('apiKeyInput');
    if (loginSection) loginSection.style.display = st.loggedIn ? 'none' : '';
    if (logoutSection) logoutSection.style.display = st.loggedIn ? '' : 'none';
    if (apiKeyInput) apiKeyInput.value = '';
  }
}
if (openConfigBtn && window.gtd.openConfigFolder) openConfigBtn.addEventListener('click', () => window.gtd.openConfigFolder());
const saveConfigBtn = document.getElementById('saveConfigBtn');
if (saveConfigBtn && configJson && window.gtd.setConfigJson) saveConfigBtn.addEventListener('click', async () => { await window.gtd.setConfigJson(configJson.value); });

if (noColorCheck) noColorCheck.addEventListener('change', async () => { await window.gtd.setPrefs({ noColor: !!noColorCheck.checked }); });

if (reloadRulesBtn && rulesPathDisplay && window.gtd.getRulesPath) reloadRulesBtn.addEventListener('click', async () => {
  const cwd = await window.gtd.getCwd();
  rulesPathDisplay.textContent = await window.gtd.getRulesPath(cwd) || '—';
});

if (showConfigLayersBtn && window.gtd.getConfigLayers) showConfigLayersBtn.addEventListener('click', async () => {
  const layers = await window.gtd.getConfigLayers();
  setOutput(JSON.stringify(layers, null, 2), false);
});
if (exportDiagnosticsBtn && window.gtd.exportDiagnosticsToFile) exportDiagnosticsBtn.addEventListener('click', async () => {
  const ok = await window.gtd.exportDiagnosticsToFile();
  setOutput(ok ? 'Diagnostics exported to file.' : 'Export cancelled or failed.', false);
});
const reportIssueBtn = document.getElementById('reportIssueBtn');
if (reportIssueBtn && window.gtd.openFeedbackUrl) reportIssueBtn.addEventListener('click', () => { window.gtd.openFeedbackUrl(); });

if (mcpAddBtn && mcpServerInput && window.gtd.getMcpServers && window.gtd.setMcpServers) {
  mcpAddBtn.addEventListener('click', async () => {
    const name = (mcpServerInput.value || '').trim();
    if (!name) return;
    const list = await window.gtd.getMcpServers();
    list.push({ id: name.replace(/\W/g, '_') + '_' + Date.now(), name, url: name, enabled: true });
    await window.gtd.setMcpServers(list);
    mcpServerInput.value = '';
    loadSettingsPane();
  });
}

// Login / Logout (87, 88)
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const validateKeyBtn = document.getElementById('validateKeyBtn');
const apiKeyInput = document.getElementById('apiKeyInput');
if (loginBtn && apiKeyInput && window.gtd.loginSaveKey) {
  loginBtn.addEventListener('click', async () => {
    const key = (apiKeyInput.value || '').trim();
    const r = await window.gtd.loginSaveKey(key);
    if (r && r.ok) { apiKeyInput.value = ''; loadSettingsPane(); }
    else setOutput((r && r.error) || 'Save failed', true);
  });
}
if (logoutBtn && window.gtd.logoutRemoveKey) {
  logoutBtn.addEventListener('click', async () => {
    await window.gtd.logoutRemoveKey();
    loadSettingsPane();
  });
}
if (validateKeyBtn && window.gtd.validateApiKey) {
  validateKeyBtn.addEventListener('click', async () => {
    const key = (apiKeyInput && apiKeyInput.value) ? apiKeyInput.value.trim() : null;
    const r = await window.gtd.validateApiKey(key);
    setOutput(r && r.ok ? 'Key valid.' : ((r && r.error) || 'Validation failed'), !(r && r.ok));
  });
}

// History pane (66–75): saved chats, filter (74), pagination (75), Open in folder (73)
const HISTORY_PAGE_SIZE = 20;
let historyDisplayLimit = HISTORY_PAGE_SIZE;
let historySessions = [];

async function loadHistoryPane() {
  if (!historyList || !window.gtd.getLastRunByWorkspace) return;
  historyDisplayLimit = HISTORY_PAGE_SIZE;
  try {
    const cwd = await window.gtd.getCwd();
    const byWorkspace = await window.gtd.getLastRunByWorkspace();
    const currentResult = await window.gtd.listTasks(cwd);
    const currentTasks = (currentResult.tasks || []).map((t) => ({ ...t, cwd, taskId: t.id || t.taskId }));
    const otherWorkspaces = Object.entries(byWorkspace || {})
      .filter(([w]) => w && w !== cwd)
      .map(([w, s]) => ({ cwd: w, description: s.description || '', taskId: s.taskId, status: s.code === 0 ? 'completed' : 'failed' }));
    historySessions = [...currentTasks, ...otherWorkspaces];
    await renderHistoryList();
  } catch {
    historySessions = [];
    if (historyList) historyList.innerHTML = '<span class="task-item">No saved chats.</span>';
    if (historyLoadMoreBtn) historyLoadMoreBtn.style.display = 'none';
  }
}

async function renderHistoryList() {
  if (!historyList) return;
  let list = historySessions;
  const statusFilter = historyStatusFilter && historyStatusFilter.value ? historyStatusFilter.value : '';
  if (statusFilter) list = list.filter((s) => (s.status || '').toLowerCase() === statusFilter);
  const q = (historySearchInput && historySearchInput.value) ? historySearchInput.value.trim().toLowerCase() : '';
  if (q) list = list.filter((s) => (s.description || '').toLowerCase().includes(q) || (s.taskId || s.id || '').toLowerCase().includes(q));
  let archived = [];
  if (window.gtd.getArchivedSessions) try { archived = await window.gtd.getArchivedSessions(); } catch (_) {}
  list = list.filter((s) => !archived.includes(s.taskId || s.id));
  const total = list.length;
  const visible = list.slice(0, historyDisplayLimit);
  if (visible.length === 0) {
    historyList.innerHTML = '<span class="task-item">No sessions match.</span>';
    if (historyLoadMoreBtn) historyLoadMoreBtn.style.display = 'none';
    return;
  }
  const attr = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  historyList.innerHTML = visible.map((s) => {
    const id = s.taskId || s.id || '';
    const desc = (s.description || '(No description)').slice(0, 45) + ((s.description || '').length > 45 ? '…' : '');
    const cwdShort = (s.cwd || '').split(/[/\\]/).pop() || '—';
    return '<div class="task-item history-item" data-task-id="' + attr(id) + '" data-description="' + attr(s.description || '') + '" data-cwd="' + attr(s.cwd || '') + '" role="button" tabindex="0">' +
      '<span class="id">' + escapeHtml(String(id).slice(0, 8)) + '</span> ' + escapeHtml(desc) + ' <span class="muted">(' + escapeHtml(cwdShort) + ')</span>' +
      (s.cwd && window.gtd.openFolder ? '<button type="button" class="open-folder-btn link-btn" data-cwd="' + attr(s.cwd) + '" aria-label="Open in folder">Open in folder</button>' : '') +
      '<button type="button" class="archive-btn" data-task-id="' + attr(id) + '" aria-label="Archive">Archive</button></div>';
  }).join('');
  historyList.querySelectorAll('.history-item').forEach((el) => {
    el.addEventListener('click', async (e) => {
      if (e.target.classList.contains('archive-btn') || e.target.classList.contains('open-folder-btn')) return;
      const id = el.getAttribute('data-task-id');
      const desc = el.getAttribute('data-description') || '';
      const cwd = el.getAttribute('data-cwd') || '';
      if (cwd && cwd !== (await window.gtd.getCwd())) await window.gtd.setWorkspace(cwd);
      loadTaskTranscript(id, desc);
      switchPane('tasks');
    });
  });
  historyList.querySelectorAll('.open-folder-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cwd = btn.getAttribute('data-cwd');
      if (cwd && window.gtd.openFolder) await window.gtd.openFolder(cwd);
    });
  });
  historyList.querySelectorAll('.archive-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-task-id');
      let a = [];
      if (window.gtd.getArchivedSessions) try { a = await window.gtd.getArchivedSessions(); } catch (_) {}
      if (!a.includes(id)) await window.gtd.setArchivedSessions([...a, id]);
      loadHistoryPane();
      loadTasks();
    });
  });
  if (historyLoadMoreBtn) {
    historyLoadMoreBtn.style.display = total > historyDisplayLimit ? 'inline' : 'none';
  }
}

if (historySearchInput) historySearchInput.addEventListener('input', () => renderHistoryList());
if (historySearchInput) historySearchInput.addEventListener('keyup', () => renderHistoryList());
if (historyStatusFilter) historyStatusFilter.addEventListener('change', () => renderHistoryList());
if (historyLoadMoreBtn) {
  historyLoadMoreBtn.addEventListener('click', () => {
    historyDisplayLimit += HISTORY_PAGE_SIZE;
    renderHistoryList();
  });
}
if (resumeAllBtn) resumeAllBtn.addEventListener('click', () => loadHistoryPane());

const origSwitchPane = switchPane;
switchPane = function(name) {
  origSwitchPane(name);
  if (name === 'settings') loadSettingsPane();
  if (name === 'history') loadHistoryPane();
};

(async () => {
  await applyPrefs();
  await loadCwd();
  await loadTasks();
  await loadTemplates();
  await updateContinueLastVisibility();
  renderAttachments();
  if (typeof updateComposerMeta === 'function') updateComposerMeta();
  updateStatusLine();
})();
