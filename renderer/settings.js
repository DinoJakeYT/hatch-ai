// Settings window: accounts, API keys, local models, permissions, instructions & memory.

const TABS = [
  ['accounts', 'Accounts', ICON.user],
  ['keys', 'API keys', ICON.key],
  ['local', 'Local models', ICON.chip],
  ['skills', 'Skills', ICON.spark],
  ['guides', 'Guides', ICON.list],
  ['teams', 'Teams', ICON.team],
  ['behavior', 'Permissions', ICON.shieldOk],
  ['memory', 'Instructions & memory', ICON.book],
  ['phone', 'Phone', ICON.phone],
  ['about', 'About & updates', ICON.download],
];

const KEY_CARDS = [
  ['anthropic', 'api', 'Claude API key', 'console.anthropic.com', 'sk-ant-…'],
  ['openai', 'openai', 'OpenAI API key', 'platform.openai.com', 'sk-…'],
  ['gemini', 'gemini', 'Gemini API key', 'aistudio.google.com (has a free tier)', 'AIza…'],
  ['openrouter', 'openrouter', 'OpenRouter key', 'openrouter.ai — one key for hundreds of models', 'sk-or-…'],
];

function setStatus(node, text, kind) {
  node.textContent = text;
  node.className = `status-text${kind ? ` ${kind}` : ''}`;
}

function showTab(name) {
  document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  document.querySelectorAll('.panes .pane').forEach(p => p.classList.toggle('on', p.dataset.pane === name));
}

$('tabs').innerHTML = TABS.map(([k, label, icon]) => `<button class="tab" data-tab="${k}">${svg(icon)}${esc(label)}</button>`).join('');
const PANE_LOADERS = {
  memory: () => loadMemoryPane(),
  guides: () => loadGuidesPane(),
  local: () => { loadToolchain(); loadLibs(); loadModels(); },
  skills: () => loadSkills(),
  teams: () => renderTeamsPane(),
  about: () => renderUpdate(),
  phone: () => loadPhone(),
};

document.querySelectorAll('#tabs .tab').forEach(t => t.addEventListener('click', () => {
  showTab(t.dataset.tab);
  PANE_LOADERS[t.dataset.tab]?.();
}));

async function openSettings(tab = 'accounts') {
  closePopover();
  renderSettingsAll();
  showTab(tab);
  PANE_LOADERS[tab]?.();
  $('settings').showModal();
}

function renderSettingsAll() {
  renderSettingsAccounts();
  renderKeyCards();
  renderLocalPane();
  renderBehaviorPane();
  const s = state.settings;
  $('customName').value = s.custom?.name || '';
  $('customUrl').value = s.custom?.baseUrl || '';
  $('customModels').value = s.custom?.models || '';
  for (const k of ['chatgpt', 'openai', 'gemini']) $(`extra-${k}`).value = s.extraModels?.[k] || '';
}

// ---------- accounts ----------

function renderSettingsAccounts() {
  for (const p of ['sub', 'chatgpt']) {
    const box = $(`acct-${p}`);
    const st = state.conn.logins[p] || {};
    const signing = state.signingIn === p;
    const err = state.signInError[p];
    const plan = st.plan ? ` · ${st.plan[0].toUpperCase()}${st.plan.slice(1)} plan` : '';
    const statusText = signing ? 'Finish signing in in the sign-in window…' : st.signedIn ? `Signed in${plan}` : err || 'Not signed in';
    box.innerHTML = `
      <div class="title-line">${avatarSvg(PROVIDER_META[p].av)}${p === 'sub' ? 'Claude' : 'ChatGPT'}
        <span class="st ${st.signedIn ? 'good' : err ? 'bad' : ''}">${esc(statusText)}</span></div>
      <p class="hint">${p === 'sub' ? 'Uses your Claude Pro or Max plan through Claude Code.' : 'Uses your ChatGPT Plus or Pro plan through OpenAI Codex.'}</p>
      <div class="line">
        ${st.signedIn ? '<button class="btn" data-a="out">Sign out</button>' : `<button class="btn primary" data-a="in"${signing ? ' disabled' : ''}>Sign in</button>`}
        ${signing ? '<button class="btn" data-a="browser">Use my browser instead</button><button class="btn" data-a="cancel">Cancel</button>' : ''}
      </div>`;
    box.querySelector('[data-a="in"]')?.addEventListener('click', () => startSignIn(p));
    box.querySelector('[data-a="browser"]')?.addEventListener('click', () => api.signInWithBrowser());
    box.querySelector('[data-a="cancel"]')?.addEventListener('click', () => api.cancelSignIn());
    box.querySelector('[data-a="out"]')?.addEventListener('click', async () => {
      const r = await confirmBox({ title: `Sign out of ${p === 'sub' ? 'Claude' : 'ChatGPT'}?`, text: 'This also signs out the command-line tool on this PC.', yes: 'Sign out' });
      if (!r.ok) return;
      state.conn.logins[p] = await api.signOut(p);
      renderSettingsAccounts();
      renderHeader();
    });
  }
}

