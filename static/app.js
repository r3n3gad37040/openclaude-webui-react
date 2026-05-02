/* OpenClaude Web UI — Production Frontend
 * Features: Command Palette, Theme Engine, Message Actions,
 *           Drag & Drop, Session Search, Token/Cost Tracking,
 *           Export, Shortcuts Overlay, Typing Indicators
 */

// ─── State ───────────────────────────────────────────────────────────────
let token = '';
let currentSessionId = null;
let currentProvider = '';
let currentModel = '';
let isStreaming = false;
let abortController = null;
let providersList = [];
let modelsCache = [];
let pendingAttachments = [];
let commandPaletteOpen = false;
let paletteSelectedIndex = 0;
let paletteItems = [];
let sessionTokenUsage = { inputs: 0, outputs: 0, cost: 0, messages: 0 };

// ─── DOM refs ────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let authScreen, app, authTokenInput, authBtn, authError;
let sessionList, chatMessages, messageInput, sendBtn, cancelBtn;
let providerSelect, modelSelect, refreshModelsBtn, newChatBtn;
let toast, menuToggle, sidebar, statusIndicator;
let commandPaletteBtn, palette, paletteInput, paletteResults;
let themeBtn, themePicker, themeList;
let shortcutsBtn, shortcutsOverlay, shortcutsClose;
let settingsBtn, settingsModal, settingsClose, saveKeysBtn;
let attachBtn, fileInput, attachmentPreview;
let statusBarModel, statusBarProvider, statusBarKey, statusBarSessions, statusBarRunner;
let statusIndicatorEl;
let dropZone, chatArea;

function initDomRefs() {
  authScreen = $('#auth-screen');
  app = $('#app');
  authTokenInput = $('#auth-token');
  authBtn = $('#auth-btn');
  authError = $('#auth-error');
  sessionList = $('#session-list');
  chatMessages = $('#chat-messages');
  messageInput = $('#message-input');
  sendBtn = $('#send-btn');
  cancelBtn = $('#cancel-btn');
  providerSelect = $('#provider-select');
  modelSelect = $('#model-select');
  refreshModelsBtn = $('#refresh-models-btn');
  newChatBtn = $('#new-chat-btn');
  toast = $('#toast');
  menuToggle = $('#menu-toggle');
  sidebar = $('#sidebar');
  statusIndicator = $('#status-indicator');
  statusIndicatorEl = $('#status-indicator');
  commandPaletteBtn = $('#command-palette-btn');
  palette = $('#command-palette');
  paletteInput = $('#palette-input');
  paletteResults = $('#palette-results');
  themeBtn = $('#theme-btn');
  themePicker = $('#theme-picker');
  shortcutBtn = $('#shortcuts-btn');
  shortcutsOverlay = $('#shortcuts-overlay');
  shortcutsClose = $('#shortcuts-close');
  settingsBtn = $('#settings-btn');
  settingsModal = $('#settings-modal');
  settingsClose = $('#settings-close');
  saveKeysBtn = $('#save-keys-btn');
  attachBtn = $('#attach-btn');
  fileInput = $('#file-input');
  attachmentPreview = $('#attachment-preview');
  statusBarModel = $('#status-bar-model');
  statusBarProvider = $('#status-bar-provider');
  statusBarKey = $('#status-bar-key-health');
  statusBarSessions = $('#status-bar-sessions');
  statusBarRunner = $('#status-bar-runner');
  dropZone = $('#drop-zone');
  chatArea = $('#chat-area');
}

// ─── Utils ───────────────────────────────────────────────────────────────
function showToast(msg, duration = 3000) {
  toast.textContent = msg;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), duration);
}

function setStatus(msg, mode = '') {
  const el = statusIndicator || $('#status-indicator');
  if (!el) return;
  el.textContent = mode ? `● ${msg}` : msg;
  el.classList.toggle('thinking', mode === 'thinking');
  if (statusBarRunner) {
    statusBarRunner.textContent = mode === 'thinking' ? '● Streaming' : '● Idle';
  }
}

function api(method, path, body) {
  return fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Message Formatting with Syntax Highlighting ─────────────────────────
function formatMessage(content) {
  let html = escapeHtml(content);
  // Code blocks
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    const langClass = lang ? `language-${escapeHtml(lang)}` : '';
    return `<pre><code class="${langClass}">${escapeHtml(code.trim())}</code></pre>`;
  });
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold/Italic
  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    return `<img src="${src}" alt="${escapeHtml(alt || 'Image')}" class="generated-image" />`;
  });
  html = html.replace(/(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/g, (match) => {
    return `<img src="${match}" alt="Generated image" class="generated-image" />`;
  });
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
  });
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

