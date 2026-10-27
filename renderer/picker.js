// "Which AI" picker and the permissions menu in the top bar.

let openRouterCatalog = null;

function modelsFor(provider) {
  const extra = key => (state.settings.extraModels?.[key] || '').split(',').map(s => s.trim()).filter(Boolean);
  switch (provider) {
    case 'sub': return CLAUDE_MODELS.map(([m, t]) => ({ value: `sub:${m}`, label: t }));
    case 'api': return CLAUDE_MODELS.slice(1).map(([m, t]) => ({ value: `api:${m}`, label: t }));
    case 'chatgpt':
    case 'openai':
    case 'gemini':
      return [{ value: `${provider}:`, label: 'Default' }, ...extra(provider).map(m => ({ value: `${provider}:${m}`, label: m }))];
    case 'openrouter':
      return (state.settings.favorites?.openrouter || []).map(id => ({ value: `openrouter:${id}`, label: id, star: true }));
    case 'custom':
      return (state.settings.custom?.models || '').split(',').map(s => s.trim()).filter(Boolean).map(m => ({ value: `custom:${m}`, label: m }));
    case 'local': {
      // Hatch's own tools work with any model; Claude Code's tools need native tool support
      const strict = state.settings.localEngine === 'claude';
      return [...state.conn.ollama.models].sort((a, b) => b.tools - a.tools).map(m => ({
        value: `local:${m.name}`, label: m.name, tag: m.size, disabled: strict && !m.tools, why: strict && !m.tools ? "can't build" : '',
      }));
    }
    default: return [];
  }
}

function limitTag(provider) {
  const L = state.usage.limits;
  const w = Object.fromEntries(liveWindows(provider === 'sub' ? L.sub : provider === 'chatgpt' ? L.chatgpt : null));
  if (!w.five_hour) return '';
  return `5h ${w.five_hour.pct}%${w.seven_day ? ` · wk ${w.seven_day.pct}%` : ''}`;
}

function headerPill(provider) {
  const reason = notReadyReason(provider);
  if (!reason && limitReached(provider)) return '<span class="pill limit">Limit reached</span>';
  if (reason === 'signin') return '<button class="pill act" data-act="signin">Sign in</button>';
  if (reason === 'key') return `<button class="pill act" data-act="keys">${provider === 'custom' ? 'Set up' : 'Add key'}</button>`;
  if (reason === 'ollama') return '<span class="pill">Not running</span>';
  if (reason === 'node') return '<span class="pill">Needs Node.js</span>';
  const tag = limitTag(provider);
  return `<span class="pill ok">${tag ? esc(tag) : 'Ready'}</span>`;
}