api.onAuthEvent(ev => {
  if (state.signingIn === ev.provider) state.signingIn = null;
  if (ev.status) state.conn.logins[ev.provider] = ev.status;
  if (!ev.ok) state.signInError[ev.provider] = ev.message;
  else delete state.signInError[ev.provider];
  renderSettingsAccounts();
  renderHeader();
  if (ev.ok) { loadUsage(true); els.input.focus(); }
});

// ---------- API keys ----------

function renderKeyCards() {
  $('keyCards').innerHTML = '';
  for (const [name, provider, title, where, placeholder] of KEY_CARDS) {
    const hint = state.conn.keys[name];
    const card = el(`
      <div class="card-set" style="margin-bottom:12px">
        <div class="title-line">${avatarSvg(PROVIDER_META[provider].av)}${esc(title)}
          <span class="st ${hint ? 'good' : ''}">${hint ? `Saved (ends in ${esc(hint)})` : 'Not set'}</span></div>
        <p class="hint">Get one at ${esc(where)}.</p>
        <div class="line">
          <input type="password" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
          <button class="btn primary" data-a="save">Save</button>
          <button class="btn" data-a="remove"${hint ? '' : ' disabled'}>Remove</button>
        </div>
      </div>`);
    const input = card.querySelector('input');
    card.querySelector('[data-a="save"]').addEventListener('click', async () => {
      if (!input.value.trim()) return input.focus();
      state.conn.keys[name] = await api.setKey(name, input.value);
      input.value = '';
      renderKeyCards();
      renderHeader();
      loadUsage(true);
    });
    card.querySelector('[data-a="remove"]').addEventListener('click', async () => {
      state.conn.keys[name] = await api.setKey(name, '');
      renderKeyCards();
      renderHeader();
    });
    $('keyCards').appendChild(card);
  }
  const customKey = state.conn.keys.custom;
  // the custom provider's key lives with its other fields
  if (!$('customKey')) {
    const line = el(`<label class="field">API key<input type="password" id="customKey" autocomplete="off" spellcheck="false"></label>`);
    $('customModels').closest('.field').after(line);
  }
  $('customKey').placeholder = customKey ? `Saved (ends in ${customKey}) — type to replace` : 'Key for this provider';
}

$('customSave').addEventListener('click', async () => {
  const custom = { name: $('customName').value.trim() || 'Custom', baseUrl: $('customUrl').value.trim(), models: $('customModels').value.trim() };
  await api.setSettings({ custom });
  state.settings.custom = custom;
  if ($('customKey').value.trim()) {
    state.conn.keys.custom = await api.setKey('custom', $('customKey').value);
    $('customKey').value = '';
  }
  renderKeyCards();
  setStatus($('customStatus'), 'Saved', 'good');
  renderHeader();
});

$('extraSave').addEventListener('click', async () => {
  const extraModels = Object.fromEntries(['chatgpt', 'openai', 'gemini'].map(k => [k, $(`extra-${k}`).value.trim()]));
  await api.setSettings({ extraModels });
  state.settings.extraModels = extraModels;
  setStatus($('extraStatus'), 'Saved', 'good');
});

// ---------- local ----------

function renderLocalPane() {
  if (document.activeElement !== $('ollamaUrl')) $('ollamaUrl').value = state.settings.ollamaUrl || 'http://localhost:11434';
  const o = state.conn.ollama;
  const builders = o.models.filter(m => m.tools).length;
  setStatus($('ollamaStatus'), o.ok ? `Connected · ${o.models.length} models, ${builders} can build things` : o.error || 'Not checked yet', o.ok ? 'good' : 'bad');
  const vis = o.models.filter(m => m.vision);
  $('visionModel').innerHTML = `<option value="">${vis.length ? `Automatic (${esc(vis[0].name)})` : 'None installed (ollama pull moondream)'}</option>`
    + vis.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
  $('visionModel').value = vis.some(m => m.name === state.settings.visionModel) ? state.settings.visionModel : '';
  const engine = state.settings.localEngine || 'hatch';
  document.querySelectorAll('input[name="localEngine"]').forEach(r => { r.checked = r.value === engine; });
  $('localContext').value = state.settings.localContext || 32768;
  $('localThinking').value = state.settings.localThinking || 'auto';
  const sel = $('compressModel');
  const cur = state.settings.memory?.compressModel || '';
  sel.innerHTML = '<option value="">Choose a local model…</option>' + o.models.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
  sel.value = o.models.some(m => m.name === cur) ? cur : '';
}

$('ollamaCheck').addEventListener('click', async () => {
  setStatus($('ollamaStatus'), 'Checking…');
  await api.setSettings({ ollamaUrl: $('ollamaUrl').value });
  state.settings.ollamaUrl = $('ollamaUrl').value.trim();
  await loadConnections();
  renderLocalPane();
});