// ─── Auth ───────────────────────────────────────────────────────────────
async function doAuth() {
  const t = authTokenInput.value.trim();
  if (!t) return;
  const res = await fetch('/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: t }),
  });
  const data = await res.json();
  if (data.ok) {
    token = t;
    authScreen.style.display = 'none';
    app.style.display = '';
    initApp();
  } else {
    const errEl = $('#auth-error');
    if (errEl) errEl.textContent = 'Invalid token';
  }
}

async function tryAutoAuth() {
  const res = await fetch('/api/sessions', { method: 'GET' });
  if (res.ok) {
    authScreen.style.display = 'none';
    app.style.display = '';
    initApp();
    return true;
  }
  return false;
}

// ─── Providers & Models ─────────────────────────────────────────────────
async function loadProviders() {
  const res = await api('GET', '/api/providers');
  if (!res.ok) return;
  const data = await res.json();
  providersList = data.providers || [];
}

async function loadModels(provider) {
  if (!provider) return [];
  const res = await api('GET', `/api/models?provider=${encodeURIComponent(provider)}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.models || [];
}

function populateModelSelect(models, selectedModel = '') {
  modelSelect.innerHTML = '';
  if (!models.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = 'No models available';
    opt.disabled = true; opt.selected = true;
    modelSelect.appendChild(opt);
    return;
  }
  models.forEach(m => {
    const opt = document.createElement('option');
    // For OpenRouter (and similar), the model field from /api/models is already
    // the correct value (e.g. "qwen/qwen3.6-plus").  If missing, reconstruct it
    // by stripping ONLY the provider prefix, not additional path segments.
    const prefix = m.provider + '/';
    const bare = m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id.split('/').pop();
    opt.value = m.model || bare;
    opt.textContent = m.alias || m.id;
    if (m.model === selectedModel || bare === selectedModel) opt.selected = true;
    modelSelect.appendChild(opt);
  });
}

async function refreshModelsForProvider(provider, withDiscovery = false) {
  if (!provider) return;
  refreshModelsBtn.disabled = true;
  refreshModelsBtn.textContent = '↻';
  setStatus('Loading...', 'thinking');
  try {
    let models = await loadModels(provider);
    // Always verify models actually match the requested provider
    // (cached models could be from a previous provider)
    if (!models.length || (models[0].provider !== provider)) {
      withDiscovery = true;
    }
    if (!models.length || withDiscovery) {
      try {
        const res = await api('POST', '/api/discover-models', { provider });
        if (res.ok) {
          const data = await res.json();
          // m.model field is now always present in the backend response
          // (e.g. "qwen/qwen3.6-plus" for OpenRouter nested IDs)
          models = (data.models || []).map(m => {
            const bare = m.model || (m.id.includes('/') ? m.id.split('/').slice(1).join('/') : m.id);
            return { id: m.id, alias: m.alias, provider, model: bare };
          });
          showToast(`${data.count} models discovered from ${provider}`);
        }
      } catch (e) { /* discovery failed */ }
    }
    populateModelSelect(models, currentModel);
    modelsCache = models;
  } catch (e) {
    showToast('Failed to load models');
  } finally {
    refreshModelsBtn.disabled = false;
    refreshModelsBtn.textContent = '↻';
    setStatus('Ready');
  }
}

async function handleProviderChange() {
  if (!providerSelect.value) return;
  currentProvider = providerSelect.value;
  await refreshModelsForProvider(currentProvider, false);
  // Also persist the provider change on the backend so the active model
  // actually switches (not just the UI dropdown).
  // If the current model dropdown has a valid selection, switch to it immediately.
  if (modelSelect?.value) {
    try {
      const res2 = await api('POST', '/api/switch-model', {
        provider: currentProvider,
        model: modelSelect.value,
      });
      if (res2.ok) {
        const sw = await res2.json();
        currentModel = sw.model || modelSelect.value;
        showToast(`Switched to ${currentProvider}/${currentModel}`);
      }
    } catch (_) { /* switch best-effort; UI already updated */ }
  }
}

// ─── Sessions ────────────────────────────────────────────────────────────
async function loadSessions(filter = '') {
  let url = '/api/sessions';
  if (filter) url = `/api/sessions/search?q=${encodeURIComponent(filter)}`;
  const res = await api('GET', url);
  if (!res.ok) return;
  const data = await res.json();
  renderSessions(data.sessions || []);
}

function renderSessions(sessions) {
  sessionList.innerHTML = '';
  if (!sessions.length) {
    sessionList.innerHTML = '<div class="sidebar-empty">No chats found</div>';
    return;
  }
  sessions.forEach(s => {
    const div = document.createElement('div');
    div.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
    const shortModel = (s.model_id || '').split('/').pop() || '';
    div.innerHTML = `
      <span class="session-model-tag">${escapeHtml(shortModel)}</span>
      <span class="session-title">${escapeHtml(s.title || 'Untitled')}</span>
      <button class="session-delete" data-id="${s.id}">×</button>
    `;
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('session-delete')) {
        e.stopPropagation();
        deleteSession(e.target.dataset.id);
      } else {
        selectSession(s.id);
      }
    });
    sessionList.appendChild(div);
  });
  if (statusBarSessions) statusBarSessions.textContent = `Sessions: ${sessions.length}`;
}

async function selectSession(id) {
  currentSessionId = id;
  localStorage.setItem('currentSessionId', id);
  const res = await api('GET', `/api/sessions/${id}`);
  if (!res.ok) return;
  const data = await res.json();
  // Backend returns messages at top-level, not nested in session
  const msgs = data.messages || [];
  renderMessages(msgs);
  // Restore the session's model_id into the UI selectors so the dropdowns
  // reflect what was actually used for this chat
  if (data.model_id) {
    const [prov, ...rest] = data.model_id.split('/');
    const modelName = rest.join('/');  // handles "qwen/qwen3.6-plus" from OpenRouter
    if (providerSelect) {
      // Try exact match first, then fall back to first segment
      let setProv = false;
      for (const opt of providerSelect.options) {
        if (opt.value === prov) { providerSelect.value = prov; setProv = true; break; }
      }
      if (!setProv && prov) {
        // Provider might have stored full first-segment (e.g. "openrouter" for "openrouter/qwen/qwen3.6-plus")
        // Check if any option value is a prefix of the model_id
        for (const opt of providerSelect.options) {
          if (data.model_id.startsWith(opt.value + '/')) { providerSelect.value = opt.value; break; }
        }
      }
    }
    currentProvider = providerSelect?.value || prov;
    await refreshModelsForProvider(currentProvider, false);
    if (modelSelect) {
      for (const opt of modelSelect.options) {
        if (opt.value === modelName) { modelSelect.value = modelName; break; }
      }
    }
    currentModel = modelSelect?.value || modelName;
  }
  await loadSessions();
}

async function createNewSession() {
  const model = modelSelect.value;
  const provider = providerSelect.value;
  if (!provider || !model) { showToast('Select a provider and model first'); return; }
  const res = await api('POST', '/api/sessions', { model_id: `${provider}/${model}` });
  if (!res.ok) return;
  const data = await res.json();
  currentSessionId = data.id;
  localStorage.setItem('currentSessionId', data.id);
  renderWelcome();
  await loadSessions();
}

async function deleteSession(id) {
  const res = await api('DELETE', `/api/sessions/${id}`);
  if (!res.ok) return;
  if (currentSessionId === id) {
    currentSessionId = null;
    localStorage.removeItem('currentSessionId');
    renderWelcome();
  }
  await loadSessions();
}

async function exportSession(id, format = 'markdown') {
  window.open(`/api/sessions/${id}/export?format=${format}`);
}

function renderWelcome() {
  chatMessages.innerHTML = `<div class="welcome-screen">
    <svg class="welcome-logo" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M32 4L56 18V46L32 60L8 46V18L32 4Z"/><path d="M32 4V60"/>
      <path d="M8 18L56 46"/><path d="M56 18L8 46"/>
    </svg>
    <h2>Start a new chat</h2>
    <p>Select a provider and model, then send a message.</p>
    <div class="welcome-shortcuts">
      <div class="shortcut-tip"><kbd>Ctrl+K</kbd> Command Palette</div>
      <div class="shortcut-tip"><kbd>Ctrl+N</kbd> New Chat</div>
      <div class="shortcut-tip"><kbd>?</kbd> All Shortcuts</div>
    </div>
  </div>`;
}

// ─── Messages ────────────────────────────────────────────────────────────
function createMessageDiv(role, content) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  const actionBtns = role === 'assistant'
    ? '<div class="message-actions"><button class="msg-action-btn" onclick="copyMessage(this)" title="Copy">📋</button><button class="msg-action-btn" onclick="regenerateMessage(this)" title="Regenerate">↻</button><button class="msg-action-btn" onclick="deleteMessage(this)" title="Delete">🗑</button></div>'
    : '<div class="message-actions"><button class="msg-action-btn" onclick="copyMessage(this)" title="Copy">📋</button><button class="msg-action-btn" onclick="editMessage(this)" title="Edit">✏️</button></div>';
  div.innerHTML = actionBtns + formatMessage(content);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function renderMessages(messages) {
  chatMessages.innerHTML = '';
  if (!messages.length) { renderWelcome(); return; }
  messages.forEach(msg => createMessageDiv(msg.role, msg.content));
}

function showTypingIndicator() {
  const div = document.createElement('div');
  div.id = 'typing-indicator';
  div.className = 'typing-indicator';
  div.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeTypingIndicator() {
  const el = $('#typing-indicator');
  if (el) el.remove();
}

window.copyMessage = function(btn) {
  const msg = btn.closest('.message');
  const html = msg.querySelector('pre, code, p, div:not(.message-actions), br');
  let text = msg.textContent.trim().replace(msg.querySelector('.message-actions')?.textContent || '', '').trim();
  navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard'));
};

window.editMessage = function(btn) {
  const msg = btn.closest('.message');
  const text = msg.textContent.trim().replace(msg.querySelector('.message-actions')?.textContent || '', '').trim();
  messageInput.value = text;
  messageInput.focus();
  messageInput.style.height = 'auto';
  if (statusBarModel) statusBarModel.textContent = `Editing last message`;
};

window.deleteMessage = async function(btn) {
  const msgDiv = btn.closest('.message');
  const allMsgs = [...chatMessages.querySelectorAll('.message')];
  const idx = allMsgs.indexOf(msgDiv);
  if (idx < 0 || !currentSessionId) return;
  if (!confirm('Delete this message?')) return;
  await api('POST', `/api/sessions/${currentSessionId}/delete-message`, { index: idx });
  const res = await api('GET', `/api/sessions/${currentSessionId}`);
  if (res.ok) {
    const data = await res.json();
    renderMessages(data.messages || []);
  }
  showToast('Message deleted');
};

window.regenerateMessage = async function(btn) {
  if (!currentSessionId || isStreaming) return;
  showTypingIndicator();
  setStatus('Regenerating...', 'thinking');

  // Remove current assistant message visually
  const msgDiv = btn.closest('.message');
  if (msgDiv) msgDiv.innerHTML = '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>';

  const res = await fetch('/api/message/regenerate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ session_id: currentSessionId }),
  });
  if (!res.ok) { showToast('Regeneration failed'); setStatus('Ready'); return; }

  let assistantText = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'chunk') {
            assistantText += data.content;
            const newDiv = msgDiv.closest('.message') || msgDiv;
            newDiv.innerHTML = `<div class="message-actions"><button class="msg-action-btn" onclick="copyMessage(this)">📋</button><button class="msg-action-btn" onclick="regenerateMessage(this)">↻</button><button class="msg-action-btn" onclick="deleteMessage(this)">🗑</button></div>${formatMessage(assistantText)}`;
            chatMessages.scrollTop = chatMessages.scrollHeight;
          } else if (data.type === 'done') {
            setStatus('Ready');
          } else if (data.type === 'error') {
            showToast('Error: ' + data.content);
          }
        } catch (e) {}
      }
    }
  }
  await loadSessions();
};

// ─── Send Message ────────────────────────────────────────────────────────
async function sendMessage() {
  const content = messageInput.value.trim();
  if (!content && !pendingAttachments.length) return;

  if (!currentSessionId) {
    await createNewSession();
    if (!currentSessionId) return;
  }

  let uploaded = [];
  if (pendingAttachments.length) {
    setStatus('Uploading...', 'thinking');
    const fd = new FormData();
    pendingAttachments.forEach(f => fd.append('files', f));
    try {
      const upRes = await fetch('/api/upload', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd });
      if (!upRes.ok) throw new Error('Upload failed');
      uploaded = (await upRes.json()).files || [];
    } catch (e) {
      showToast('Upload failed: ' + e.message); return;
    }
    pendingAttachments = [];
    renderAttachments();
  }

  // Remove welcome
  const welcome = chatMessages.querySelector('.welcome-screen');
  if (welcome) welcome.remove();

  let displayText = content || '';
  if (uploaded.length) displayText += (displayText ? '\n\n' : '') + uploaded.map(f => `[${f.name}]`).join('\n');

  createMessageDiv('user', displayText);
  messageInput.value = '';
  messageInput.style.height = 'auto';

  isStreaming = true;
  sendBtn.disabled = true;
  cancelBtn.style.display = 'flex';
  showTypingIndicator();
  setStatus('Thinking...', 'thinking');

  let assistantText = '';
  const assistantDiv = createMessageDiv('assistant', '');

  try {
    abortController = new AbortController();
    const res = await fetch(`/api/sessions/${currentSessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ content: content || '', attachments: uploaded }),
      signal: abortController.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'chunk') {
              assistantText += data.content;
              removeTypingIndicator();
              assistantDiv.innerHTML = `<div class="message-actions"><button class="msg-action-btn" onclick="copyMessage(this)">📋</button><button class="msg-action-btn" onclick="regenerateMessage(this)">↻</button><button class="msg-action-btn" onclick="deleteMessage(this)">🗑</button></div>${formatMessage(assistantText)}`;
              chatMessages.scrollTop = chatMessages.scrollHeight;
            } else if (data.type === 'error') {
              showToast('Error: ' + data.content);
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      assistantText += '\n\n*[Cancelled]*';
    } else {
      assistantText += '\n\n*[Error: ' + e.message + ']*';
    }
  } finally {
    isStreaming = false;
    sendBtn.disabled = false;
    cancelBtn.style.display = 'none';
    removeTypingIndicator();
    setStatus('Ready');
    if (statusBarRunner) statusBarRunner.textContent = '● Idle';
    abortController = null;
    await loadSessions();
    refreshStatus();
  }
}

