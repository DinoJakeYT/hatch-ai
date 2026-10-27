// The conversation: bubbles, tool cards, typing indicator, header, banner and sending.

let itemEls = [];
let typingEl = null;

function nearBottom() {
  const s = els.scroller;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
}

function withScroll(fn) {
  const stick = nearBottom();
  fn();
  if (stick) els.scroller.scrollTop = els.scroller.scrollHeight;
}

// ---------- tool cards ----------

function describeTool(it) {
  const inp = it.input || {};
  switch (it.name) {
    case 'Bash':
    case 'PowerShell':
      return {
        icon: inp.description === 'Hatch check' ? ICON.shieldOk : ICON.terminal,
        verb: inp.description === 'Hatch check' ? 'Checked build' : 'Ran',
        target: inp.command, sections: [['Command', inp.command], ['Output', it.result]],
      };
    case 'Write': {
      // while it's being written, show the newest lines
      const lines = String(inp.content || '').split('\n');
      const shown = it.status === 'running' ? lines.slice(-60).join('\n') : clip(inp.content);
      return { icon: ICON.create, verb: 'Created', target: baseName(inp.file_path), file: inp.file_path, sections: [['Content', shown]] };
    }
    case 'Open':
      return { icon: ICON.globe, verb: 'Opened', target: baseName(inp.file_path), file: inp.file_path, sections: [['Problem', it.status === 'error' ? it.result : '']] };
    case 'Preview':
      return {
        icon: ICON.eye, verb: 'Previewed', target: baseName(inp.file_path) || inp.file_path, image: inp.image,
        sections: [[it.status === 'error' ? 'Problem' : 'What the AI saw', it.result]],
      };
    case 'Remember':
      return { icon: ICON.book, verb: 'Remembered', target: inp.fact };
    case 'Template':
      return { icon: ICON.create, verb: 'Started from template', target: inp.name, sections: [['Files', it.result]] };
    case 'Edit':
      return { icon: ICON.edit, verb: 'Edited', target: baseName(inp.file_path), file: inp.file_path, diffs: [{ old: inp.old_string, new: inp.new_string }] };
    case 'MultiEdit':
      return { icon: ICON.edit, verb: 'Edited', target: baseName(inp.file_path), file: inp.file_path, diffs: (inp.edits || []).map(e => ({ old: e.old_string, new: e.new_string })) };
    case 'NotebookEdit':
      return { icon: ICON.edit, verb: 'Edited', target: baseName(inp.notebook_path), file: inp.notebook_path, sections: [['Cell', inp.new_source]] };
    case 'Patch': {
      const ch = inp.changes || [];
      return {
        icon: ICON.edit, verb: ch.length === 1 ? ({ add: 'Created', delete: 'Deleted' }[ch[0].kind] || 'Edited') : `Changed ${ch.length} files`,
        target: ch.length === 1 ? baseName(ch[0].path) : ch.map(c => baseName(c.path)).join(', '),
        file: ch.length === 1 && ch[0].kind !== 'delete' ? ch[0].path : null, files: ch,
      };
    }
    case 'Read':
      return { icon: ICON.read, verb: 'Read', target: baseName(inp.file_path) || inp.file_path, file: inp.file_path, sections: [['Contents', clip(it.result, 40)]] };
    case 'LS':
      return { icon: ICON.folder, verb: 'Looked in', target: baseName(inp.path) || inp.path, sections: [['Files', it.result]] };
    case 'Glob':
      return { icon: ICON.search, verb: 'Found files', target: inp.pattern, sections: [['Matches', it.result]] };
    case 'Grep':
      return { icon: ICON.search, verb: 'Searched', target: inp.pattern, sections: [['Matches', it.result]] };
    case 'WebSearch':
      return { icon: ICON.globe, verb: 'Searched the web', target: inp.query, sections: [['Results', it.result]] };
    case 'WebFetch':
      return { icon: ICON.globe, verb: 'Read page', target: inp.url, sections: [['Summary', it.result]] };
    case 'TodoWrite':
      return { icon: ICON.list, verb: 'Plan', target: `${(inp.todos || []).filter(t => t.status === 'completed').length}/${(inp.todos || []).length} done`, todos: inp.todos || [] };
    case 'Task':
    case 'Agent':
      return { icon: ICON.spark, verb: 'Helper', target: inp.description, sections: [['Task', inp.prompt], ['Result', it.result]] };
    case 'Skill':
      return { icon: ICON.spark, verb: 'Used skill', target: inp.skill || inp.name, sections: [['Result', it.result]] };
    case 'SkillProposal':           // an AI wants to save a reusable skill; the user decides
      return {
        icon: ICON.spark, target: inp.name,
        verb: { pending: 'Wants to save a skill', done: 'Saved skill', denied: 'Declined skill' }[it.status] || 'Skill',
        sections: [
          ['Note', it.status === 'pending' && inp.replaces ? `Replaces your existing skill "${inp.name}" (its old version is kept as a backup).` : ''],
          ['When to use it', inp.description], ['Instructions', inp.body], ['Result', it.status === 'pending' ? '' : it.result],
        ],
      };
    case 'mcp__hatch__propose_skill':
    case 'hatch: propose_skill':
      return { icon: ICON.spark, verb: 'Proposed a skill', target: inp.name, sections: [['Result', it.result]] };
    case 'mcp__hatch__wait_for_helpers':
    case 'hatch: wait_for_helpers':
      return { icon: ICON.team, verb: it.status === 'running' ? 'Waiting for helpers' : 'Helpers reported', target: '', sections: [['Reports', it.result]] };
    case 'HelperReport':            // a helper finished a task the lead handed out in the background
      return {
        icon: ICON.team, verb: `${inp.agent || 'Helper'} finished`, target: String(inp.task || '').split('\n')[0],
        sections: [['Report', it.result], ['Task', inp.task]],
      };
    case 'Delegate':                // a team lead handing a task to a helper
    case 'mcp__hatch__delegate':
    case 'hatch: delegate':
      return {
        icon: ICON.handoff, verb: `Asked ${inp.agent || 'a helper'}`, target: String(inp.task || '').split('\n')[0],
        sections: [['Task', inp.task], ['Report', it.result]],
      };
    default:
      return { icon: ICON.spark, verb: it.name, target: '', sections: [['Input', it.input ? JSON.stringify(it.input, null, 2) : ''], ['Result', it.result]] };
  }
}

