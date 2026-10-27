// Sidebar: chats, groups, hiding, renaming, moving (menu or drag) and deleting.

const groups = () => state.settings.groups || [];

function saveGroups(next) {
  state.settings.groups = next;
  api.setGroups(next);
  renderList();
}

async function refreshList() {
  state.chats = await api.listChats();
  renderList();
}

function renderList() {
  const list = els.list;
  list.innerHTML = '';
  const show = state.showHidden;
  const gs = groups();
  const groupIds = new Set(gs.map(g => g.id));
  const visibleGroup = g => show || !g.hidden;
  const isHidden = c => c.hidden || (c.groupId && gs.find(g => g.id === c.groupId)?.hidden);

  for (const g of gs.filter(visibleGroup)) {
    const members = state.chats.filter(c => c.groupId === g.id && (show || !c.hidden));
    list.appendChild(groupHead(g, members.length));
    if (!g.collapsed) {
      const body = el('<div class="group-body"></div>');
      for (const c of members) body.appendChild(chatRow(c));
      if (!members.length) body.appendChild(el('<div class="empty">Drag chats here</div>'));
      list.appendChild(body);
    }
  }

  const loose = state.chats.filter(c => (!c.groupId || !groupIds.has(c.groupId)) && (show || !c.hidden));
  if (gs.some(visibleGroup)) {
    const label = el('<div class="section-label">Chats</div>');
    dropTarget(label, null);
    list.appendChild(label);
  }
  for (const c of loose) list.appendChild(chatRow(c));
  if (!state.chats.length) list.appendChild(el('<div class="empty">No chats yet</div>'));

  const hiddenCount = state.chats.filter(isHidden).length + gs.filter(g => g.hidden).length;
  els.toggleHidden.hidden = !hiddenCount && !show;
  els.toggleHidden.innerHTML = show ? `${svg(ICON.eyeOff)} Hide hidden chats` : `${svg(ICON.eye)} Show hidden (${hiddenCount})`;
}

function chatRow(c) {
  const row = el(`
    <div class="chat-item${c.id === state.chatId ? ' active' : ''}${c.hidden ? ' is-hidden' : ''}" draggable="true">
      ${avatarSvg(familyOf(splitModel(c.model).provider)).replace('class="av"', 'class="av mini-av"')}
      <span class="title"></span>
      ${c.overnight ? '<svg class="moon" viewBox="0 0 20 20" aria-label="Working overnight"><path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z"/></svg>' : c.running ? '<span class="dot"></span>' : ''}
      <button class="icon-btn more" title="More">${svg(ICON.more)}</button>
    </div>`);
  row.querySelector('.title').textContent = c.title;
  row.addEventListener('click', e => {
    if (e.target.closest('.more') || e.target.closest('.rename-input')) return;
    openChat(c.id);
  });
  const more = row.querySelector('.more');
  more.addEventListener('click', () => chatMenu(c, more));
  row.addEventListener('contextmenu', e => { e.preventDefault(); chatMenu(c, more); });
  row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/hatch-chat', c.id); e.dataTransfer.effectAllowed = 'move'; });
  return row;
}

function groupHead(g, count) {
  const head = el(`
    <div class="group-head${g.collapsed ? ' collapsed' : ''}${g.hidden ? ' is-hidden' : ''}">
      ${svg(ICON.chev).replace('<svg', '<svg class="chev"')}
      ${svg(ICON.folder)}
      <span class="title"></span>
      <span class="count">${count}</span>
      <button class="icon-btn more" title="More">${svg(ICON.more)}</button>
    </div>`);
  head.querySelector('.title').textContent = g.name;
  head.dataset.id = g.id;
  head.addEventListener('click', e => {
    if (e.target.closest('.more') || e.target.closest('.rename-input')) return;
    saveGroups(groups().map(x => (x.id === g.id ? { ...x, collapsed: !x.collapsed } : x)));
  });
  const more = head.querySelector('.more');
  more.addEventListener('click', () => groupMenu(g, more, head));
  head.addEventListener('contextmenu', e => { e.preventDefault(); groupMenu(g, more, head); });
  dropTarget(head, g.id);
  return head;
}