document.querySelectorAll('input[name="localEngine"]').forEach(r => r.addEventListener('change', () => {
  state.settings.localEngine = r.value;
  api.setSettings({ localEngine: r.value });
}));
$('visionModel').addEventListener('change', () => {
  state.settings.visionModel = $('visionModel').value;
  api.setSettings({ visionModel: $('visionModel').value });
});
$('localThinking').addEventListener('change', () => {
  state.settings.localThinking = $('localThinking').value;
  api.setSettings({ localThinking: $('localThinking').value });
});
$('localContext').addEventListener('change', () => {
  const v = Math.max(4096, Number($('localContext').value) || 32768);
  state.settings.localContext = v;
  api.setSettings({ localContext: v });
});

async function loadToolchain(refresh = false) {
  setStatus($('toolchainStatus'), refresh ? 'Checking this PC’s tools…' : $('toolchainStatus').textContent);
  const t = await api.toolchain({ refresh });
  const names = [t.msvc, ...t.tools.filter(x => !['py', 'npm', 'java', 'ninja', 'mingw32-make'].includes(x))].filter(Boolean);
  setStatus($('toolchainStatus'), `Tools found on this PC: ${names.join(', ') || 'none'}`, 'good');
}
$('toolchainRefresh').addEventListener('click', () => loadToolchain(true));

// ---------- local model manager ----------

const pulling = new Map();   // model name -> { status, pct } while it downloads
const FIT = {
  fast: ['good', 'Fits your graphics card: fast'],
  slower: ['warn', 'Partly runs on the CPU: slower'],
  slow: ['bad', 'Mostly runs on the CPU: slow'],
};
const CAPS = { tools: 'builds things', vision: 'sees images', thinking: 'thinks' };
let modelInfo = null;

async function loadModels() {
  modelInfo = await api.localModels();
  renderModels();
}

const fitBadge = f => (f ? `<span class="badge ${FIT[f][0]}">${FIT[f][1]}</span>` : '');
const pullText = p => `${/^pulling [0-9a-f]/i.test(p.status || '') ? 'Downloading' : p.status ? p.status[0].toUpperCase() + p.status.slice(1) : 'Starting'}${p.pct != null ? ` · ${p.pct}%` : ''}`;
const pullBar = name => {
  const p = pulling.get(name);
  return p ? `<div class="pull" data-pull="${esc(name)}"><div class="bar"><i style="width:${p.pct || 0}%"></i></div><span>${esc(pullText(p))}</span><button class="btn" data-cancel="${esc(name)}">Cancel</button></div>` : '';
};

function renderModels() {
  const info = modelInfo;
  if (!info) return;
  $('gpuInfo').textContent = info.gpu ? `${info.gpu.name} · ${Math.round(info.gpu.vram)} GB` : '';
  const mine = $('modelList');
  mine.innerHTML = !info.ok ? '<p class="hint">Can\'t reach Ollama. Start it, then reopen this page.</p>'
    : info.installed.length ? '' : '<p class="hint">No models yet. Download one below.</p>';
  for (const m of info.installed) {
    const row = el(`
      <div class="model-row">
        <div class="grow"><b></b> <span class="meta"></span>
          <div class="badges">${fitBadge(m.fit)}${m.caps.filter(c => CAPS[c]).map(c => `<span class="badge">${CAPS[c]}</span>`).join('')}</div></div>
        <button class="btn danger">Delete</button>
      </div>`);
    row.querySelector('b').textContent = m.name;
    row.querySelector('.meta').textContent = `${m.params ? `${m.params} · ` : ''}${m.size.toFixed(1)} GB`;
    row.querySelector('.btn').addEventListener('click', async () => {
      const r = await confirmBox({ title: `Delete ${m.name}?`, text: `This frees up to ${m.size.toFixed(1)} GB on your PC (less if another model was made from it). You can download it again any time.`, yes: 'Delete', danger: true });
      if (!r.ok) return;
      const res = await api.deleteModel(m.name);
      setStatus($('modelStatus'), res.error || `Deleted ${m.name}.`, res.error ? 'bad' : 'good');
      await modelsChanged();
    });
    mine.appendChild(row);
  }

  const recs = $('modelRecs');
  recs.innerHTML = '';
  for (const r of info.recommended.filter(x => !x.installed)) {
    const row = el(`
      <div class="model-row">
        <div class="grow"><b></b> <span class="meta">about ${r.size} GB</span><div class="desc"></div>
          <div class="badges">${fitBadge(r.fit)}</div>${pullBar(r.name)}</div>
        ${pulling.has(r.name) ? '' : '<button class="btn primary">Download</button>'}
      </div>`);
    row.querySelector('b').textContent = r.name;
    row.querySelector('.desc').textContent = r.what;
    row.querySelector('.btn.primary')?.addEventListener('click', () => startPull(r.name));
    recs.appendChild(row);
  }
  // downloads typed in by name
  for (const name of pulling.keys()) {
    if (info.recommended.some(r => r.name === name)) continue;
    const row = el(`<div class="model-row"><div class="grow"><b></b>${pullBar(name)}</div></div>`);
    row.querySelector('b').textContent = name;
    recs.appendChild(row);
  }
  recs.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => api.cancelPull(b.dataset.cancel)));
}