function cancelMessage() {
  if (abortController) {
    abortController.abort();
    if (currentSessionId) api('POST', `/api/sessions/${currentSessionId}/cancel`);
  }
}

// ─── Command Palette ─────────────────────────────────────────────────────
function updatePaletteItems() {
  paletteItems = [];
  paletteItems.push({ type: 'action', icon: '➕', label: 'New Chat', desc: 'Start a new conversation', action: createNewSession });
  paletteItems.push({ type: 'action', icon: '⌕', label: 'Search Chats', desc: 'Search conversations', action: () => { closePalette(); startSearch(); } });
  paletteItems.push({ type: 'action', icon: '⚙', label: 'Settings', desc: 'Configure API keys', action: () => { closePalette(); openSettings(); } });
  paletteItems.push({ type: 'action', icon: '🎨', label: 'Change Theme', desc: 'Pick theme and accent color', action: () => { closePalette(); openThemePicker(); } });
  paletteItems.push({ type: 'action', icon: '?', label: 'Keyboard Shortcuts', desc: 'View all shortcuts', action: () => { closePalette(); openShortcuts(); } });
  if (currentSessionId) {
    paletteItems.push({ type: 'action', icon: '📥', label: 'Export (Markdown)', desc: 'Download as .md', action: () => exportSession(currentSessionId, 'markdown') });
    paletteItems.push({ type: 'action', icon: '📥', label: 'Export (JSON)', desc: 'Download as .json', action: () => exportSession(currentSessionId, 'json') });
  }
  for (const p of providersList) {
    paletteItems.push({ type: 'action', icon: '🔄', label: `Switch to ${p.name}`, desc: `Use ${p.name} provider`, action: () => { closePalette(); providerSelect.value = p.id; handleProviderChange(); } });
  }
  const sessions = JSON.parse(localStorage.getItem('sessions_cache') || '[]');
  sessions.slice(0, 8).forEach(s => {
    paletteItems.push({ type: 'session', icon: '💬', label: s.title || 'Untitled', desc: `${(s.model_id||'').split('/').pop()} · ${s.message_count||0} msgs`, action: () => { closePalette(); selectSession(s.id); } });
  });
}