const RUNNING_VERB = {
  Ran: 'Running', Created: 'Creating', Edited: 'Editing', Read: 'Reading', Searched: 'Searching', 'Looked in': 'Looking in',
  Opened: 'Opening', Remembered: 'Remembering', 'Checked build': 'Checking build', Previewed: 'Taking a screenshot of',
  'Found files': 'Finding files', 'Searched the web': 'Searching the web', 'Read page': 'Reading page', Deleted: 'Deleting',
};

const IMAGE_FILE = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;
const fileUrl = p => `file:///${encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23')}`;

// A screenshot or image this card is about, if any.
function cardImage(it, d) {
  if (d.image) return d.image;
  if ((it.name === 'Read' || it.name === 'Write') && IMAGE_FILE.test(d.file || '') && it.status === 'done') return d.file;
  if ((it.name === 'Bash' || it.name === 'PowerShell') && /preview\.mjs/i.test(it.input?.command || '')) {
    return /Screenshot saved: (.+\.png)/i.exec(it.result || '')?.[1]?.trim() || null;
  }
  return null;
}

function toolCard(it, wasOpen, index) {
  const d = describeTool(it);
  const proposal = it.name === 'SkillProposal' && it.status === 'pending';   // waits for the user's yes or no
  if ((it.name === 'Bash' || it.name === 'PowerShell') && /preview\.mjs/i.test(it.input?.command || '')) {
    d.icon = ICON.eye;
    d.verb = it.status === 'running' ? 'Taking a screenshot' : 'Previewed';
    d.target = (/preview\.mjs"?\s+"?([^"]+)"?/i.exec(it.input.command)?.[1] || '').split(/[\\/]/).pop();
  }
  const image = cardImage(it, d);
  const pending = it.perm?.status === 'pending';
  if (it.status === 'running') d.verb = RUNNING_VERB[d.verb] || d.verb.replace(/^Asked (.+)/, '$1 is working on');

  let status;
  if (pending || proposal) status = '';
  else if (it.status === 'running') status = '<span class="status"><span class="spinner"></span></span>';
  else if (it.status === 'done') status = `<span class="status ok">${svg(ICON.ok)}</span>`;
  else if (it.status === 'stopped' || (it.status === 'denied' && it.name === 'SkillProposal')) status = `<span class="status">${svg(ICON.stop)}</span>`;
  else status = `<span class="status err">${svg(ICON.err)}</span>`;

  const openBtn = d.file && it.status === 'done' && it.name !== 'Read' ? `<button class="open" data-open="${esc(d.file)}">Open</button>` : '';

  let body = image ? `<img class="shot" src="${esc(fileUrl(image))}" data-full="${esc(image)}" alt="Screenshot" title="Click to open full size">` : '';
  for (const [label, text] of d.sections || []) {
    if (text) body += `<div class="label">${esc(label)}</div><pre>${esc(text)}</pre>`;
  }
  for (const df of d.diffs || []) {
    if (df.old) body += `<pre class="del">${esc(clip(df.old, 40))}</pre>`;
    if (df.new) body += `<pre class="add">${esc(clip(df.new, 40))}</pre>`;
  }
  if (d.files) {
    body += '<ul class="files">' + d.files.map(f =>
      `<li><span class="k ${esc(f.kind)}">${{ add: 'NEW', delete: 'DEL', update: 'EDIT' }[f.kind] || 'EDIT'}</span>${esc(f.path)}</li>`).join('') + '</ul>';
  }
  if (d.todos) {
    body += '<ul class="todos">' + d.todos.map(t =>
      `<li class="${esc(t.status)}">${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'}<span>${esc(t.content)}</span></li>`).join('') + '</ul>';
  }
  if (it.status === 'denied' && it.name !== 'SkillProposal') body += '<div class="label">Not allowed</div>';

  const what = { Bash: 'run this command', PowerShell: 'run this command', Write: 'create this file', Edit: 'edit this file', Open: 'open this file' }[it.name]
    || `use ${esc(it.name)}`;
  const ask = pending ? `
    <div class="ask">
      <span class="q">Allow ${esc(it.agent && it.agent !== 'Lead' ? it.agent : providerName(it.by || 'sub'))} to ${what}?</span>
      <button class="allow" data-perm="allow" data-req="${esc(it.perm.reqId)}">Allow</button>
      <button data-perm="always" data-req="${esc(it.perm.reqId)}">Always allow</button>
      <button data-perm="deny" data-req="${esc(it.perm.reqId)}">Deny</button>
    </div>` : proposal ? `
    <div class="ask">
      <span class="q">Save this as a skill every AI can use?</span>
      <button class="allow" data-skill="approve" data-idx="${index}">Save skill</button>
      <button data-skill="edit" data-idx="${index}">Edit first</button>
      <button data-skill="decline" data-idx="${index}">Decline</button>
    </div>` : '';

  // a file being written opens by itself so you can watch the code; it closes again when done
  const autoOpen = it.status === 'running' && it.name === 'Write' && !!it.input?.content;
  const userOpen = wasOpen === true || wasOpen === 'user';
  const open = pending || proposal || userOpen || autoOpen || d.todos || (image && wasOpen !== 'closed') ? ' open' : '';
  const card = el(`
    <div class="card${pending || proposal ? ' perm' : ''}${open}"${autoOpen && !userOpen && !pending ? ' data-auto="1"' : ''}${wasOpen === 'closed' ? ' data-user-closed="1"' : ''}>
      <div class="head">
        <span class="icon">${svg(d.icon)}</span>
        <span class="verb">${esc(d.verb)}</span>
        <span class="target" title="${esc(d.target)}">${esc(d.target)}</span>
        ${openBtn}${status}
      </div>
      ${body ? `<div class="body">${body}</div>` : ''}
      ${ask}
    </div>`);
  return card;   // clicks are handled for the whole conversation at once (see below), so cards can be updated in place
}

// One click handler for every card: updating a card in place then never loses its buttons.
els.messages.addEventListener('click', e => {
  const t = e.target;
  const open = t.closest('[data-open]');
  if (open) return void api.openPath(open.dataset.open);
  const shot = t.closest('.shot');
  if (shot) return void api.openPath(shot.dataset.full);
  const perm = t.closest('[data-perm]');
  if (perm) return void api.respondPermission(perm.dataset.req, perm.dataset.perm);
  const skill = t.closest('[data-skill]');
  if (skill) return void decideSkill(Number(skill.dataset.idx), skill.dataset.skill);
  const undo = t.closest('[data-undo]');
  if (undo) return void undoTo(Number(undo.dataset.undo));
  const redo = t.closest('[data-redo]');
  if (redo) return void redoFrom(Number(redo.dataset.redo));
  const head = t.closest('.card > .head');
  if (head) {
    const card = head.parentElement;
    delete card.dataset.auto;
    card.classList.toggle('open');
    if (card.classList.contains('open')) delete card.dataset.userClosed;
    else card.dataset.userClosed = '1';
  }
});

// ---------- message rows ----------

function familyOf(provider) {
  return PROVIDER_META[provider]?.av || 'claude';
}

// An AI group starts after a user message or when a different AI (or team member) takes over.
function startsGroup(i) {
  const items = state.chat.items;
  const { by, agent } = items[i];
  for (let j = i - 1; j >= 0; j--) {
    const t = items[j].type;
    if (t === 'user') return true;
    if (t === 'assistant' && !items[j].text.trim()) continue;
    if (t === 'assistant' || t === 'tool') return items[j].by !== by || items[j].agent !== agent;
  }
  return true;
}

// In team chats each group is labeled with who is talking: "Coder · Local glm-4.7-flash".
function aiRow(i, content) {
  const it = state.chat.items[i];
  const first = startsGroup(i);
  const who = it.agent ? `${it.agent} · ${shortModel(it.agentModel || `${it.by}:`)}` : providerName(it.by || 'sub');
  const row = el(`<div class="row ai${first ? ' first' : ''}${it.agent && it.agent !== 'Lead' ? ' helper' : ''}"></div>`);
  row.appendChild(first ? el(`<div class="avatar" title="${esc(who)}">${avatarSvg(familyOf(it.by))}</div>`) : el('<div class="avatar-space"></div>'));
  if (first && it.agent) {
    const stack = el('<div class="stack"><div class="agent-label"></div></div>');
    stack.firstChild.textContent = who;
    stack.appendChild(content);
    row.appendChild(stack);
  } else {
    row.appendChild(content);
  }
  return row;
}

function renderItem(i, wasOpen) {
  const it = state.chat.items[i];
  switch (it.type) {
    case 'user': {
      // sent while the AI was working: it reaches the AI at its next step
      const status = it.queued === 'waiting' ? 'Waiting for the AI\'s next step…' : it.queued === 'seen' ? 'Seen by the AI while it worked' : '';
      const row = el(`
        <div class="row user">
          <div class="ucol">
            <div class="bubble${it.queued ? ' queued' : ''}"></div>
            <div class="umeta">${status ? `<span class="q">${esc(status)}</span>` : ''}${it.checkpoint ? `<button class="undo" data-undo="${i}" title="Put the project files back to how they were before this message">${svg(ICON.undo)} Undo changes since this</button>` : ''}</div>
          </div>
        </div>`);
      row.querySelector('.bubble').textContent = it.text;
      return row;
    }
    case 'assistant': {
      const bubble = el('<div class="bubble"></div>');
      bubble.innerHTML = md(it.text);
      const row = aiRow(i, bubble);
      if (!it.text.trim()) row.style.display = 'none';
      return row;
    }
    case 'tool':
      return aiRow(i, toolCard(it, wasOpen, i));
    case 'error':
      return el(`<div class="note err">${esc(it.text)}</div>`);
    default:
      return el(`<div class="note">${esc(it.text)}${it.redo ? ` <button class="redo" data-redo="${i}">Redo (bring the changes back)</button>` : ''}</div>`);
  }
}

function appendItem(i) {
  withScroll(() => {
    const node = renderItem(i);
    els.messages.insertBefore(node, typingEl?.parentNode ? typingEl : null);
    itemEls[i] = node;
    updateTyping();
  });
}

const dirty = new Set();
let frame = 0;
function scheduleUpdate(i) {
  dirty.add(i);
  if (!frame) frame = requestAnimationFrame(flushUpdates);
}

function flushUpdates() {
  frame = 0;
  withScroll(() => {
    for (const i of dirty) {
      const it = state.chat?.items[i];
      const old = itemEls[i];
      if (!it || !old) continue;
      // update what's on screen in place: rebuilding it would replay its animation and restart its spinner (flicker)
      if (it.type === 'assistant' && old.querySelector('.bubble')) {
        const next = el('<div class="bubble"></div>');
        next.innerHTML = md(it.text);
        morph(old.querySelector('.bubble'), next);
        old.style.display = it.text.trim() ? '' : 'none';
      } else {
        const oldCard = old.querySelector('.card');
        const wasOpen = !oldCard ? false : oldCard.classList.contains('open') ? (oldCard.dataset.auto ? 'auto' : 'user') : oldCard.dataset.userClosed ? 'closed' : false;
        const node = morph(old, renderItem(i, wasOpen));
        itemEls[i] = node;
        const body = node.querySelector('.card[data-auto] .body');
        if (body) body.scrollTop = body.scrollHeight;
      }
    }
    dirty.clear();
    updateTyping();
  });
}

function updateTyping() {
  const items = state.chat?.items || [];
  const last = items[items.length - 1];
  const show = state.running && (!last || last.type === 'user' || last.type === 'note'
    || (last.type === 'tool' && last.status !== 'running' && last.perm?.status !== 'pending')
    || (last.type === 'assistant' && !last.text.trim()));
  if (show) {
    const fam = workingFamily(items);
    if (!typingEl || typingEl.dataset.fam !== fam) {
      typingEl?.remove();
      typingEl = el(`<div class="row ai" data-fam="${fam}"><div class="avatar">${avatarSvg(fam)}</div><div class="bubble typing"><i></i><i></i><i></i></div></div>`);
    }
    els.messages.appendChild(typingEl);   // keeps it last
  } else if (typingEl?.parentNode) {
    typingEl.remove();
  }
}

// Whose turn it is: a helper while the lead waits on it, otherwise the chat's AI.
function workingFamily(items) {
  const team = currentTeam();
  const asked = team && [...items].reverse().find(x => x.type === 'tool' && /delegate$/i.test(x.name) && x.status === 'running');
  const helper = asked && team.helpers.find(h => h.name.toLowerCase() === String(asked.input?.agent || '').toLowerCase());
  return familyOf(splitModel(helper ? helper.model : currentModel()).provider);
}

function renderChat() {
  els.messages.innerHTML = '';
  itemEls = [];
  typingEl = null;
  const items = state.chat?.items || [];
  items.forEach((_, i) => {
    const node = renderItem(i);
    els.messages.appendChild(node);
    itemEls[i] = node;
  });
  els.welcome.classList.toggle('show', !items.length);
  updateTyping();
  els.scroller.scrollTop = els.scroller.scrollHeight;
  renderHeader();
}

// ---------- header ----------

const PERMS = {
  ask: { label: 'Ask first', icon: ICON.shieldAsk, desc: 'Asks before editing files or running commands' },
  edits: { label: 'Accept edits', icon: ICON.shieldEdit, desc: 'Edits files in the project freely, asks before commands' },
  always: { label: 'Always accept', icon: ICON.shieldOk, desc: 'Never asks. Works inside the project folder' },
  full: { label: 'Full access', icon: ICON.bolt, desc: 'No limits at all. Can change anything on this PC' },
  readonly: { label: 'Read only', icon: ICON.lock, desc: "Can look at files but can't change anything" },
};

function renderHeader() {
  const chat = state.chat;
  els.title.textContent = chat?.title || 'New chat';
  const cwd = chat ? chat.cwd : state.draft.cwd;
  els.folderLabel.textContent = cwd ? baseName(cwd) : 'New folder';
  els.folderBtn.title = cwd ? `${cwd}\n(click to open)` : 'Pick a folder for this chat (optional)';

  const perm = currentPermission();
  const p = PERMS[perm] || PERMS.edits;
  els.permBtn.innerHTML = `${svg(p.icon)}<span>${esc(p.label)}</span>${svg(ICON.caret).replace('<svg', '<svg class="caret"')}`;
  els.permBtn.classList.toggle('perm-full', perm === 'full');

  const model = currentModel();
  const team = currentTeam();
  const caret = svg(ICON.caret).replace('<svg', '<svg class="caret"');
  if (team) {
    els.modelBtn.innerHTML = `${svg(ICON.team).replace('<svg', '<svg class="team-ico"')}<span>${esc(team.name)}</span>${caret}`;
    els.welcomeUsing.innerHTML = `${avatarSvg(familyOf(splitModel(model).provider))}<span>Team ${esc(team.name)}: ${esc(shortModel(team.lead))} leads, helped by ${esc(team.helpers.map(h => `${h.name} (${shortModel(h.model)})`).join(', '))}</span>`;
  } else {
    els.modelBtn.innerHTML = `${avatarSvg(familyOf(splitModel(model).provider))}<span>${esc(modelLabel(model))}</span>${caret}`;
    els.welcomeUsing.innerHTML = `${avatarSvg(familyOf(splitModel(model).provider))}<span>Using ${esc(modelLabel(model))}</span>`;
  }
  updateBanner();
  renderUsageMeter();
  if (typeof updateNightUi === 'function') updateNightUi();
}

// Picking a single AI leaves any team; picking a team uses its lead as the chat's AI.
function setChatModel(value, team = null) {
  localStorage.setItem('model', value);
  localStorage.setItem('team', team || '');
  if (state.chat) {
    state.chat.model = value;
    state.chat.team = team;
    api.setChat(state.chatId, { model: value, team });
  } else {
    state.draft.model = value;
    state.draft.team = team;
  }
  renderHeader();
  updateTyping();
}

const setChatTeam = t => setChatModel(t.lead, t.id);

function setChatPermission(value) {
  if (state.chat) {
    state.chat.permission = value;
    api.setChat(state.chatId, { permission: value });
  } else {
    state.draft.permission = value;
  }
  renderHeader();
}

// ---------- banner (what's needed before sending) ----------

function updateBanner() {
  const { provider } = splitModel(currentModel());
  const name = providerName(provider);
  const reason = notReadyReason(provider);
  let text = '', btn = '', btn2 = '', action = '', action2 = '', limit = false;

  if (state.signingIn === provider) {
    text = `<strong>Finish signing in to ${esc(name)}</strong> in the sign-in window.`;
    btn = 'Use my browser instead'; action = 'browser';
    btn2 = 'Cancel'; action2 = 'cancel';
  } else if (reason === 'signin') {
    text = `<strong>Sign in to ${esc(name)}</strong> to use your ${provider === 'sub' ? 'Claude Pro/Max' : 'ChatGPT'} plan. Or pick another AI from the menu at the top.`;
    btn = 'Sign in'; action = 'signin';
    const err = state.signInError[provider];
    if (err) text += `<br><span class="err-text">${esc(err)}</span>`;
  } else if (reason === 'key') {
    text = `<strong>Add your ${esc(name)} ${provider === 'custom' ? 'provider' : 'API key'}</strong> in Settings to use it.`;
    btn = 'Open settings'; action = 'keys';
  } else if (reason === 'node') {
    text = '<strong>Gemini needs Node.js.</strong> Install it from nodejs.org, then restart Hatch.';
  } else if (reason === 'ollama') {
    text = "<strong>Ollama isn't reachable.</strong> Start Ollama, or check its address in Settings.";
    btn = 'Open settings'; action = 'local';
  } else if (limitReached(provider)) {
    limit = true;
    const when = limitResetText(provider);
    text = `<strong>${esc(name)} hit a usage limit</strong>${when ? ` · resets ${esc(when)}` : ''}. You can still try, or pick another AI.`;
    btn = 'Choose AI'; action = 'picker';
  }

  els.banner.hidden = !text;
  els.banner.classList.toggle('limit', limit);
  els.bannerText.innerHTML = text;
  els.bannerBtn.hidden = !btn;
  els.bannerBtn.textContent = btn;
  els.bannerBtn.dataset.action = action;
  els.bannerBtn2.hidden = !btn2;
  els.bannerBtn2.textContent = btn2;
  els.bannerBtn2.dataset.action = action2;
  state.ready = !reason;
  refreshSendButton();
}

function onBannerAction(action) {
  const { provider } = splitModel(currentModel());
  if (action === 'signin') startSignIn(provider);
  else if (action === 'browser') api.signInWithBrowser();
  else if (action === 'cancel') api.cancelSignIn();
  else if (action === 'keys') openSettings('keys');
  else if (action === 'local') openSettings('local');
  else if (action === 'picker') openPicker();
}

function startSignIn(provider) {
  state.signingIn = provider;
  delete state.signInError[provider];
  updateBanner();
  renderSettingsAccounts?.();
  api.signIn(provider);
}

// ---------- sending ----------

function setRunning(on) {
  state.running = on;
  refreshSendButton();
  updateTyping();
  renderActivity();
  if (!on) updatePlay();
  if (typeof updateNightUi === 'function') updateNightUi();
}

// While the AI works the button stops it, unless there's a message to send: that goes to the AI at its next step.
function refreshSendButton() {
  const typed = !!els.input.value.trim();
  const stop = state.running && !typed;
  els.send.classList.toggle('stop', stop);
  els.send.title = stop ? 'Stop' : state.running ? 'Send now (the AI sees it at its next step, without stopping)' : 'Send';
  els.send.disabled = !state.running && (!typed || !state.ready);
  els.input.placeholder = state.running ? 'Add something while it works…' : 'Message Hatch…';
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 220) + 'px';
  refreshSendButton();
}

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text || (!state.running && !state.ready)) return;
  els.input.value = '';
  autosize();
  if (state.running) {   // it shows up in the chat right away, marked as waiting for the AI's next step
    await api.send({ chatId: state.chatId, text });
    return;
  }

  const wasNew = !state.chatId;
  const r = await api.send({
    chatId: state.chatId, text,
    model: currentModel(), team: currentTeam()?.id || null, permission: currentPermission(), cwd: state.draft.cwd,
  });
  if (r.busy) return;
  if (wasNew) {
    state.chatId = r.chatId;
    state.chat = r.chat;
    renderChat();
    setRunning(true);
  }
  els.welcome.classList.remove('show');
  refreshList();
}

