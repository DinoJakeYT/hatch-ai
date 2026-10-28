// Shared state and helpers for the Hatch window. Loaded first; the other scripts use these globals.
const api = window.hatch;
const $ = id => document.getElementById(id);

const els = {
  list: $('chatList'), messages: $('messages'), welcome: $('welcome'), welcomeUsing: $('welcomeUsing'),
  scroller: $('scroller'), input: $('input'), send: $('send'), title: $('chatTitle'),
  playBtn: $('playBtn'), folderBtn: $('folderBtn'), folderLabel: $('folderLabel'), permBtn: $('permBtn'), modelBtn: $('modelBtn'),
  newChat: $('newChat'), newGroup: $('newGroup'), toggleHidden: $('toggleHidden'),
  usageMeter: $('usageMeter'), updateBtn: $('updateBtn'), settingsBtn: $('settingsBtn'), popover: $('popover'),
  activity: $('activity'), banner: $('banner'), bannerText: $('bannerText'), bannerBtn: $('bannerBtn'), bannerBtn2: $('bannerBtn2'),
};

const state = {
  chatId: null,
  chat: null,
  running: false,
  draft: { cwd: null, model: null, team: null, permission: null },
  chats: [],
  settings: { groups: [], extraModels: {}, favorites: { openrouter: [] }, custom: {}, budgets: {}, memory: {} },
  conn: { logins: {}, keys: {}, ollama: { ok: false, models: [] }, nodeOk: true },
  usage: { limits: { blocked: {} }, month: {}, today: {} },
  signingIn: null,          // provider currently signing in
  signInError: { },         // provider -> message
  showHidden: false,
};

// ---------- small helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function md(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: true }));
}

function baseName(p) {
  return p ? String(p).split(/[\\/]/).filter(Boolean).pop() : '';
}

function clip(s, lines = 80) {
  if (!s) return '';
  const parts = String(s).split('\n');
  return parts.length > lines ? parts.slice(0, lines).join('\n') + `\n… (${parts.length - lines} more lines)` : String(s);
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// Makes the live node `from` look like `to`, keeping every element that didn't change, so nothing
// re-animates or flickers (spinners keep spinning, scroll positions stay). Returns the node now on the page.
function morph(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) {
    from.replaceWith(to);
    return to;
  }
  if (from.nodeType !== Node.ELEMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return from;
  }
  if (from.isEqualNode(to)) return from;
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  const a = [...from.childNodes];
  const b = [...to.childNodes];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) morph(a[i], b[i]);
  for (let i = n; i < a.length; i++) a[i].remove();
  for (let i = n; i < b.length; i++) from.appendChild(b[i]);
  return from;
}

// The same for a container's contents, given as HTML.
function morphChildren(parent, html) {
  const next = document.createElement(parent.nodeName);
  next.innerHTML = html;
  for (const { name, value } of [...parent.attributes]) next.setAttribute(name, value);
  morph(parent, next);
}