function openPalette() {
  updatePaletteItems();
  paletteSelectedIndex = 0;
  commandPaletteOpen = true;
  palette.style.display = 'flex';
  paletteInput.value = '';
  paletteInput.focus();
  renderPaletteItems('');
}

function closePalette() {
  commandPaletteOpen = false;
  palette.style.display = 'none';
}

function renderPaletteItems(query) {
  const q = query.toLowerCase();
  const filtered = query
    ? paletteItems.filter(i => i.label.toLowerCase().includes(q) || (i.desc||'').toLowerCase().includes(q))
    : paletteItems;
  paletteResults.innerHTML = '';
  if (!filtered.length) {
    paletteResults.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-muted)">No results</div>';
    return;
  }
  filtered.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'palette-item' + (i === paletteSelectedIndex ? ' selected' : '');
    div.innerHTML = `<span class="palette-item-icon">${item.icon}</span><div class="palette-item-text"><div class="palette-item-label">${escapeHtml(item.label)}</div><div class="palette-item-desc">${escapeHtml(item.desc||'')}</div></div>`;
    div.addEventListener('click', () => { paletteSelectedIndex = i; item.action(); });
    paletteResults.appendChild(div);
  });
}

// ─── Theme Engine ────────────────────────────────────────────────────────
function applyTheme(themeId, accent) {
  document.documentElement.setAttribute('data-theme', themeId);
  if (accent) {
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--accent-hover', lightenColor(accent, 20));
    document.documentElement.style.setProperty('--accent-glow', hexToRgba(accent, 0.15));
  }
  localStorage.setItem('oc_theme', themeId);
  if (accent) localStorage.setItem('oc_accent', accent);
  $$('.theme-option').forEach(btn => btn.classList.toggle('active', btn.dataset.theme === themeId));
  $$('.accent-swatch').forEach(btn => btn.classList.toggle('active', btn.dataset.color === accent));
}