// ---------- skills an AI proposes ----------

async function decideSkill(index, action) {
  const it = state.chat.items[index];
  if (action === 'edit') {
    openSkillEditor(it.input, {
      title: 'Edit the skill, then save it',
      onSave: data => api.decideSkill(state.chatId, index, 'approve', { name: data.name, description: data.description, body: data.body }),
    });
    return;
  }
  const r = await api.decideSkill(state.chatId, index, action);
  if (r.error) confirmBox({ title: 'Couldn\'t save the skill', text: r.error, yes: 'OK' });
}

// ---------- undo and redo ----------

async function undoTo(index) {
  if (state.running) return confirmBox({ title: 'The AI is still working', text: 'Stop it first (the square button), then undo.', yes: 'OK' });
  const it = state.chat.items[index];
  const r = await confirmBox({
    title: 'Undo changes since this message?',
    text: `The project files go back to how they were before "${it.text.length > 60 ? `${it.text.slice(0, 57)}…` : it.text}". Files made since then are removed. You can bring everything back with Redo.`,
    yes: 'Undo',
  });
  if (!r.ok) return;
  const res = await api.undo(state.chatId, index);
  if (res.error) confirmBox({ title: 'Couldn\'t undo', text: res.error, yes: 'OK' });
  updatePlay();
}