async function startPull(name) {
  if (!name || pulling.has(name)) return;
  pulling.set(name, { status: '', pct: 0 });
  renderModels();
  const r = await api.pullModel(name);
  pulling.delete(name);
  setStatus($('modelStatus'), r.error ? `${name}: ${r.error}` : `${name} is ready. Pick it in the AI menu.`, r.error ? 'bad' : 'good');
  await modelsChanged();
}

// the AI menu and the rest of Hatch learn about the change too
async function modelsChanged() {
  await loadConnections(true);
  await loadModels();
}

// progress only moves the bar, so the page doesn't jump around while it downloads
api.onPullProgress(p => {
  if (p.done || p.error || !pulling.has(p.name)) return;
  pulling.set(p.name, { status: p.status, pct: p.pct });
  const box = document.querySelector(`.pull[data-pull="${CSS.escape(p.name)}"]`);
  if (!box) return renderModels();
  box.querySelector('.bar i').style.width = `${p.pct || 0}%`;
  box.querySelector('span').textContent = pullText(p);
});

$('modelPull').addEventListener('click', () => {
  const name = $('modelName').value.trim();
  if (!name) return $('modelName').focus();
  $('modelName').value = '';
  startPull(name);
});
$('modelName').addEventListener('keydown', e => { if (e.key === 'Enter') $('modelPull').click(); });

// ---------- raylib ----------

async function loadLibs() {
  const { raylib } = await api.libsStatus();
  $('raylibStatus').textContent = raylib ? `Installed (${raylib.version})` : 'Not installed';
  $('raylibStatus').className = `st${raylib ? ' good' : ''}`;
  $('raylibInstall').textContent = raylib ? 'Reinstall / update' : 'Install raylib';
}

$('raylibInstall').addEventListener('click', async () => {
  $('raylibInstall').disabled = true;
  try {
    await api.installRaylib();
    setStatus($('raylibProgress'), 'Installed. AIs can now make raylib games.', 'good');
  } catch (err) {
    setStatus($('raylibProgress'), cleanErr(err), 'bad');
  }
  $('raylibInstall').disabled = false;
  loadLibs();
  loadToolchain();
});
api.onLibsProgress(msg => setStatus($('raylibProgress'), msg));

const cleanErr = err => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------- skills ----------

let foundSkills = null;

async function loadSkills() {
  const list = await api.listSkills();
  const box = $('skillList');
  box.innerHTML = list.length ? '' : '<p class="hint">No skills yet. Import some from GitHub or a folder.</p>';
  for (const s of list) {
    const row = el(`
      <div class="skill-row${s.enabled ? '' : ' off'}">
        <div class="grow"><b></b><span class="desc"></span><span class="src"></span></div>
        <label class="switch-label"><input type="checkbox"${s.enabled ? ' checked' : ''}> On</label>
        <button class="btn" data-a="edit">Edit</button>
        <button class="btn danger">Delete</button>
      </div>`);
    row.querySelector('[data-a="edit"]').addEventListener('click', async () => {
      const skill = await api.getSkill(s.name);
      if (skill) openSkillEditor(skill, { title: `Edit ${skill.name}`, previous: skill.name });
    });
    row.querySelector('b').textContent = s.title;
    row.querySelector('.desc').textContent = s.description || '';
    // a link or folder it came from, or how it was made ("Made in Hatch", "Proposed by Claude in ...")
    row.querySelector('.src').textContent = !s.source ? '' : /^(https?:|[a-z]:[\\/])/i.test(s.source) ? `From ${s.source}` : s.source;
    row.querySelector('input').addEventListener('change', async e => { await api.setSkillEnabled(s.name, e.target.checked); loadSkills(); });
    row.querySelector('.btn.danger').addEventListener('click', async () => {
      const r = await confirmBox({ title: `Delete "${s.title}"?`, text: 'Its folder goes to the Recycle Bin.', yes: 'Delete', danger: true });
      if (r.ok) { await api.removeSkill(s.name); loadSkills(); }
    });
    box.appendChild(row);
  }
}

