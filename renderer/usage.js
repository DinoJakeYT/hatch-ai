// Usage: the small meter in the sidebar and the "Usage & limits" window.

const WINDOW_LABEL = {
  five_hour: '5-hour', seven_day: 'Week', seven_day_opus: 'Week · Opus', seven_day_sonnet: 'Week · Sonnet',
  seven_day_oauth_apps: 'Week · apps', seven_day_overage_included: 'Week + extra',
};

function barHtml(pct) {
  const v = Math.max(0, Math.min(100, pct ?? 0));
  const cls = v >= 100 ? ' full' : v >= 80 ? ' warn' : '';
  return `<div class="bar${cls}"><i style="width:${v}%"></i></div>`;
}

function meterRow(label, pct, title = '') {
  return `<div class="meter-row" title="${esc(title)}"><span>${esc(label)}</span>${barHtml(pct)}<b>${pct == null ? '–' : `${pct}%`}</b></div>`;
}

// Only windows we can name and that have a number; a window past its reset time counts as reset.
function liveWindows(lim) {
  return Object.entries(lim?.windows || {})
    .filter(([k, v]) => v && WINDOW_LABEL[k] && v.pct != null)
    .map(([k, v]) => [k, v.resetsAt && v.resetsAt < Date.now() ? { ...v, pct: 0, wasReset: true } : v]);
}

function limitReached(provider) {
  if (state.usage.limits?.blocked?.[provider]) return true;
  const lim = provider === 'sub' ? state.usage.limits?.sub : provider === 'chatgpt' ? state.usage.limits?.chatgpt : null;
  return liveWindows(lim).some(([, v]) => v.pct >= 100);
}

function limitResetText(provider) {
  const b = state.usage.limits?.blocked?.[provider];
  if (b?.resetsText) return b.resetsText;
  const lim = provider === 'sub' ? state.usage.limits?.sub : provider === 'chatgpt' ? state.usage.limits?.chatgpt : null;
  const full = liveWindows(lim).find(([, v]) => v.pct >= 100);
  return full ? fmtReset(full[1].resetsAt) : '';
}

function monthRow(provider) {
  return state.usage.month?.[provider] || { turns: 0, input: 0, output: 0, cost: 0 };
}

// What to show for one provider: { note, rows: [html] }
function usageSummary(provider) {
  const L = state.usage.limits || {};
  const blocked = L.blocked?.[provider];
  const m = monthRow(provider);
  const rows = [];
  let note = '';

  if (provider === 'sub' || provider === 'chatgpt') {
    const w = Object.fromEntries(liveWindows(provider === 'sub' ? L.sub : L.chatgpt));
    for (const k of ['five_hour', 'seven_day']) {
      if (w[k]) rows.push(meterRow(WINDOW_LABEL[k], w[k].pct, w[k].resetsAt && !w[k].wasReset ? `Resets ${fmtReset(w[k].resetsAt)}` : ''));
    }
    if (!rows.length) note = 'No limit data yet';
    const full = Object.values(w).find(v => v.pct >= 100);
    if (full) note = `Limit reached · resets ${fmtReset(full.resetsAt)}`;
  } else if (provider === 'api') {
    const budget = state.usage.budgets?.anthropic || 0;
    if (budget) rows.push(meterRow('Budget', Math.round((m.cost / budget) * 100), `${fmtMoney(m.cost)} of ${fmtMoney(budget)} this month`));
    note = `${fmtMoney(m.cost)} this month`;
  } else if (provider === 'openrouter') {
    const o = L.openrouter;
    if (o?.limit) rows.push(meterRow('Credits', Math.round(((o.usage || 0) / o.limit) * 100), `${fmtMoney(o.usage)} of ${fmtMoney(o.limit)}`));
    note = o ? `${fmtMoney(o.monthUsage ?? o.usage)} this month` : `${fmtTokens(m.input + m.output)} tokens`;
  } else if (provider === 'local') {
    note = `Free · ${fmtTokens(m.input + m.output)} tokens`;
  } else {
    note = `${fmtTokens(m.input + m.output)} tokens this month`;
  }
  if (blocked) note = `Limit reached${blocked.resetsText ? ` · resets ${blocked.resetsText}` : ''}`;
  return { note, rows, blocked: limitReached(provider) };
}

function renderUsageMeter() {
  const m = els.usageMeter;
  if (state.settings.showUsageMeter === false) { m.hidden = true; return; }
  const { provider } = splitModel(currentModel());
  const s = usageSummary(provider);
  m.hidden = false;
  m.innerHTML = `<div class="um-head">${avatarSvg(familyOf(provider))}<span>${esc(providerName(provider))}</span>
    <span class="note${s.blocked ? ' limit-note' : ''}">${esc(s.note)}</span></div>${s.rows.join('')}`;
}

async function loadUsage(refresh = false) {
  state.usage = await api.usage({ refresh });
  renderUsageMeter();
  updateBanner();
  if ($('usageDlg').open) renderUsageDialog();
}

// ---------- dialog ----------