async function redoFrom(index) {
  if (state.running) return;
  const res = await api.redo(state.chatId, index);
  if (res.error) confirmBox({ title: 'Couldn\'t redo', text: res.error, yes: 'OK' });
  updatePlay();
}

// ---------- Play: run what the AI built ----------

let playable = [];

async function updatePlay() {
  const id = state.chatId;
  playable = id ? await api.runnables(id) : [];
  if (id !== state.chatId) return;
  els.playBtn.hidden = !playable.length;
  els.playBtn.title = playable.length ? `Run ${playable[0].name}` : '';
}

async function play(name) {
  const r = await api.play(state.chatId, name);
  if (r.error) confirmBox({ title: 'Couldn\'t start it', text: r.error, yes: 'OK' });
}

els.playBtn.addEventListener('click', async () => {
  await updatePlay();
  if (playable.length <= 1) return playable[0] && play(playable[0].name);
  // several things to run: newest first
  const kind = { program: 'Program', page: 'Web page', python: 'Python' };
  openPopover(els.playBtn, menu(playable.map((p, n) => ({
    label: p.name, icon: ICON.play, desc: `${kind[p.kind]} · ${n === 0 ? 'newest, ' : ''}changed ${fmtAgo(p.mtime)}`,
    onClick: () => play(p.name),
  }))), { align: 'right' });
});