$('skillFind').addEventListener('click', async () => {
  const url = $('skillUrl').value.trim();
  if (!url) return $('skillUrl').focus();
  $('skillFound').innerHTML = '';
  $('skillImportLine').hidden = true;
  setStatus($('skillFindStatus'), 'Looking for skills…');
  try {
    foundSkills = await api.findSkills(url);
    const n = foundSkills.skills.length;
    setStatus($('skillFindStatus'), n ? `Found ${n} skill${n === 1 ? '' : 's'} in ${foundSkills.repo.owner}/${foundSkills.repo.repo}${foundSkills.truncated ? ' (big repo: some may be missing)' : ''}` : 'No SKILL.md files there.', n ? 'good' : 'bad');
    for (const [i, s] of foundSkills.skills.entries()) {
      const row = el(`<label class="found"><input type="checkbox" data-i="${i}"${n === 1 ? ' checked' : ''}><div><b></b><span class="desc"></span></div></label>`);
      row.querySelector('b').textContent = s.name;
      row.querySelector('.desc').textContent = s.description || s.dir || '';
      $('skillFound').appendChild(row);
    }
    $('skillImportLine').hidden = !n;
  } catch (err) {
    setStatus($('skillFindStatus'), cleanErr(err), 'bad');
  }
});
$('skillUrl').addEventListener('keydown', e => { if (e.key === 'Enter') $('skillFind').click(); });
$('skillAll').addEventListener('click', () => $('skillFound').querySelectorAll('input').forEach(i => { i.checked = true; }));

$('skillImport').addEventListener('click', async () => {
  const picks = [...$('skillFound').querySelectorAll('input:checked')].map(i => foundSkills.skills[Number(i.dataset.i)]);
  if (!picks.length) return;
  $('skillImport').disabled = true;
  setStatus($('skillFindStatus'), `Importing ${picks.length}…`);
  try {
    const names = await api.installSkills(foundSkills.repo, picks);
    setStatus($('skillFindStatus'), `Imported: ${names.join(', ')}`, 'good');
    $('skillFound').innerHTML = '';
    $('skillImportLine').hidden = true;
  } catch (err) {
    setStatus($('skillFindStatus'), cleanErr(err), 'bad');
  }
  $('skillImport').disabled = false;
  loadSkills();
});

$('skillFolder').addEventListener('click', async () => {
  try {
    const names = await api.importSkillFolder();
    if (names) setStatus($('skillFolderStatus'), `Imported: ${names.join(', ')}`, 'good');
  } catch (err) {
    setStatus($('skillFolderStatus'), cleanErr(err), 'bad');
  }
  loadSkills();
});
$('skillOpen').addEventListener('click', () => api.openSkills());

// ---------- writing a skill (a new one, an edit, or an AI's proposal before approving it) ----------

let skillEditor = null;   // { previous, onSave }

function openSkillEditor({ name = '', description = '', body = '' } = {}, { title = 'New skill', previous = null, onSave = null } = {}) {
  $('skillDlgTitle').textContent = title;
  $('skillName').value = name;
  $('skillDesc').value = description;
  $('skillBody').value = body;
  setStatus($('skillDlgStatus'), '');
  skillEditor = { previous, onSave: onSave || (data => api.saveSkill(data)) };
  $('skillDlg').showModal();
  (name ? $('skillBody') : $('skillName')).focus();
}

$('skillDlgSave').addEventListener('click', async () => {
  const data = { name: $('skillName').value, description: $('skillDesc').value, body: $('skillBody').value, previous: skillEditor.previous };
  const r = await skillEditor.onSave(data);
  if (r?.error) return setStatus($('skillDlgStatus'), r.error, 'bad');
  $('skillDlg').close();
  if ($('settings').open) loadSkills();
});

$('skillNew').addEventListener('click', () => openSkillEditor());

// ---------- guides ----------

