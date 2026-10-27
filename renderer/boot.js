// Startup and the remaining wiring.

async function loadConnections(refresh = false) {
  state.conn = await api.connections({ refresh });
  renderHeader();
  if ($('settings').open) renderSettingsAll();
}

els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});
els.send.addEventListener('click', () => (state.running && !els.input.value.trim() ? api.stop(state.chatId) : sendMessage()));
els.newChat.addEventListener('click', newChat);
els.settingsBtn.addEventListener('click', () => openSettings());
els.bannerBtn.addEventListener('click', () => onBannerAction(els.bannerBtn.dataset.action));
els.bannerBtn2.addEventListener('click', () => onBannerAction(els.bannerBtn2.dataset.action));

els.folderBtn.addEventListener('click', async () => {
  if (state.chat) return api.openPath(state.chat.cwd);
  const dir = await api.pickFolder();
  if (dir) { state.draft.cwd = dir; renderHeader(); }
});

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openPicker(); }
});

// re-check sign-ins and Ollama when the window comes back into focus
let lastFocusCheck = Date.now();
window.addEventListener('focus', () => {
  if (Date.now() - lastFocusCheck < 30000) return;
  lastFocusCheck = Date.now();
  loadConnections(true);
});

(async () => {
  state.settings = await api.getSettings();
  newChat();
  await Promise.all([loadConnections(), loadUsage()]);
  // first run: a starter team (lead + a local coder), so teams show up in the AI menu
  if (state.settings.teams == null) {
    const t = starterTeam('');
    t.name = `${providerName(splitModel(t.lead).provider)} + local coder`;
    saveTeams(bestLocalModel() ? [t] : []);
  }
  renderHeader();
})();
