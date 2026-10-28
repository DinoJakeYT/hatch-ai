// Hatch on a phone: the chats from the PC, live, in the phone's browser. The PC does all the work;
// this page shows it and sends what you type or tap. It talks to lib/remote.mjs.
const $ = id => document.getElementById(id);

// ---------- pairing ----------
// The key arrives once, in the QR code's link (#key=...). It's kept on this phone and taken out of the address.
const KEY_STORE = 'hatchKey';
const linked = /[#&]key=([\w-]+)/.exec(location.hash)?.[1];
if (linked) {
  try { localStorage.setItem(KEY_STORE, linked); } catch {}
  history.replaceState(null, '', location.pathname);
}
let key = '';
try { key = localStorage.getItem(KEY_STORE) || ''; } catch {}

const state = {
  chats: [], models: [], defaultPermission: 'edits',
  chatId: null, chat: null, newChat: false, activity: [], nodes: [],
};

// ---------- small helpers ----------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const fileName = p => String(p || '').split(/[\\/]/).pop();
const firstLine = s => String(s || '').split('\n')[0];

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}

function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// "local:glm-4.7-flash:latest" -> "Local glm-4.7-flash"
function modelName(value) {
  const known = state.models.find(m => m.value === value && !m.team);
  if (known) return known.label.replace(/ Default$/, '');
  const [p, ...rest] = String(value || 'sub:').split(':');
  const m = rest.join(':').replace(/:latest$/, '');
  const names = { sub: 'Claude', api: 'Claude API', chatgpt: 'ChatGPT', openai: 'OpenAI', gemini: 'Gemini', openrouter: 'OpenRouter', custom: 'Custom', local: 'Local' };
  return `${names[p] || p}${m ? ` ${m}` : ''}`;
}

function md(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: true }));
}
DOMPurify.addHook('afterSanitizeAttributes', n => { if (n.tagName === 'A') { n.target = '_blank'; n.rel = 'noopener'; } });

let toastTimer = 0;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}

function show(view) {
  for (const v of ['listView', 'chatView', 'pairView']) $(v).hidden = v !== view;
}

function showPair(text) {
  if (text) $('pairText').textContent = text;
  show('pairView');
}

// ---------- talking to the PC ----------

async function api(path, body) {
  const res = await fetch(`api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 429) {
    showPair(data.error);
    throw new Error('not paired');
  }
  if (data?.error) toast(data.error);
  return data;
}

let events = null;
let wasDown = false;

function connect() {
  events?.close();
  events = new EventSource(`api/events?key=${encodeURIComponent(key)}`);
  events.onopen = () => {
    setConn(true);
    if (wasDown) resync();   // events may have been missed while the connection was down
    wasDown = false;
  };
  events.onerror = () => { setConn(false); wasDown = true; };
  events.addEventListener('chat:event', e => onEvent(JSON.parse(e.data)));
}

function setConn(on) {
  for (const id of ['conn', 'conn2']) {
    $(id).classList.toggle('on', on);
    $(id).title = on ? 'Connected to your PC' : 'Not connected: is Hatch open and the PC on the same network?';
  }
}

async function loadState() {
  const s = await api('state');
  Object.assign(state, { chats: s.chats || [], models: s.models || [], defaultPermission: s.defaultPermission || 'edits' });
  renderList();
}

function resync() {
  loadState().catch(() => {});
  if (state.chatId && !state.newChat) openChat(state.chatId, { keepScroll: true }).catch(() => {});
}

// ---------- the chat list ----------

function renderList() {
  const box = $('chatList');
  box.innerHTML = '';
  if (!state.chats.length) box.append(el('div', 'empty', 'No chats yet. Start one with New chat.'));
  for (const c of state.chats) {
    const row = el('a', 'chat-row');
    row.href = `#/chat/${encodeURIComponent(c.id)}`;
    const text = el('div', 'grow');
    text.append(el('div', 'name', c.title), el('div', 'meta', `${modelName(c.model)} · ${ago(c.updatedAt)}`));
    row.append(text);
    if (c.running) row.append(el('span', 'dot'));
    box.append(row);
  }
}

let listTimer = 0;
const refreshListSoon = () => { clearTimeout(listTimer); listTimer = setTimeout(() => loadState().catch(() => {}), 400); };

// ---------- one chat ----------

async function openChat(id, { keepScroll = false } = {}) {
  state.chatId = id;
  state.newChat = false;
  show('chatView');
  $('newOptions').hidden = true;
  const chat = await api(`chat?id=${encodeURIComponent(id)}`);
  if (chat.error) { location.hash = ''; return; }
  state.chat = chat;
  state.activity = chat.activity || [];
  renderChat(keepScroll);
}