function lightenColor(hex, amt) {
  let r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgb(${Math.min(255,r+amt)},${Math.min(255,g+amt)},${Math.min(255,b+amt)})`;
}

function hexToRgba(hex, alpha) {
  return `rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${alpha})`;
}

function openThemePicker() { themePicker.style.display = 'flex'; }
function closeThemePicker() { themePicker.style.display = 'none'; }

// ─── Settings ────────────────────────────────────────────────────────────
function openSettings() {
  settingsModal.style.display = 'flex';
  api('GET', '/api/provider_keys').then(async res => {
    if (!res.ok) return;
    const data = await res.json();
    for (const [p, info] of Object.entries(data.keys||{})) {
      const el = $(`#status-${p}`);
      if (el) {
        el.textContent = info.has_key ? `● ...${info.last4}` : '○ No key stored';
        el.className = 'key-status' + (info.has_key ? ' has' : '');
      }
    }
  });
}

function closeSettings() { settingsModal.style.display = 'none'; }

function toggleKeyVisibility(btn) {
  const input = $(`#${btn.dataset.target}`);
  if (input) { input.type = input.type === 'password' ? 'text' : 'password'; }
}

async function saveProviderKeys() {
  const keys = [
    { p: 'venice', el: $('#key-venice') }, { p: 'openrouter', el: $('#key-openrouter') },
    { p: 'xai', el: $('#key-xai') }, { p: 'groq', el: $('#key-groq') },
  ];
  let saved = 0;
  for (const {p, el} of keys) {
    if (!el) continue;
    const v = el.value.trim();
    if (v) {
      const res = await api('POST', '/api/provider_keys', { provider: p.toLowerCase(), api_key: v });
      if (res.ok) saved++;
    }
  }
  showToast(saved > 0 ? `${saved} key(s) saved` : 'No keys to save');
  closeSettings();
  if (currentProvider) await refreshModelsForProvider(currentProvider, true);
}