function fmtTokens(n) {
  if (!n) return '0';
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

function fmtMoney(n) {
  return `$${(n || 0).toFixed((n || 0) < 10 ? 2 : 0)}`;
}

function fmtReset(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function fmtAgo(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}

const ICON = {
  terminal: '<path d="M3 4.5h14v11H3z"/><path d="M6 8l2.5 2L6 12M10.5 12.5h3.5"/>',
  create: '<path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11 2.5V6h4M10 9.5v5M7.5 12h5"/>',
  edit: '<path d="M13.5 3.5l3 3L8 15l-4 1 1-4z"/>',
  read: '<path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11 2.5V6h4M7.5 10h5M7.5 13h5"/>',
  folder: '<path d="M2.5 5.5a1 1 0 0 1 1-1h4l1.5 2h7.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="9" cy="9" r="5"/><path d="M13 13l4 4"/>',
  globe: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2.5 2.5 2.5 11.5 0 14M10 3c-2.5 2.5-2.5 11.5 0 14"/>',
  list: '<path d="M7.5 5H17M7.5 10H17M7.5 15H17M3.5 5h.01M3.5 10h.01M3.5 15h.01"/>',
  spark: '<path d="M10 2.5v15M2.5 10h15M4.7 4.7l10.6 10.6M15.3 4.7L4.7 15.3"/>',
  ok: '<path d="M4 10.5l4 4 8-9"/>',
  err: '<path d="M5 5l10 10M15 5L5 15"/>',
  stop: '<path d="M5 10h10"/>',
  more: '<circle cx="5" cy="10" r=".8"/><circle cx="10" cy="10" r=".8"/><circle cx="15" cy="10" r=".8"/>',
  chev: '<path d="M6 8l4 4 4-4"/>',
  caret: '<path d="M6 8l4 4 4-4"/>',
  eye: '<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z"/><circle cx="10" cy="10" r="2.3"/>',
  eyeOff: '<path d="M3 3l14 14M8.2 5a8 8 0 0 1 1.8-.5c5 0 8 5.5 8 5.5a14 14 0 0 1-2.4 3M5.4 6.4C3.3 7.9 2 10 2 10s3 5.5 8 5.5a7.6 7.6 0 0 0 3.6-.9"/>',
  shieldAsk: '<path d="M10 2.5l6 2.5v4.5c0 4-2.6 6.8-6 8-3.4-1.2-6-4-6-8V5z"/><path d="M8.2 8.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M10 13.7h.01"/>',
  shieldEdit: '<path d="M10 2.5l6 2.5v4.5c0 4-2.6 6.8-6 8-3.4-1.2-6-4-6-8V5z"/><path d="M11.8 7.2l1 1-3.8 3.8-1.4.4.4-1.4z"/>',
  shieldOk: '<path d="M10 2.5l6 2.5v4.5c0 4-2.6 6.8-6 8-3.4-1.2-6-4-6-8V5z"/><path d="M7.2 10l2 2 3.6-4"/>',
  bolt: '<path d="M11 2.5L4.5 11H10l-1 6.5L15.5 9H10z"/>',
  lock: '<rect x="4.5" y="9" width="11" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>',
  key: '<circle cx="7" cy="12.5" r="3.5"/><path d="M9.5 10l7-7M14 5.5l2 2"/>',
  user: '<circle cx="10" cy="7" r="3.2"/><path d="M3.5 17c1-3.2 3.6-5 6.5-5s5.5 1.8 6.5 5"/>',
  chip: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.5"/><path d="M8 3v2.5M12 3v2.5M8 14.5V17M12 14.5V17M3 8h2.5M3 12h2.5M14.5 8H17M14.5 12H17"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H16v12.5H5.5A1.5 1.5 0 0 0 4 17z"/><path d="M4 17a1.5 1.5 0 0 1 1.5-1.5H16V17"/>',
  gauge: '<path d="M3.5 14a6.5 6.5 0 1 1 13 0"/><path d="M10 14l3-4"/>',
  team: '<circle cx="7.5" cy="7" r="2.6"/><circle cx="14" cy="8" r="2.1"/><path d="M2.5 16.5c.7-2.8 2.7-4.4 5-4.4s4.3 1.6 5 4.4M12.6 12.4c.5-.2.9-.3 1.4-.3 1.9 0 3.3 1.3 3.8 3.6"/>',
  handoff: '<path d="M3.5 10h11M10.5 5.5l4.5 4.5-4.5 4.5"/>',
  undo: '<path d="M7.5 5L4 8.5 7.5 12"/><path d="M4 8.5h8a4 4 0 0 1 0 8H9"/>',
  play: '<path d="M6.5 4.5v11l9-5.5z"/>',
  download: '<path d="M10 3.5v9M6 8.5l4 4 4-4M4 16.5h12"/>',
  phone: '<rect x="5.5" y="2.5" width="9" height="15" rx="2"/><path d="M9 15h2"/>',
};
const svg = paths => `<svg viewBox="0 0 20 20" aria-hidden="true">${paths}</svg>`;

// ---------- AI avatars (simple glyph tiles, one per AI family) ----------

const AV_GLYPH = {
  claude: ['#d97757', '<path d="M16 7v18M7 16h18M9.6 9.6l12.8 12.8M22.4 9.6L9.6 22.4" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>'],
  chatgpt: ['#10a37f', '<g fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><circle cx="16" cy="16" r="7.5"/><path d="M16 8.5v15M9.5 12.2l13 7.6M9.5 19.8l13-7.6"/></g>'],
  gemini: ['url(#gm)', '<path d="M16 6c1 5.6 4.4 9 10 10-5.6 1-9 4.4-10 10-1-5.6-4.4-9-10-10 5.6-1 9-4.4 10-10z" fill="#fff"/>'],
  openrouter: ['#6467f2', '<g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12h15l-4-4M24 20H9l4 4"/></g>'],
  custom: ['#5b6b78', '<g fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 7v5M19.5 7v5M10 12h12v3a6 6 0 0 1-12 0zM16 21v4"/></g>'],
  local: ['#0f766e', '<g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><rect x="10.5" y="10.5" width="11" height="11" rx="2"/><path d="M13.5 7.5v3M18.5 7.5v3M13.5 21.5v3M18.5 21.5v3M7.5 13.5h3M7.5 18.5h3M21.5 13.5h3M21.5 18.5h3"/></g>'],
};

function avatarSvg(family) {
  const [bg, glyph] = AV_GLYPH[family] || AV_GLYPH.custom;
  const defs = bg.startsWith('url') ? '<defs><linearGradient id="gm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f86ff"/><stop offset="1" stop-color="#a35cff"/></linearGradient></defs>' : '';
  return `<svg class="av" viewBox="0 0 32 32" aria-hidden="true">${defs}<rect width="32" height="32" rx="9" fill="${bg}"/>${glyph}</svg>`;
}

// ---------- providers and models ----------

const PROVIDER_META = {
  sub: { name: 'Claude', sub: 'Subscription', av: 'claude', engine: 'claude' },
  api: { name: 'Claude', sub: 'API key', av: 'claude', engine: 'claude', key: 'anthropic' },
  chatgpt: { name: 'ChatGPT', sub: 'Sign-in', av: 'chatgpt', engine: 'codex' },
  openai: { name: 'OpenAI', sub: 'API key', av: 'chatgpt', engine: 'codex', key: 'openai' },
  gemini: { name: 'Gemini', sub: 'API key', av: 'gemini', engine: 'gemini', key: 'gemini' },
  openrouter: { name: 'OpenRouter', sub: 'API key', av: 'openrouter', engine: 'claude', key: 'openrouter' },
  custom: { name: 'Custom', sub: 'API', av: 'custom', engine: 'claude', key: 'custom' },
  local: { name: 'Local', sub: 'Ollama', av: 'local', engine: 'local' },
};
const PROVIDER_ORDER = ['sub', 'api', 'chatgpt', 'openai', 'gemini', 'openrouter', 'custom', 'local'];
const CLAUDE_MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];

function splitModel(value) {
  const v = value || 'sub:';
  const i = v.indexOf(':');
  const p = i < 0 ? 'sub' : v.slice(0, i);
  if (!PROVIDER_META[p]) return { provider: 'sub', model: v };
  return { provider: p, model: i < 0 ? '' : v.slice(i + 1) };
}

function providerName(p) {
  return p === 'custom' ? (state.settings.custom?.name || 'Custom') : PROVIDER_META[p].name;
}

function modelLabel(value) {
  const { provider, model } = splitModel(value);
  const named = CLAUDE_MODELS.find(([m]) => m === model);
  const m = !model ? 'Default' : named && PROVIDER_META[provider].engine === 'claude' && ['sub', 'api'].includes(provider)
    ? named[1] : model.split('/').pop();
  return `${providerName(provider)} · ${m}`;
}

function currentModel() {
  return (state.chat ? state.chat.model : state.draft.model) || localStorage.getItem('model') || 'sub:';
}

// The team this chat uses, if any (its lead is the chat's model).
function currentTeam() {
  const id = state.chat ? state.chat.team : state.draft.team;
  return id ? (state.settings.teams || []).find(t => t.id === id) || null : null;
}

// "Local glm-4.7-flash", "Claude", "Claude Opus": short names for agent labels.
function shortModel(value) {
  const { provider, model } = splitModel(value);
  const named = CLAUDE_MODELS.find(([m]) => m === model);
  const m = named && ['sub', 'api'].includes(provider) ? named[1] : model.split('/').pop().replace(/:latest$/, '');
  return `${providerName(provider)}${m && m !== 'Default' ? ` ${m}` : ''}`;
}

function currentPermission() {
  return (state.chat ? state.chat.permission : state.draft.permission) || state.settings.defaultPermission || 'edits';
}

// Why a provider can't be used right now ('' when it's ready).
function notReadyReason(provider) {
  const c = state.conn;
  switch (provider) {
    case 'sub': return c.logins.sub?.signedIn ? '' : 'signin';
    case 'chatgpt': return c.logins.chatgpt?.signedIn ? '' : 'signin';
    case 'gemini': return !c.nodeOk ? 'node' : c.keys.gemini ? '' : 'key';
    case 'custom': return state.settings.custom?.baseUrl ? '' : 'key';
    case 'local': return c.ollama.ok ? '' : 'ollama';
    default: return c.keys[PROVIDER_META[provider].key] ? '' : 'key';
  }
}

// ---------- popover (menus) ----------

let popoverCleanup = null;

function openPopover(anchor, content, { align = 'left', className = '' } = {}) {
  closePopover();
  const p = els.popover;
  p.className = `popover ${className}`;
  p.innerHTML = '';
  p.appendChild(content);
  p.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = p.offsetWidth;
  const h = p.offsetHeight;
  let left = align === 'right' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  p.style.left = `${left}px`;
  p.style.top = `${top}px`;

  const onDown = e => { if (!p.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = e => { if (e.key === 'Escape') closePopover(); };
  setTimeout(() => document.addEventListener('mousedown', onDown), 0);
  document.addEventListener('keydown', onKey);
  popoverCleanup = () => {
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('keydown', onKey);
  };
}

function closePopover() {
  els.popover.hidden = true;
  popoverCleanup?.();
  popoverCleanup = null;
}

// Simple menu: items = [{ label, desc, icon, danger, disabled, checked, onClick } | 'sep']
function menu(items) {
  const box = el('<div></div>');
  for (const it of items) {
    if (it === 'sep') { box.appendChild(el('<div class="menu-sep"></div>')); continue; }
    if (it.note) { box.appendChild(el(`<div class="menu-note">${esc(it.note)}</div>`)); continue; }
    const b = el(`<button class="menu-item${it.danger ? ' danger' : ''}"${it.disabled ? ' disabled' : ''}>
      ${it.icon ? svg(it.icon) : ''}<span class="grow">${esc(it.label)}${it.desc ? `<span class="desc">${esc(it.desc)}</span>` : ''}</span>
      ${it.checked ? `<span class="check">${svg(ICON.ok)}</span>` : ''}</button>`);
    b.addEventListener('click', () => { closePopover(); it.onClick?.(); });
    box.appendChild(b);
  }
  return box;
}

// ---------- confirm dialog ----------

function confirmBox({ title, text, yes = 'OK', danger = false, checkbox = '' }) {
  const d = $('confirmDlg');
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmYes').textContent = yes;
  $('confirmYes').className = `btn ${danger ? 'primary danger-fill' : 'primary'}`;
  $('confirmCheckLine').hidden = !checkbox;
  $('confirmCheckText').textContent = checkbox;
  $('confirmCheck').checked = false;
  d.showModal();
  return new Promise(resolve => {
    const done = ok => {
      d.close();
      $('confirmYes').onclick = $('confirmNo').onclick = null;
      resolve(ok ? { ok: true, checked: $('confirmCheck').checked } : { ok: false });
    };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
    d.oncancel = () => done(false);
  });
}

document.querySelectorAll('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('[data-av]').forEach(n => { n.outerHTML = avatarSvg(n.dataset.av); });