async function openChat(id) {
  const chat = await api.getChat(id);
  if (!chat) return refreshList();
  state.chatId = id;
  state.chat = chat;
  state.activity = chat.activity || [];
  renderChat();
  setRunning(!!chat.running);
  updatePlay();
  refreshList();
  els.input.focus();
}

function newChat() {
  state.chatId = null;
  state.chat = null;
  state.activity = [];
  state.draft = { cwd: null, model: null, team: localStorage.getItem('team') || null, permission: null };
  renderChat();
  setRunning(false);
  refreshList();
  els.input.focus();
}

// ---------- who is working right now (the bar above the message box) ----------

let activityTimer = 0;

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function renderActivity() {
  const list = state.chat && state.running ? state.activity || [] : [];
  els.activity.hidden = !list.length;
  if (!list.length) {
    clearInterval(activityTimer);
    activityTimer = 0;
    return;
  }
  const now = Date.now();
  morphChildren(els.activity, list.map(a => {
    const who = a.agent ? `${a.agent} · ${shortModel(a.model)}` : shortModel(a.model);
    return `<div class="act-row" title="Working for ${fmtElapsed(now - a.since)}">
      ${avatarSvg(familyOf(splitModel(a.model).provider)).replace('class="av"', 'class="av mini-av"')}
      <span class="who">${esc(who)}</span><span class="what">${esc(a.status)}</span>
      <span class="spinner"></span><span class="time">${fmtElapsed(now - a.statusSince)}</span></div>`;
  }).join(''));
  if (!activityTimer) activityTimer = setInterval(renderActivity, 1000);
}

// ---------- events from the app ----------

api.onChatEvent(ev => {
  if (ev.kind === 'activity') {
    if (ev.chatId === state.chatId) {
      state.activity = ev.list;
      renderActivity();
    }
    return;
  }
  if (ev.kind === 'status') {
    if (ev.chatId === state.chatId) setRunning(ev.running);
    refreshList();
    return;
  }
  if (!state.chat || ev.chatId !== state.chatId) return;
  if (ev.kind === 'item-add') {
    state.chat.items[ev.index] = ev.item;
    els.welcome.classList.remove('show');
    appendItem(ev.index);
  } else if (ev.kind === 'item-update') {
    Object.assign(state.chat.items[ev.index], ev.patch);
    scheduleUpdate(ev.index);
  } else if (ev.kind === 'permission') {
    state.chat.permission = ev.permission;
    renderHeader();
  }
});