function openNew() {
  state.chatId = null;
  state.newChat = true;
  state.chat = { items: [], offset: 0, running: false };
  state.activity = [];
  show('chatView');
  $('chatTitle').textContent = 'New chat';
  $('chatSub').textContent = 'Runs on your PC, in a new project folder';
  $('newOptions').hidden = false;
  const sel = $('modelSel');
  sel.innerHTML = '';
  state.models.forEach((m, i) => { const o = el('option', null, m.label); o.value = String(i); sel.append(o); });
  let last = '';
  try { last = localStorage.getItem('hatchModel') || ''; } catch {}
  const i = state.models.findIndex(m => `${m.team || ''}|${m.value}` === last);
  sel.value = String(i >= 0 ? i : 0);
  $('permSel').value = state.defaultPermission;
  $('messages').innerHTML = '';
  $('messages').append(el('div', 'empty', state.models.length ? 'What should we hatch? Pick an AI above, then type below.' : 'No AI is ready on your PC yet: set one up in Hatch first.'));
  renderActivity();
  updateComposer();
  $('input').focus();
}

function renderChat(keepScroll) {
  const c = state.chat;
  $('chatTitle').textContent = c.title;
  $('chatSub').textContent = `${c.team ? `Team ${c.team}` : modelName(c.model)} · ${c.folder}`;
  const box = $('messages');
  const top = box.scrollTop;
  box.innerHTML = '';
  if (c.offset) box.append(el('div', 'note', `Showing the latest part of this chat. The rest is on the PC.`));
  state.nodes = c.items.map((it, i) => {
    const n = renderItem(it, i);
    box.append(n);
    return n;
  });
  renderActivity();
  updateComposer();
  if (keepScroll) box.scrollTop = top;
  else box.scrollTop = box.scrollHeight;
}

// Who is talking, in team chats (shown when it changes).
function agentLabel(i) {
  const items = state.chat.items;
  const it = items[i];
  if (!it.agent || !['assistant', 'tool'].includes(it.type)) return null;
  for (let j = i - 1; j >= 0; j--) {
    if (items[j].type === 'user') break;
    if (['assistant', 'tool'].includes(items[j].type)) return items[j].agent === it.agent ? null : it;
  }
  return it;
}

function describe(it) {
  const p = it.input || {};
  const running = it.status === 'running';
  const todos = p.todos || [];
  switch (it.name) {
    case 'Write': return [running ? 'Writing' : 'Created', fileName(p.file_path), p.content];
    case 'Edit': case 'MultiEdit': return [running ? 'Editing' : 'Edited', fileName(p.file_path), p.new_string];
    case 'Bash': case 'PowerShell': return [p.description === 'Hatch check' ? 'Checked build' : running ? 'Running' : 'Ran', p.command, it.result];
    case 'Read': return ['Read', fileName(p.file_path), ''];
    case 'LS': case 'Glob': case 'Grep': return ['Looked through files', p.pattern || p.path || '', it.result];
    case 'TodoWrite': return ['Plan', `${todos.filter(t => t.status === 'completed').length}/${todos.length} done`, todos.map(t => `${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'} ${t.content}`).join('\n')];
    case 'Preview': return ['Previewed', fileName(p.file_path), it.result];
    case 'Open': return ['Opened', fileName(p.file_path), ''];
    case 'Remember': return ['Remembered', p.fact, ''];
    case 'Template': return ['Started from template', p.name, it.result];
    case 'Skill': return ['Used skill', p.skill || p.name, ''];
    case 'Patch': return ['Changed files', (p.changes || []).map(c => fileName(c.path)).join(', '), ''];
    case 'WebSearch': return ['Searched the web', p.query, it.result];
    case 'WebFetch': return ['Read a web page', p.url, ''];
    case 'Delegate': case 'mcp__hatch__delegate': case 'hatch: delegate':
      return [running ? `${p.agent || 'A helper'} is working on` : `Asked ${p.agent || 'a helper'}`, firstLine(p.task), it.result || p.task];
    case 'mcp__hatch__wait_for_helpers': case 'hatch: wait_for_helpers': return [running ? 'Waiting for helpers' : 'Helpers reported', '', it.result];
    case 'HelperReport': return [`${p.agent || 'Helper'} finished`, firstLine(p.task), it.result];
    case 'SkillProposal': return [{ pending: 'Wants to save a skill', done: 'Saved skill', denied: 'Declined skill' }[it.status] || 'Skill', p.name, `${p.description || ''}\n\n${p.body || ''}`];
    case 'mcp__hatch__propose_skill': case 'hatch: propose_skill': return ['Proposed a skill', p.name, it.result];
    default: return [it.name, '', it.result || ''];
  }
}