function usageCard(provider, body) {
  const meta = PROVIDER_META[provider];
  return `<div class="u-card"><div class="u-title">${avatarSvg(meta.av)}${esc(providerName(provider))}<span class="sub">${esc(meta.sub)}</span></div>${body}</div>`;
}

function renderUsageDialog() {
  const U = state.usage;
  const L = U.limits || {};
  const cards = [];
  const tokensLine = p => {
    const m = monthRow(p);
    return `<div class="small">This month in Hatch: ${m.turns} messages · ${fmtTokens(m.input)} in · ${fmtTokens(m.output)} out</div>`;
  };
  const blockedLine = p => {
    const b = L.blocked?.[p];
    return b ? `<div class="small limit-note">Limit reached${b.resetsText ? ` · resets ${esc(b.resetsText)}` : ''}</div>` : '';
  };
  const windowsHtml = (lim, empty) => {
    const rows = liveWindows(lim).map(([k, v]) =>
      meterRow(WINDOW_LABEL[k], v.pct, '') + (v.resetsAt ? `<div class="small" style="margin:-4px 0 0 82px">${v.wasReset ? 'has reset since' : `resets ${esc(fmtReset(v.resetsAt))}`}</div>` : ''));
    return rows.length ? rows.join('') + `<div class="small">Updated ${esc(fmtAgo(lim.updatedAt))}${lim.plan ? ` · ${esc(lim.plan)} plan` : ''}</div>` : `<div class="small">${empty}</div>`;
  };

  if (state.conn.logins.sub?.signedIn || L.sub) {
    cards.push(usageCard('sub', blockedLine('sub') + windowsHtml(L.sub, 'Press Refresh to load your plan limits.') + tokensLine('sub')));
  }
  if (state.conn.logins.chatgpt?.signedIn || L.chatgpt) {
    cards.push(usageCard('chatgpt', blockedLine('chatgpt') + windowsHtml(L.chatgpt, 'Shows up after your first ChatGPT message.') + tokensLine('chatgpt')));
  }
  if (state.conn.keys.anthropic || monthRow('api').turns) {
    const m = monthRow('api');
    const b = U.budgets?.anthropic || 0;
    cards.push(usageCard('api', `<div class="big">${fmtMoney(m.cost)}<span class="small"> this month</span></div>`
      + (b ? meterRow('Budget', Math.round((m.cost / b) * 100), '') + `<div class="small">of ${fmtMoney(b)} budget</div>` : '<div class="small">No budget set</div>')
      + blockedLine('api') + tokensLine('api')));
  }
  if (state.conn.keys.openrouter || L.openrouter) {
    const o = L.openrouter;
    const b = U.budgets?.openrouter || 0;
    const body = o
      ? `<div class="big">${fmtMoney(o.monthUsage ?? o.usage)}<span class="small"> this month · ${fmtMoney(o.usage)} all time</span></div>`
        + (o.limit ? meterRow('Key limit', Math.round(((o.usage || 0) / o.limit) * 100), '') + `<div class="small">${fmtMoney(o.remaining)} left of ${fmtMoney(o.limit)}</div>` : '')
        + (b ? meterRow('Budget', Math.round(((o.monthUsage ?? 0) / b) * 100), '') : '')
      : '<div class="small">Press Refresh to load your OpenRouter credits.</div>';
    cards.push(usageCard('openrouter', body + blockedLine('openrouter') + tokensLine('openrouter')));
  }
  for (const p of ['openai', 'gemini', 'custom']) {
    if (state.conn.keys[PROVIDER_META[p].key] || monthRow(p).turns) {
      cards.push(usageCard(p, '<div class="small">This service doesn\'t share limits with apps, so Hatch counts what you send.</div>' + blockedLine(p) + tokensLine(p)));
    }
  }
  if (state.conn.ollama.ok || monthRow('local').turns) cards.push(usageCard('local', '<div class="big">Free</div>' + tokensLine('local')));

  $('usageGrid').innerHTML = cards.join('') || '<p class="hint">Connect an AI to see its usage here.</p>';
  $('usageUpdated').textContent = '';
  $('budget-anthropic').value = U.budgets?.anthropic || 0;
  $('budget-openrouter').value = U.budgets?.openrouter || 0;
  $('stopAtBudget').checked = !!U.stopAtBudget;
}

async function openUsage() {
  renderUsageDialog();
  $('usageDlg').showModal();
  $('usageUpdated').textContent = 'Refreshing…';
  await loadUsage(true);
  $('usageUpdated').textContent = 'Up to date';
}

els.usageMeter.addEventListener('click', openUsage);
$('usageRefresh').addEventListener('click', async () => {
  $('usageUpdated').textContent = 'Refreshing…';
  await loadUsage(true);
  $('usageUpdated').textContent = 'Up to date';
});
$('budgetSave').addEventListener('click', async () => {
  const budgets = { anthropic: Number($('budget-anthropic').value) || 0, openrouter: Number($('budget-openrouter').value) || 0 };
  await api.setSettings({ budgets, stopAtBudget: $('stopAtBudget').checked });
  state.settings.budgets = budgets;
  $('budgetStatus').textContent = 'Saved';
  $('budgetStatus').className = 'status-text good';
  loadUsage();
});

api.onUsageChanged(() => loadUsage());