// ─── Shortcuts ───────────────────────────────────────────────────────────
function openShortcuts() { shortcutsOverlay.style.display = 'flex'; }
function closeShortcuts() { shortcutsOverlay.style.display = 'none'; }

// ─── Attachments & Drag/Drop ─────────────────────────────────────────────
function renderAttachments() {
  attachmentPreview.innerHTML = '';
  pendingAttachments.forEach((file, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.innerHTML = `<span class="chip-name">${file.name}</span><button class="chip-remove" onclick="window.removeAttachment(${i})">×</button>`;
    attachmentPreview.appendChild(chip);
  });
}

window.removeAttachment = function(index) {
  pendingAttachments.splice(index, 1);
  renderAttachments();
};

function handleFiles(files) {
  for (const file of files) {
    if (file.size > 50 * 1024 * 1024) { showToast(`${file.name} too large (max 50MB)`); continue; }
    if (!pendingAttachments.find(f => f.name === file.name && f.size === file.size)) pendingAttachments.push(file);
  }
  renderAttachments();
}

// ─── Sidebar Search ──────────────────────────────────────────────────────
function startSearch() {
  const input = $('#sidebar-search-input');
  if (input) { input.focus(); sidebar?.classList.add('open'); }
}

// ─── System Status ───────────────────────────────────────────────────────
async function refreshStatus() {
  const res = await api('GET', '/api/status');
  if (!res.ok) return;
  const data = await res.json();
  if (statusBarModel) statusBarModel.textContent = `Model: ${(data.model||'—').split('/').pop() || '—'}`;
  if (statusBarProvider) statusBarProvider.textContent = `Provider: ${data.model ? data.model.split('/')[0] : '—'}`;
  if (statusBarSessions) statusBarSessions.textContent = `Sessions: ${data.session_count||0}`;
  if (statusBarKey) {
    const provs = data.providers || [];
    const hasAny = provs.some(p => p.key_status === 'green');
    const hasAll = provs.length > 0 && provs.every(p => p.key_status === 'green');
    const color = hasAll ? 'var(--success)' : (hasAny ? 'var(--warning)' : 'var(--error)');
    statusBarKey.innerHTML = `Key: <span style="color:${color}">⬤</span>`;
  }
  // Token/cost tracking
  sessionTokenUsage = {
    inputs: data.total_input_tokens || 0,
    outputs: data.total_output_tokens || 0,
    cost: data.total_cost || 0,
    messages: data.session_count || 0,
  };
  const costEl = $('#status-bar-cost');
  if (costEl) costEl.textContent = `$${(data.total_cost||0).toFixed(4)}`;
  const tokensEl = $('#status-bar-tokens');
  if (tokensEl) tokensEl.textContent = `↑${formatCount(data.total_input_tokens||0)} ↓${formatCount(data.total_output_tokens||0)}`;
}