function button(text, cls, onClick) {
  const b = el('button', cls, text);
  b.addEventListener('click', onClick);
  return b;
}

function renderItem(it, i) {
  const index = state.chat.offset + i;   // the item's number on the PC
  if (it.type === 'user') {
    const row = el('div', 'row user');
    const col = el('div', 'ucol');
    col.append(el('div', `bubble${it.queued ? ' queued' : ''}`, it.text));
    const meta = el('div', 'umeta');
    if (it.queued === 'waiting') meta.append(el('span', 'q', 'Waiting for the AI\'s next step…'));
    if (it.queued === 'seen') meta.append(el('span', 'q', 'Seen by the AI while it worked'));
    if (it.checkpoint && !state.chat.running) {
      meta.append(button('Undo changes since this', 'link', async () => {
        if (!confirm('Put the project files back to how they were before this message? You can bring them back with Redo.')) return;
        await api('undo', { chatId: state.chatId, index });
      }));
    }
    if (meta.childNodes.length) col.append(meta);
    row.append(col);
    return row;
  }
  if (it.type === 'error') return el('div', 'note err', it.text);
  if (it.type === 'note' || !['assistant', 'tool'].includes(it.type)) {
    const n = el('div', 'note', it.text);
    if (it.redo) n.append(button('Redo', 'link', () => api('redo', { chatId: state.chatId, index })));
    return n;
  }

  const row = el('div', 'row ai');
  const who = agentLabel(i);
  if (who) row.append(el('div', 'agent', `${who.agent} · ${modelName(who.agentModel || `${who.by}:`)}`));
  if (it.type === 'assistant') {
    if (!it.text.trim()) row.hidden = true;
    const b = el('div', 'bubble');
    b.innerHTML = md(it.text);
    row.append(b);
    return row;
  }

  // a tool card: what it did, tap to see more
  const [verb, target, body] = describe(it);
  const card = el('details', `card ${it.status || ''}`);
  const sum = el('summary');
  sum.append(el('span', 'verb', verb), el('span', 'target', target || ''));
  const st = el('span', 'st');
  if (it.status === 'running' && it.perm?.status !== 'pending') st.append(el('span', 'spinner'));
  else st.textContent = { done: '✓', error: '✕', denied: '✕', stopped: '–' }[it.status] || '';
  sum.append(st);
  card.append(sum);
  if (it.input?.image) {
    const img = el('img', 'shot');
    img.src = `api/image?path=${encodeURIComponent(it.input.image)}&key=${encodeURIComponent(key)}`;
    img.alt = 'Screenshot';
    card.append(img);
    card.open = true;
  }
  if (body) card.append(el('pre', null, body));
  row.append(card);

  // decisions waiting for the user
  if (it.perm?.status === 'pending') {
    const ask = el('div', 'ask');
    ask.append(el('div', 'q', `Allow ${it.agent && it.agent !== 'Lead' ? it.agent : 'the AI'} to do this?`));
    const line = el('div', 'buttons');
    const decide = decision => api('perm', { reqId: it.perm.reqId, decision });
    line.append(button('Allow', 'primary', () => decide('allow')), button('Always allow', '', () => decide('always')), button('Deny', '', () => decide('deny')));
    ask.append(line);
    row.append(ask);
    card.open = true;
  }
  if (it.name === 'SkillProposal' && it.status === 'pending') {
    const ask = el('div', 'ask');
    ask.append(el('div', 'q', 'Save this as a skill every AI can use?'));
    const line = el('div', 'buttons');
    line.append(button('Save skill', 'primary', () => api('skill', { chatId: state.chatId, index, decision: 'approve' })),
      button('Decline', '', () => api('skill', { chatId: state.chatId, index, decision: 'decline' })));
    ask.append(line);
    row.append(ask);
  }
  return row;
}

const nearBottom = () => { const b = $('messages'); return b.scrollHeight - b.scrollTop - b.clientHeight < 140; };

// ---------- live updates ----------