async function loadGuidesPane(select) {
  const names = await api.listGuides();
  const sel = $('guideSelect');
  const cur = select || sel.value || names[0];
  sel.innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n.replace(/\.md$/, ''))}</option>`).join('');
  sel.value = names.includes(cur) ? cur : names[0];
  $('guideText').value = await api.getGuide(sel.value);
  setStatus($('guideStatus'), '');
}

$('guideSelect').addEventListener('change', async () => {
  $('guideText').value = await api.getGuide($('guideSelect').value);
  setStatus($('guideStatus'), '');
});
$('guideSave').addEventListener('click', async () => {
  await api.setGuide($('guideSelect').value, $('guideText').value);
  setStatus($('guideStatus'), 'Saved', 'good');
});
$('guideNew').addEventListener('click', async () => {
  const name = await api.setGuide(`guide-${Date.now().toString(36)}`, 'keywords: unity, c#\n# My guide\n- Step-by-step tips for this kind of project.\n');
  await loadGuidesPane(name);
  setStatus($('guideStatus'), 'New guide created: set its keywords on the first line, then Save.', 'good');
});
$('guideFolder').addEventListener('click', () => api.openGuides());

// ---------- teams ----------

// Every model Hatch can run, grouped by AI; leads can't be Gemini (it can't be given the delegate tool).
function modelOptions(selected, { lead = false } = {}) {
  let found = false;
  let html = '';
  for (const p of PROVIDER_ORDER) {
    if (lead && PROVIDER_META[p].engine === 'gemini') continue;
    const rows = modelsFor(p).filter(r => !r.disabled);
    if (!rows.length) continue;
    html += `<optgroup label="${esc(`${providerName(p)} · ${PROVIDER_META[p].sub}`)}">${rows.map(r => {
      if (r.value === selected) found = true;
      return `<option value="${esc(r.value)}"${r.value === selected ? ' selected' : ''}>${esc(`${providerName(p)} ${r.label}`)}</option>`;
    }).join('')}</optgroup>`;
  }
  if (selected && !found) html = `<option value="${esc(selected)}" selected>${esc(shortModel(selected))}</option>${html}`;
  return html;
}

// The biggest local model that can use tools and still runs well on a PC.
function bestLocalModel() {
  const size = m => parseFloat(m.size) * (/M$/i.test(m.size) ? 0.001 : 1) || 0;
  return state.conn.ollama.models.filter(m => m.tools && size(m) <= 40).sort((a, b) => size(b) - size(a))[0]?.name || '';
}

function starterTeam(name) {
  const local = bestLocalModel();
  return {
    id: crypto.randomUUID(),
    name,
    lead: notReadyReason('sub') ? (notReadyReason('api') ? 'chatgpt:' : 'api:') : 'sub:',
    helpers: [{ name: 'Coder', model: local ? `local:${local}` : 'sub:haiku', role: 'Writes the code, builds it and fixes build errors' }],
  };
}

function saveTeams(list) {
  // helper names must be unique within a team: they're how the lead calls them
  for (const t of list) {
    const seen = new Set();
    t.name = t.name.trim() || 'Team';
    for (const [i, h] of t.helpers.entries()) {
      let n = h.name.trim().replace(/["<>]/g, '') || `Helper ${i + 1}`;
      while (seen.has(n.toLowerCase())) n += ' 2';
      seen.add(n.toLowerCase());
      h.name = n;
    }
  }
  state.settings.teams = list;
  api.setSettings({ teams: list });
  renderHeader();
}

function renderTeamsPane() {
  const box = $('teamList');
  const list = state.settings.teams || [];
  box.innerHTML = list.length ? '' : '<p class="hint">No teams yet.</p>';
  for (const t of list) box.appendChild(teamCard(t, list));
}

function teamCard(t, list) {
  const card = el(`
    <div class="card-set team-card">
      <div class="line"><input type="text" class="team-name" spellcheck="false" placeholder="Team name"><button class="btn danger" data-a="del">Delete team</button></div>
      <label class="field">Lead: plans, hands out tasks and checks the work<select class="team-lead">${modelOptions(t.lead, { lead: true })}</select></label>
      <div class="field">Helpers: do the tasks the lead gives them</div>
      <div class="helpers"></div>
      <p class="hint team-warn" hidden></p>
      <div class="line"><button class="btn" data-a="add">Add helper</button></div>
      <label class="check-line"><input type="checkbox" class="team-par"> Helpers can work at the same time (a busy helper gets a copy, up to 3)</label>
    </div>`);
  const save = () => saveTeams(list);
  const name = card.querySelector('.team-name');
  name.value = t.name;
  name.addEventListener('change', () => { t.name = name.value; save(); });
  card.querySelector('.team-lead').addEventListener('change', e => { t.lead = e.target.value; save(); });
  const par = card.querySelector('.team-par');
  par.checked = t.parallel !== false;
  par.addEventListener('change', () => { t.parallel = par.checked; save(); });
  card.querySelector('[data-a="del"]').addEventListener('click', async () => {
    const r = await confirmBox({ title: `Delete "${t.name}"?`, text: 'Chats using this team go back to using its lead on its own.', yes: 'Delete', danger: true });
    if (!r.ok) return;
    list.splice(list.indexOf(t), 1);
    save();
    renderTeamsPane();
  });
  card.querySelector('[data-a="add"]').addEventListener('click', () => {
    const reviewer = !t.helpers.some(h => h.name === 'Reviewer');
    t.helpers.push(reviewer
      ? { name: 'Reviewer', model: t.lead, role: 'Reviews and tests the work, and reports problems', canEdit: false }
      : { name: `Helper ${t.helpers.length + 1}`, model: t.lead, role: '' });
    save();
    renderTeamsPane();
  });

  // local models share the GPU: different ones keep swapping in and out of memory, which is slow
  const localModels = new Set([t.lead, ...t.helpers.map(h => h.model)].filter(m => splitModel(m).provider === 'local'));
  const warn = card.querySelector('.team-warn');
  warn.hidden = localModels.size < 2;
  warn.textContent = `Local models take turns on your GPU, and switching between ${[...localModels].map(shortModel).join(' and ')} reloads them each time (slow). Using one local model for every local role is much faster.`;
  const helpers = card.querySelector('.helpers');
  for (const h of t.helpers) {
    const row = el(`
      <div class="helper-row">
        <input type="text" class="h-name" spellcheck="false" placeholder="Name">
        <select class="h-model">${modelOptions(h.model)}</select>
        <input type="text" class="h-role" spellcheck="false" placeholder="What they do">
        <button class="icon-btn" title="Remove helper"${t.helpers.length < 2 ? ' disabled' : ''}>${svg(ICON.err)}</button>
        <label class="check-line h-edit"><input type="checkbox"> Can change files (turn off for reviewers: they can read, build and run, and report what to fix)</label>
      </div>`);
    row.querySelector('.h-name').value = h.name;
    row.querySelector('.h-role').value = h.role || '';
    row.querySelector('.h-name').addEventListener('change', e => { h.name = e.target.value; save(); e.target.value = h.name; });
    row.querySelector('.h-model').addEventListener('change', e => { h.model = e.target.value; save(); });
    row.querySelector('.h-role').addEventListener('change', e => { h.role = e.target.value.trim(); save(); });
    const canEdit = row.querySelector('.h-edit input');
    canEdit.checked = h.canEdit !== false;
    canEdit.addEventListener('change', () => { h.canEdit = canEdit.checked; save(); });
    row.querySelector('.icon-btn').addEventListener('click', () => {
      t.helpers.splice(t.helpers.indexOf(h), 1);
      save();
      renderTeamsPane();
    });
    helpers.appendChild(row);
  }
  return card;
}

$('teamNew').addEventListener('click', () => {
  const list = state.settings.teams || [];
  list.push(starterTeam(`Team ${list.length + 1}`));
  saveTeams(list);
  renderTeamsPane();
  const names = $('teamList').querySelectorAll('.team-name');
  names[names.length - 1]?.select();
});

// ---------- phone ----------

async function loadPhone(status) {
  const s = status || await api.phoneStatus();
  $('phoneOn').checked = s.enabled;
  $('phoneBox').hidden = !s.enabled;
  if (document.activeElement !== $('phonePort')) $('phonePort').value = s.port;
  const codes = $('phoneCodes');
  codes.innerHTML = '';
  if (s.enabled && !s.running) codes.appendChild(el(`<p class="hint">${esc(s.error || 'Starting…')}</p>`));
  else if (s.running && !s.urls.length) codes.appendChild(el('<p class="hint">This PC isn\'t connected to a network right now.</p>'));
  for (const u of s.urls) {
    // the QR code is made by Hatch itself (lib/remote.mjs)
    const card = el(`<div class="phone-code"><div class="qr">${u.qr}</div><b>${u.kind === 'tailscale' ? 'Anywhere (Tailscale)' : 'Home network'}</b><span class="addr"></span><button class="btn">Copy link</button></div>`);
    card.querySelector('.addr').textContent = `${u.address}:${s.port}`;
    card.querySelector('.btn').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(u.url); setStatus($('phoneStatus'), 'Link copied. Only send it to yourself: it includes the key.', 'good'); } catch {}
    });
    codes.appendChild(card);
  }
  if (s.running) setStatus($('phoneStatus'), s.phones ? `${s.phones} phone${s.phones === 1 ? '' : 's'} connected now` : 'Waiting for your phone…', s.phones ? 'good' : '');
}

$('phoneOn').addEventListener('change', async () => loadPhone(await api.setPhone({ enabled: $('phoneOn').checked })));
$('phonePort').addEventListener('change', async () => loadPhone(await api.setPhone({ port: Number($('phonePort').value) })));
$('phoneReset').addEventListener('click', async () => {
  const r = await confirmBox({ title: 'Disconnect all phones?', text: 'Hatch makes a new code. Phones that were connected have to scan it again.', yes: 'Disconnect', danger: true });
  if (r.ok) loadPhone(await api.resetPhoneKey());
});
api.onPhoneChanged(() => { if ($('settings').open) loadPhone(); });

// ---------- about and updates ----------

let appInfo = null;
let updateStatus = { state: 'idle' };

function updateText(s) {
  switch (s.state) {
    case 'source': return 'Running from the source code: get updates with git pull';
    case 'checking': return 'Checking…';
    case 'latest': return 'You have the latest version';
    case 'downloading': return `Downloading Hatch ${s.version || ''}… ${s.percent || 0}%`;
    case 'ready': return `Hatch ${s.version} is ready to install`;
    case 'error': return /404|latest\.yml|no published versions/i.test(s.message || '') ? 'No release on GitHub yet' : `Couldn't check for updates: ${s.message}`;
    default: return '';
  }
}