function dropTarget(node, groupId) {
  node.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/hatch-chat')) return;
    e.preventDefault();
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop'));
  node.addEventListener('drop', e => {
    node.classList.remove('drop');
    const id = e.dataTransfer.getData('text/hatch-chat');
    if (id) moveChat(id, groupId);
  });
}

async function setChatFields(id, patch) {
  await api.setChat(id, patch);
  if (state.chat?.id === id) Object.assign(state.chat, patch);
  await refreshList();
  if (state.chat?.id === id) renderHeader();
}

const moveChat = (id, groupId) => setChatFields(id, { groupId });

function chatMenu(c, anchor) {
  const gs = groups();
  const items = [
    { label: 'Rename', icon: ICON.edit, onClick: () => startRename(anchor.closest('.chat-item'), c.title, t => setChatFields(c.id, { title: t })) },
    { label: c.hidden ? 'Unhide' : 'Hide', icon: c.hidden ? ICON.eye : ICON.eyeOff, desc: c.hidden ? '' : 'Keeps it out of the list (good for recording)', onClick: () => setChatFields(c.id, { hidden: !c.hidden }) },
    'sep',
    { note: 'Move to' },
    ...gs.map(g => ({ label: g.name, icon: ICON.folder, checked: c.groupId === g.id, onClick: () => moveChat(c.id, g.id) })),
    { label: 'No group', icon: ICON.list, checked: !c.groupId, onClick: () => moveChat(c.id, null) },
    { label: 'New group…', icon: ICON.folder, onClick: () => createGroup(c.id) },
    'sep',
    { label: 'Delete…', icon: ICON.err, danger: true, onClick: () => deleteChat(c) },
  ];
  openPopover(anchor, menu(items), { align: 'left' });
}

function groupMenu(g, anchor, head) {
  openPopover(anchor, menu([
    { label: 'Rename', icon: ICON.edit, onClick: () => startRename(head, g.name, t => saveGroups(groups().map(x => (x.id === g.id ? { ...x, name: t } : x)))) },
    { label: g.hidden ? 'Unhide group' : 'Hide group', icon: g.hidden ? ICON.eye : ICON.eyeOff, onClick: () => saveGroups(groups().map(x => (x.id === g.id ? { ...x, hidden: !x.hidden } : x))) },
    'sep',
    { label: 'Delete group', desc: 'Its chats move back to Chats', icon: ICON.err, danger: true, onClick: () => deleteGroup(g) },
  ]));
}

function startRename(row, current, onSave) {
  if (!row) return;
  const title = row.querySelector('.title');
  const input = el('<input class="rename-input">');
  input.value = current;
  title.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== current) onSave(v);
    else renderList();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function createGroup(moveChatId) {
  const g = { id: crypto.randomUUID(), name: 'New group', collapsed: false, hidden: false };
  saveGroups([...groups(), g]);
  if (moveChatId) await moveChat(moveChatId, g.id);   // finish re-drawing the list before the name box appears
  startRename(els.list.querySelector(`.group-head[data-id="${g.id}"]`), g.name,
    t => saveGroups(groups().map(x => (x.id === g.id ? { ...x, name: t } : x))));
}

async function deleteGroup(g) {
  for (const c of state.chats.filter(c => c.groupId === g.id)) await api.setChat(c.id, { groupId: null });
  saveGroups(groups().filter(x => x.id !== g.id));
  refreshList();
}

async function deleteChat(c) {
  const r = await confirmBox({
    title: 'Delete chat?',
    text: `"${c.title}" will be removed from Hatch.`,
    yes: 'Delete',
    danger: true,
    checkbox: "Also move its project folder to the Recycle Bin",
  });
  if (!r.ok) return;
  await api.deleteChat(c.id, { trashFolder: r.checked });
  if (c.id === state.chatId) newChat();
  else refreshList();
}

els.newGroup.addEventListener('click', () => createGroup(null));
els.toggleHidden.addEventListener('click', () => { state.showHidden = !state.showHidden; renderList(); });