function onEvent(ev) {
  if (ev.kind === 'status') refreshListSoon();
  if (!state.chat || state.newChat || ev.chatId !== state.chatId) return;
  const box = $('messages');
  const stick = nearBottom();
  if (ev.kind === 'item-add') {
    const i = ev.index - state.chat.offset;
    if (i !== state.chat.items.length) { openChat(state.chatId, { keepScroll: true }); return; }   // missed something
    state.chat.items.push(ev.item);
    const n = renderItem(ev.item, i);
    state.nodes[i] = n;
    box.append(n);
  } else if (ev.kind === 'item-update') {
    const i = ev.index - state.chat.offset;
    const it = state.chat.items[i];
    if (!it) return;
    Object.assign(it, ev.patch);
    const old = state.nodes[i];
    if (it.type === 'assistant' && old?.querySelector('.bubble')) {
      old.querySelector('.bubble').innerHTML = md(it.text);
      old.hidden = !it.text.trim();
    } else if (old) {
      const wasOpen = old.querySelector('details')?.open;
      const n = renderItem(it, i);
      if (wasOpen && n.querySelector('details')) n.querySelector('details').open = true;
      old.replaceWith(n);
      state.nodes[i] = n;
      const pre = n.querySelector('.card.running pre');
      if (pre) pre.scrollTop = pre.scrollHeight;
    }
  } else if (ev.kind === 'status') {
    state.chat.running = ev.running;
    if (!ev.running) state.activity = [];
    // undo buttons appear once the AI is done
    renderChat(true);
  } else if (ev.kind === 'activity') {
    state.activity = ev.list;
    renderActivity();
  } else if (ev.kind === 'permission') {
    state.chat.permission = ev.permission;
  }
  updateComposer();
  if (stick) box.scrollTop = box.scrollHeight;
}

// ---------- who is working right now ----------

let activityTimer = 0;
function renderActivity() {
  const list = state.chat?.running ? state.activity : [];
  const box = $('activity');
  box.hidden = !list.length;
  box.innerHTML = '';
  const now = Date.now();
  for (const a of list) {
    const row = el('div', 'act');
    row.append(el('span', 'spinner'), el('span', 'who', a.agent || modelName(a.model)), el('span', 'what', a.status), el('span', 'time', elapsed(now - a.statusSince)));
    box.append(row);
  }
  clearInterval(activityTimer);
  if (list.length) activityTimer = setInterval(renderActivity, 1000);
}

// ---------- sending ----------

function updateComposer() {
  const typed = !!$('input').value.trim();
  const running = !state.newChat && !!state.chat?.running;
  $('sendBtn').classList.toggle('stop', running && !typed);
  $('sendBtn').setAttribute('aria-label', running && !typed ? 'Stop' : 'Send');
  $('input').placeholder = running ? 'Add something while it works…' : 'Message Hatch…';
}

function autosize() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

async function sendNow() {
  const text = $('input').value.trim();
  const running = !state.newChat && state.chat?.running;
  if (running && !text) { await api('stop', { chatId: state.chatId }); return; }
  if (!text) return;
  $('input').value = '';
  autosize();
  updateComposer();
  if (state.newChat) {
    const m = state.models[Number($('modelSel').value)];
    if (!m) return toast('No AI is ready on your PC yet.');
    try { localStorage.setItem('hatchModel', `${m.team || ''}|${m.value}`); } catch {}
    const r = await api('send', { text, model: m.value, team: m.team || null, permission: $('permSel').value });
    if (r.chatId) location.hash = `#/chat/${encodeURIComponent(r.chatId)}`;
  } else {
    await api('send', { chatId: state.chatId, text });
  }
}

$('sendBtn').addEventListener('click', () => sendNow().catch(() => {}));
$('input').addEventListener('input', () => { autosize(); updateComposer(); });
$('input').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendNow(); } });
$('newBtn').addEventListener('click', () => { location.hash = '#/new'; });
$('backBtn').addEventListener('click', () => { location.hash = ''; });

// ---------- screens ----------

function route() {
  const m = /^#\/chat\/(.+)$/.exec(location.hash);
  if (m) openChat(decodeURIComponent(m[1])).catch(() => {});
  else if (location.hash === '#/new') openNew();
  else {
    state.chatId = null;
    state.chat = null;
    state.newChat = false;
    clearInterval(activityTimer);
    show('listView');
    loadState().catch(() => {});
  }
}

window.addEventListener('hashchange', route);
// phones pause pages in the background: catch up when it's shown again
document.addEventListener('visibilitychange', () => { if (!document.hidden && key) { connect(); resync(); } });

if (!key) {
  showPair();
} else {
  connect();
  loadState().then(route).catch(() => {});
}