function renderUpdate() {
  const s = updateStatus;
  if (appInfo) $('aboutVersion').textContent = appInfo.version;
  $('updateState').textContent = updateText(s);
  $('updateState').className = `st${s.state === 'ready' || s.state === 'latest' ? ' good' : s.state === 'error' ? ' bad' : ''}`;
  $('updateCheck').disabled = ['source', 'checking', 'downloading', 'ready'].includes(s.state);
  $('updateInstall').hidden = s.state !== 'ready';
  // the sidebar shows a ready update too, so it's not missed
  els.updateBtn.hidden = s.state !== 'ready';
  els.updateBtn.innerHTML = s.state === 'ready' ? `${svg(ICON.download)}<span>Hatch ${esc(s.version)} is ready · Restart</span>` : '';
}

async function installUpdate() {
  const busy = state.chats.filter(c => c.running);
  if (busy.length) {
    const r = await confirmBox({
      title: 'Restart now?',
      text: `${busy.length === 1 ? 'An AI is' : 'AIs are'} still working (${busy.map(c => `"${c.title}"`).join(', ')}). Restarting stops ${busy.length === 1 ? 'it' : 'them'}. The update also installs by itself the next time you close Hatch.`,
      yes: 'Restart and update', danger: true,
    });
    if (!r.ok) return;
  }
  api.installUpdate();
}