function openPicker() {
  const box = el(`<div class="picker"><div class="search"><input placeholder="Search AIs and models…" spellcheck="false"></div><div class="list"></div></div>`);
  const input = box.querySelector('input');
  const list = box.querySelector('.list');
  const team = currentTeam();
  const current = team ? null : currentModel();

  // teams first: a lead AI plus helpers it hands work to
  const drawTeams = q => {
    const all = state.settings.teams || [];
    const rows = all.filter(t => !q || `team ${t.name} ${t.helpers.map(h => `${h.name} ${h.model}`).join(' ')} ${t.lead}`.toLowerCase().includes(q));
    if (q && !rows.length) return;
    const head = el(`<div class="pk-head"><span class="team-av">${svg(ICON.team)}</span><span class="name">Teams</span><span class="sub">Lead + helpers</span><button class="pill act" data-act="teams">${all.length ? 'Edit' : 'Set up'}</button></div>`);
    head.querySelector('[data-act]').addEventListener('click', () => { closePopover(); openSettings('teams'); });
    list.appendChild(head);
    for (const t of rows) {
      const ready = !notReadyReason(splitModel(t.lead).provider);
      const b = el(`<button class="pk-row team-row${team?.id === t.id ? ' sel' : ''}"${ready ? '' : ' disabled'}><span class="grow"></span><span class="tag"></span></button>`);
      b.querySelector('.grow').textContent = t.name;
      b.querySelector('.tag').textContent = `${shortModel(t.lead)} + ${t.helpers.map(h => h.name).join(', ')}`;
      b.title = `${shortModel(t.lead)} leads. Helpers: ${t.helpers.map(h => `${h.name} (${shortModel(h.model)})`).join(', ')}`;
      b.addEventListener('click', () => { closePopover(); setChatTeam(t); });
      list.appendChild(b);
    }
    if (!all.length) list.appendChild(el('<div class="pk-empty">A lead AI that hands the hands-on work to helper AIs (like a local model) to save usage.</div>'));
  };

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    list.innerHTML = '';
    drawTeams(q);
    for (const p of PROVIDER_ORDER) {
      const meta = PROVIDER_META[p];
      const name = providerName(p);
      let rows = modelsFor(p);
      const headMatches = !q || `${name} ${meta.sub}`.toLowerCase().includes(q);
      if (q && !headMatches) rows = rows.filter(r => r.label.toLowerCase().includes(q));

      // OpenRouter: search its whole catalog
      if (p === 'openrouter' && q && openRouterCatalog) {
        const fav = new Set(state.settings.favorites?.openrouter || []);
        const hits = openRouterCatalog.filter(m => !fav.has(m.id) && (m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))).slice(0, 25);
        rows = [...rows, ...hits.map(m => ({ value: `openrouter:${m.id}`, label: m.id, star: false }))];
      }
      if (q && !headMatches && !rows.length) continue;

      const ready = !notReadyReason(p);
      const head = el(`<div class="pk-head">${avatarSvg(meta.av)}<span class="name">${esc(name)}</span><span class="sub">${esc(meta.sub)}</span>${headerPill(p)}</div>`);
      head.querySelector('[data-act]')?.addEventListener('click', e => {
        closePopover();
        if (e.target.dataset.act === 'signin') { setChatModel(rows[0]?.value || `${p}:`); startSignIn(p); } else openSettings('keys');
      });
      list.appendChild(head);

      for (const r of rows) {
        const b = el(`<button class="pk-row${r.value === current ? ' sel' : ''}"${r.disabled || !ready ? ' disabled' : ''}>
          <span class="grow">${esc(r.label)}</span>${r.tag || r.why ? `<span class="tag">${esc(r.why || r.tag)}</span>` : ''}
          ${r.star !== undefined ? `<span class="star${r.star ? ' on' : ''}" title="${r.star ? 'Remove from favorites' : 'Add to favorites'}">★</span>` : ''}
        </button>`);
        b.addEventListener('click', e => {
          if (e.target.closest('.star')) return toggleFavorite(r.value.slice('openrouter:'.length), draw);
          closePopover();
          setChatModel(r.value);
        });
        list.appendChild(b);
      }
      if (p === 'openrouter' && ready && !rows.length) list.appendChild(el('<div class="pk-empty">Type to search hundreds of models (GPT, Gemini, Grok, DeepSeek, Llama…), then ★ your favorites.</div>'));
      if (p === 'custom' && !rows.length && ready) list.appendChild(el('<div class="pk-empty">Add model names in Settings → API keys.</div>'));
    }
    if (!list.children.length) list.appendChild(el('<div class="pk-empty" style="padding-left:10px">Nothing matches.</div>'));
  };

  input.addEventListener('input', draw);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') (list.querySelector('.pk-row:not(.team-row):not(:disabled)') || list.querySelector('.pk-row:not(:disabled)'))?.click();
  });
  draw();
  openPopover(els.modelBtn, box, { align: 'right', className: 'picker' });
  input.focus();

  if (!openRouterCatalog && !notReadyReason('openrouter')) {
    api.openRouterModels().then(m => { openRouterCatalog = m; if (!els.popover.hidden) draw(); });
  }
}

function toggleFavorite(id, redraw) {
  const fav = new Set(state.settings.favorites?.openrouter || []);
  fav.has(id) ? fav.delete(id) : fav.add(id);
  state.settings.favorites = { ...state.settings.favorites, openrouter: [...fav] };
  api.setSettings({ favorites: state.settings.favorites });
  redraw();
}

function openPermMenu() {
  const cur = currentPermission();
  const { provider } = splitModel(currentModel());
  const engine = PROVIDER_META[provider].engine;
  const items = Object.entries(PERMS).map(([k, p]) => ({
    label: p.label, desc: p.desc, icon: p.icon, checked: k === cur, danger: k === 'full',
    onClick: async () => {
      if (k === 'full' && cur !== 'full') {
        const r = await confirmBox({
          title: 'Give full access?',
          text: 'The AI will run any command and change any file on this PC without asking. Only use this for things you trust.',
          yes: 'Give full access', danger: true,
        });
        if (!r.ok) return;
      }
      setChatPermission(k);
    },
  }));
  if (engine === 'codex' || engine === 'gemini') {
    items.push('sep', { note: `${providerName(provider)} can't stop to ask, so "Ask first" works like "Accept edits": it stays inside the project folder.` });
  }
  openPopover(els.permBtn, menu(items), { align: 'right' });
}

els.modelBtn.addEventListener('click', () => (els.popover.hidden ? openPicker() : closePopover()));
els.permBtn.addEventListener('click', () => (els.popover.hidden ? openPermMenu() : closePopover()));