function formatCount(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n/1000).toFixed(1) + 'K';
  return n.toString();
}

// ─── Init ────────────────────────────────────────────────────────────────
async function initApp() {
  initDomRefs();
  const savedTheme = localStorage.getItem('oc_theme') || 'dark';
  const savedAccent = localStorage.getItem('oc_accent');
  applyTheme(savedTheme, savedAccent);

  await loadProviders();
  const res = await api('GET', '/api/model');
  if (res.ok) {
    const data = await res.json();
    currentProvider = data.current_provider || '';
    currentModel = data.current_model || '';
    if (currentProvider) {
      providerSelect.value = currentProvider;
      await refreshModelsForProvider(currentProvider, false);
    }
    if (statusBarModel) statusBarModel.textContent = `Model: ${currentModel||'—'}`;
    if (statusBarProvider) statusBarProvider.textContent = `Provider: ${currentProvider||'—'}`;
  }
  await loadSessions();
  await refreshStatus();

  const savedId = localStorage.getItem('currentSessionId');
  if (savedId) {
    currentSessionId = savedId;
    const sessRes = await api('GET', `/api/sessions/${savedId}`);
    if (sessRes.ok) {
      const data = await sessRes.json();
      renderMessages(data.messages || []);
    }
  }

  const sessionsRes = await api('GET', '/api/sessions');
  if (sessionsRes.ok) {
    const data = await sessionsRes.json();
    localStorage.setItem('sessions_cache', JSON.stringify(data.sessions||[]));
  }

  bindEvents();
  setInterval(refreshStatus, 30000);
}

