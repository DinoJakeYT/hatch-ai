// Overnight work: the moon button, the start dialog and the progress bar.

const night = {
  btn: $('nightBtn'), bar: $('nightBar'), text: $('nightText'), stop: $('nightStop'),
  dlg: $('nightDlg'), goal: $('nightGoal'), until: $('nightUntil'), start: $('nightStart'), status: $('nightStatus'),
};

const pad = n => String(n).padStart(2, '0');
const clockTime = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const timeLeft = ms => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

function overnightAvailable() {
  return splitModel(currentModel()).provider === 'local' && state.settings.localEngine !== 'claude';
}

function updateNightUi() {
  night.btn.hidden = !overnightAvailable() || state.running;
  const o = state.chat?.overnight;
  const live = !!o && state.running && ['running', 'finishing'].includes(o.status);
  night.bar.hidden = !live;
  if (!live) return;
  night.text.textContent = o.status === 'finishing'
    ? 'Wrapping up: checking the build and writing the morning report…'
    : `Working overnight until ${clockTime(o.until)} · ${timeLeft(o.until - Date.now())} left · session ${o.session} · `
      + `${o.checkpoints} checkpoint${o.checkpoints === 1 ? '' : 's'}${o.lastBuild ? ` · last build ${o.lastBuild === 'ok' ? 'OK' : 'failed'}` : ''}`;
}
setInterval(updateNightUi, 30000);

// "07:00" -> the next time it's 7:00 (tonight or tomorrow morning)
function untilFrom(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now() + 5 * 60000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function openNightDialog() {
  night.goal.value = els.input.value.trim() || night.goal.value;
  if (!night.until.value) night.until.value = '07:00';
  night.status.textContent = '';
  night.dlg.showModal();
  night.goal.focus();
}

night.dlg.querySelectorAll('[data-hours]').forEach(b => b.addEventListener('click', () => {
  const d = new Date(Date.now() + Number(b.dataset.hours) * 3600000);
  night.until.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}));
night.dlg.querySelectorAll('[data-until]').forEach(b => b.addEventListener('click', () => { night.until.value = b.dataset.until; }));

night.start.addEventListener('click', async () => {
  const goal = night.goal.value.trim();
  if (!goal) { night.status.textContent = 'Say what it should work on.'; return night.goal.focus(); }
  if (!night.until.value) { night.status.textContent = 'Pick when to stop.'; return; }
  const until = untilFrom(night.until.value);
  if (until - Date.now() < 10 * 60000) { night.status.textContent = 'Give it at least 10 minutes.'; return; }

  const wasNew = !state.chatId;
  const r = await api.startOvernight({ chatId: state.chatId, goal, until, model: currentModel(), cwd: state.draft.cwd });
  if (r.error) { night.status.textContent = r.error; return; }
  night.dlg.close();
  els.input.value = '';
  autosize();
  if (wasNew) {
    state.chatId = r.chatId;
    state.chat = r.chat;
    renderChat();
  }
  setRunning(true);
  refreshList();
});

night.btn.addEventListener('click', openNightDialog);
night.stop.addEventListener('click', async () => {
  const r = await confirmBox({
    title: 'Stop overnight work?',
    text: 'It stops after the current step, makes sure the project is at a working version, and writes its report.',
    yes: 'Stop',
  });
  if (r.ok) api.stopOvernight(state.chatId);
});

api.onChatEvent(ev => {
  if (ev.kind !== 'overnight' || ev.chatId !== state.chatId || !state.chat) return;
  state.chat.overnight = ev.state;
  updateNightUi();
});
api.onOpenChat(id => openChat(id));