$('updateCheck').addEventListener('click', async () => { updateStatus = await api.checkForUpdate(); renderUpdate(); });
$('updateInstall').addEventListener('click', installUpdate);
els.updateBtn.addEventListener('click', installUpdate);
api.onUpdateStatus(s => { updateStatus = s; renderUpdate(); });
(async () => {
  [appInfo, updateStatus] = await Promise.all([api.appInfo(), api.updateStatus()]);
  renderUpdate();
})();

// ---------- permissions ----------

function renderBehaviorPane() {
  const cur = state.settings.defaultPermission || 'edits';
  $('defaultPerms').innerHTML = Object.entries(PERMS).map(([k, p]) => `
    <label class="perm-opt"><input type="radio" name="defPerm" value="${k}"${k === cur ? ' checked' : ''}>
      <div><b>${esc(p.label)}</b><span>${esc(p.desc)}</span></div></label>`).join('');
  $('defaultPerms').querySelectorAll('input').forEach(i => i.addEventListener('change', () => {
    state.settings.defaultPermission = i.value;
    api.setSettings({ defaultPermission: i.value });
    renderHeader();
  }));
  $('showMeter').checked = state.settings.showUsageMeter !== false;
}

$('showMeter').addEventListener('change', () => {
  state.settings.showUsageMeter = $('showMeter').checked;
  api.setSettings({ showUsageMeter: $('showMeter').checked });
  renderUsageMeter();
});

// ---------- instructions & memory ----------

async function loadMemoryPane() {
  const m = await api.getMemory();
  $('instrText').value = m.instructions;
  $('memText').value = m.memory;
  $('compressAt').value = state.settings.memory?.compressAt || 8000;
  $('autoCompress').checked = !!state.settings.memory?.autoCompress;
  setStatus($('instrStatus'), `${m.instructions.length} characters`);
  setStatus($('memStatus'), `${m.memory.length} characters`);
}

function wireMemory(kind, prefix) {
  const text = $(`${prefix}Text`);
  const status = $(`${prefix}Status`);
  $(`${prefix}Save`).addEventListener('click', async () => {
    await api.setMemory(kind, text.value);
    setStatus(status, `Saved · ${text.value.length} characters`, 'good');
  });
  $(`${prefix}Open`).addEventListener('click', () => api.openMemory(kind));
  $(`${prefix}Compress`).addEventListener('click', async () => {
    const model = $('compressModel').value;
    if (!model) { setStatus(status, 'Pick a local model below first.', 'bad'); return; }
    await api.setMemory(kind, text.value);
    setStatus(status, `Compressing with ${model}…`);
    try {
      const r = await api.compressMemory(kind, model);
      const ok = await confirmBox({
        title: 'Use the compressed version?',
        text: `${model} shortened it from ${r.before} to ${r.after} characters. The old version is kept as a backup file.`,
        yes: 'Use it',
      });
      if (!ok.ok) { setStatus(status, 'Kept the original'); return; }
      await api.saveCompressed(kind, r.text);
      text.value = r.text;
      setStatus(status, `Compressed · ${r.text.length} characters (backup saved)`, 'good');
    } catch (err) {
      setStatus(status, String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'bad');
    }
  });
}
wireMemory('instructions', 'instr');
wireMemory('memory', 'mem');

function saveMemorySettings() {
  const memory = {
    ...state.settings.memory,
    compressModel: $('compressModel').value,
    compressAt: Math.max(1000, Number($('compressAt').value) || 8000),
    autoCompress: $('autoCompress').checked,
  };
  state.settings.memory = memory;
  api.setSettings({ memory });
}
['compressModel', 'compressAt', 'autoCompress'].forEach(id => $(id).addEventListener('change', saveMemorySettings));

api.onMemoryChanged(() => { if ($('settings').open) loadMemoryPane(); });