function bindEvents() {
  authBtn?.addEventListener('click', doAuth);
  authTokenInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doAuth(); });
  newChatBtn?.addEventListener('click', createNewSession);
  providerSelect?.addEventListener('change', () => { currentProvider = providerSelect.value; handleProviderChange(); });
  modelSelect?.addEventListener('change', () => { currentModel = modelSelect?.value || ''; });
  refreshModelsBtn?.addEventListener('click', () => refreshModelsForProvider(currentProvider, true));
  sendBtn?.addEventListener('click', sendMessage);
  cancelBtn?.addEventListener('click', cancelMessage);

  messageInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!isStreaming) sendMessage(); }
    if (e.key === 'Escape' && isStreaming) cancelMessage();
    if (e.key === 'ArrowUp' && !messageInput.value.trim() && !isStreaming) {
      const msgs = [...chatMessages.querySelectorAll('.message.user')];
      if (msgs.length) { messageInput.value = msgs[msgs.length-1].textContent.trim(); messageInput.focus(); }
    }
  });

  attachBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });

  // Drag and drop
  let dragCounter = 0;
  chatArea?.addEventListener('dragenter', e => { e.preventDefault(); dragCounter++; $('#drop-zone')?.classList.add('active'); });
  chatArea?.addEventListener('dragleave', e => { e.preventDefault(); dragCounter--; if (!dragCounter) $('#drop-zone')?.classList.remove('active'); });
  chatArea?.addEventListener('dragover', e => e.preventDefault());
  chatArea?.addEventListener('drop', e => { e.preventDefault(); $('#drop-zone')?.classList.remove('active'); dragCounter=0; handleFiles(e.dataTransfer.files); });

  menuToggle?.addEventListener('click', () => sidebar?.classList.toggle('open'));

  const searchBar = $('#sidebar-search-input');
  let searchTimeout;
  searchBar?.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadSessions(searchBar.value.trim()), 300);
  });

  commandPaletteBtn?.addEventListener('click', () => commandPaletteOpen ? closePalette() : openPalette());
  paletteInput?.addEventListener('input', () => { paletteSelectedIndex=0; renderPaletteItems(paletteInput.value); });
  paletteInput?.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closePalette(); return; }
    const items = paletteResults?.querySelectorAll('.palette-item') || [];
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteSelectedIndex = Math.min(paletteSelectedIndex+1, items.length-1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); paletteSelectedIndex = Math.max(paletteSelectedIndex-1, 0); }
    if (e.key === 'Enter') { e.preventDefault(); if (items[paletteSelectedIndex]) items[paletteSelectedIndex].click(); }
  });

  themeBtn?.addEventListener('click', () => themePicker.style.display === 'none' ? openThemePicker() : closeThemePicker());
  $$('.theme-option').forEach(btn => btn.addEventListener('click', () => { applyTheme(btn.dataset.theme, localStorage.getItem('oc_accent')); }));
  $$('.accent-swatch').forEach(btn => btn.addEventListener('click', () => { applyTheme(localStorage.getItem('oc_theme')||'dark', btn.dataset.color); }));

  shortcutsBtn?.addEventListener('click', () => shortcutsOverlay.style.display === 'none' ? openShortcuts() : closeShortcuts());
  shortcutsClose?.addEventListener('click', closeShortcuts);
  settingsBtn?.addEventListener('click', () => settingsModal.style.display === 'none' ? openSettings() : closeSettings());
  settingsClose?.addEventListener('click', closeSettings);
  saveKeysBtn?.addEventListener('click', saveProviderKeys);
  $$('.key-toggle-btn').forEach(btn => btn.addEventListener('click', () => toggleKeyVisibility(btn)));

  const exportAllBtn = $('#export-all-btn');
  exportAllBtn?.addEventListener('click', () => {
    api('GET', '/api/sessions').then(async res => {
      if (!res.ok) return;
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data.sessions, null, 2)], {type:'application/json'});
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'all-chats.json'; a.click();
      showToast('Exported all chats');
    });
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey||e.metaKey) && e.key === 'k') { e.preventDefault(); commandPaletteOpen ? closePalette() : openPalette(); }
    if ((e.ctrlKey||e.metaKey) && e.key === 'n') { e.preventDefault(); if (app?.style.display !== 'none') createNewSession(); }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !commandPaletteOpen) {
      const active = document.activeElement;
      if (!active || (active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA')) {
        shortcutsOverlay.style.display === 'none' ? openShortcuts() : closeShortcuts();
      }
    }
    if ((e.ctrlKey||e.metaKey) && e.key === 'e') { e.preventDefault(); if (currentSessionId) exportSession(currentSessionId); }
    if ((e.ctrlKey||e.metaKey) && e.key === 's') { e.preventDefault(); startSearch(); }
    if ((e.ctrlKey||e.metaKey) && e.shiftKey && e.key === 'U') { e.preventDefault(); fileInput?.click(); }
    if (e.key === 'Escape') {
      if (commandPaletteOpen) closePalette();
      else if (shortcutsOverlay.style.display !== 'none') closeShortcuts();
      else if (settingsModal.style.display !== 'none') closeSettings();
      else if (themePicker?.style.display !== 'none') closeThemePicker();
    }
  });

  palette?.addEventListener('click', e => { if (e.target === palette) closePalette(); });
  shortcutsOverlay?.addEventListener('click', e => { if (e.target === shortcutsOverlay) closeShortcuts(); });
  themePicker?.addEventListener('click', e => { if (e.target === themePicker) closeThemePicker(); });
  settingsModal?.addEventListener('click', e => { if (e.target === settingsModal) closeSettings(); });
}

// Boot — no auth gate, just load the app
initDomRefs();
// Always show app (no auth screen on localhost)
if (app) app.style.display = '';
if (authScreen) authScreen.style.display = 'none';
initApp();