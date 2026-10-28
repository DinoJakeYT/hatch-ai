// Hatch: a desktop chat app where each chat can use a different AI (Claude, ChatGPT,
// Gemini, OpenRouter, a custom endpoint or local Ollama models) and shows the AI's
// work as it builds things in the chat's own project folder.
import {
  APP_DIR, CHATS_DIR, PROJECTS_DIR, ICON, NODE_EXE, PERMISSIONS,
  settings, saveSettings, setKey, keyHint, parseModel, engineFor, migrateFromClaude2, PROVIDERS,
} from './lib/config.mjs';
import { app, BrowserWindow, ipcMain, shell, dialog, Menu, powerSaveBlocker, Notification } from 'electron';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import * as usage from './lib/usage.mjs';
import * as memory from './lib/memory.mjs';
import * as signin from './lib/signin.mjs';
import * as toolchain from './lib/toolchain.mjs';
import * as guides from './lib/guides.mjs';
import * as skills from './lib/skills.mjs';
import * as libs from './lib/libs.mjs';
import * as overnight from './lib/overnight.mjs';
import * as teams from './lib/teams.mjs';
import * as checkpoints from './lib/checkpoints.mjs';
import * as localModels from './lib/models.mjs';
import * as updater from './lib/updater.mjs';
import * as remote from './lib/remote.mjs';
import * as claudeEngine from './engines/claude.mjs';
import * as codexEngine from './engines/codex.mjs';
import * as geminiEngine from './engines/gemini.mjs';
import * as localEngine from './engines/local.mjs';

const ENGINES = { claude: claudeEngine, codex: codexEngine, gemini: geminiEngine, local: localEngine };
const MAX_RESULT_CHARS = 8000;

// The installed app's id must match its installer's shortcuts for notifications: keep it the same as
// build.appId in package.json (the installer leaves the "build" part out of the copy it installs).
const PKG = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const APP_ID = app.isPackaged ? 'com.dinojakeyt.hatch' : 'Hatch';
app.setAppUserModelId(APP_ID);
if (!app.requestSingleInstanceLock()) app.quit();
migrateFromClaude2();

// screenshots older than a week aren't needed any more
try {
  const dir = path.join(app.getPath('userData'), 'previews');
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400e3) fs.rmSync(p, { force: true });
  }
} catch {}

let win = null;
const chats = new Map();          // id -> chat (loaded lazily)
const runs = new Map();           // chatId -> { abort }
const pendingPerms = new Map();   // reqId -> { chatId, resolve, idx }

// ---------- storage ----------

const chatFile = id => path.join(CHATS_DIR, `${id}.json`);

function loadChat(id) {
  if (chats.has(id)) return chats.get(id);
  try {
    const chat = JSON.parse(fs.readFileSync(chatFile(id), 'utf8'));
    chat.sessions ||= {};
    chat.permission ||= settings.defaultPermission;
    // nothing is running right after loading: Hatch was closed mid-step last time
    for (const it of chat.items) {
      if (it.type === 'tool' && it.status === 'running') it.status = 'stopped';
      if (it.perm?.status === 'pending') it.perm.status = 'denied';
    }
    if (chat.overnight && ['running', 'finishing'].includes(chat.overnight.status)) chat.overnight.status = 'stopped';
    for (const it of chat.items) if (it.queued) delete it.queued;   // messages that were waiting when Hatch closed
    chat.inbox = [];
    chats.set(id, chat);
    return chat;
  } catch {
    return null;
  }
}

function saveChat(chat, touch = true) {
  if (touch) chat.updatedAt = Date.now();
  const tmp = chatFile(chat.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(chat));
  fs.renameSync(tmp, chatFile(chat.id));
}

const saveTimers = new Map();
function saveSoon(chat) {
  if (saveTimers.has(chat.id)) return;
  saveTimers.set(chat.id, setTimeout(() => { saveTimers.delete(chat.id); saveChat(chat); }, 1000));
}

function listChats() {
  const out = [];
  for (const f of fs.readdirSync(CHATS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const c = loadChat(f.slice(0, -5));
    if (c) out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, running: runs.has(c.id), overnight: !!runs.get(c.id)?.overnight, groupId: c.groupId || null, hidden: !!c.hidden, model: c.model });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function makeTitle(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? t.slice(0, 47) + '…' : t || 'New chat';
}

function makeProjectDir(title, id) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'chat';
  const dir = path.join(PROJECTS_DIR, `${slug}-${id.slice(0, 4)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- events to the window ----------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  if (channel === 'chat:event') remote.broadcast(channel, payload);   // phones see the chats live too
}
const emit = (chatId, ev) => send('chat:event', { chatId, ...ev });

// ---------- live activity: who is working on what right now (the bar above the message box) ----------

const activity = new Map();         // chatId -> Map(agent -> { agent, model, status, since, statusSince })
const activityTimers = new Map();
const activityList = chatId => [...(activity.get(chatId)?.values() || [])];

function setActivity(chatId, agent, model, status) {
  let list = activity.get(chatId);
  if (!list) activity.set(chatId, list = new Map());
  const cur = list.get(agent);
  if (status == null) {
    if (!cur) return;
    list.delete(agent);
  } else if (cur?.status === status) {
    return;
  } else {
    list.set(agent, { agent, model, status, since: cur?.since || Date.now(), statusSince: Date.now() });
  }
  if (activityTimers.has(chatId)) return;
  activityTimers.set(chatId, setTimeout(() => {
    activityTimers.delete(chatId);
    emit(chatId, { kind: 'activity', list: activityList(chatId) });
  }, 150));
}

function clearActivity(chatId) {
  activity.delete(chatId);
  emit(chatId, { kind: 'activity', list: [] });
}

function resultText(content) {
  let text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(c => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n')
      : '';
  if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + '\n… (trimmed)';
  return text;
}

// Earlier messages, for when a chat switches to an AI that hasn't seen it yet.
function carryOver(chat) {
  const lines = [];
  let total = 0;
  for (let i = chat.items.length - 1; i >= 0 && total < 6000; i--) {
    const it = chat.items[i];
    if (it.type !== 'user' && it.type !== 'assistant') continue;
    const t = it.text.length > 700 ? it.text.slice(0, 700) + '…' : it.text;
    lines.unshift(`${it.type === 'user' ? 'User' : 'Assistant'}: ${t}`);
    total += t.length;
  }
  return lines.join('\n\n');
}

// Claude-family providers share Claude sessions; other endpoints get their own.
function sessionKey(provider) {
  const engine = engineFor(provider);
  if (engine === 'local') return 'hatch-local';
  if (engine !== 'claude') return engine;
  return provider === 'sub' || provider === 'api' ? 'claude' : provider;
}

// ---------- running a turn ----------

function pushItem(chat, item) {
  chat.items.push(item);
  emit(chat.id, { kind: 'item-add', index: chat.items.length - 1, item });
  saveSoon(chat);
  return chat.items.length - 1;
}

// Something to tell the AI along with the user's next message (an undo, a decided skill proposal...).
function noteForAI(chat, text) {
  chat.pendingNote = chat.pendingNote ? `${chat.pendingNote} ${text}` : text;
  saveSoon(chat);
}

function patchItem(chat, index, patch) {
  if (!chat.items[index]) return;
  Object.assign(chat.items[index], patch);
  emit(chat.id, { kind: 'item-update', index, patch });
  saveSoon(chat);
}

// ---------- messages sent while the AI works ----------
// They wait in the chat's inbox. Claude gets them after its next step (a hook), Hatch's local agent at
// its next round, and anything still waiting when the turn ends starts the next turn.

function takeInbox(chat) {
  const list = chat.inbox || [];
  chat.inbox = [];
  for (const m of list) patchItem(chat, m.idx, { queued: 'seen' });
  return list.map(m => m.text);
}

const steerNote = texts => [
  `The user sent ${texts.length === 1 ? 'a new message' : 'new messages'} while you were working:`,
  ...texts.map(t => `<message>\n${t}\n</message>`),
  `Take ${texts.length === 1 ? 'it' : 'them'} into account from now on: if it changes the plan, adjust what you're doing; if it's a question, answer it briefly in your next reply. Don't drop the work you're in the middle of unless the user asks you to.`,
].join('\n');

// session: a turn something else runs ({ abort, overnight?, helper? }): an overnight session or a
// team helper doing a task for the lead. No user bubble, the caller owns the running state, and
// errors are thrown back to it. userIdx: the user's message this turn answers, when it's already shown.
async function runTurn(chat, text, session = null, { userIdx = -1 } = {}) {
  const helper = session?.helper || null;
  const team = helper ? null : teams.teamFor(chat);
  if (team) chat.model = team.lead;
  const { provider, model } = parseModel(helper ? helper.model : chat.model);
  const engineName = engineFor(provider);
  const engine = ENGINES[engineName];
  // helpers keep their own conversation per chat, apart from the lead's
  const key = helper ? `team:${helper.name}:${sessionKey(provider)}` : sessionKey(provider);
  const history = helper || chat.sessions[key] ? '' : carryOver(chat);
  const label = helper ? { agent: helper.name, agentModel: helper.model } : team ? { agent: 'Lead', agentModel: team.lead } : null;
  const leads = team && engineName !== 'gemini';   // Gemini can't be given the delegate tool
  const start = chat.items.length;
  const who = label?.agent || '';                  // whose line this is in the activity bar
  const activityNow = status => setActivity(chat.id, who, helper ? helper.model : chat.model, status);
  activityNow('Starting');

  const addItem = item => {
    if (item.type === 'assistant' || item.type === 'tool') item.by = provider;
    if (label && item.type !== 'user') Object.assign(item, label);
    return pushItem(chat, item);
  };
  const updateItem = (index, patch) => {
    Object.assign(chat.items[index], patch);
    emit(chat.id, { kind: 'item-update', index, patch });
    saveSoon(chat);
  };
  const findTool = id => {
    for (let i = chat.items.length - 1; i >= 0; i--) if (chat.items[i].type === 'tool' && chat.items[i].id === id) return i;
    return -1;
  };

  if (!session) {
    if (userIdx < 0) userIdx = addItem({ type: 'user', text, model: chat.model });
    saveChat(chat);
  }

  const blocked = usage.budgetBlock(provider);
  if (blocked) {
    addItem({ type: 'error', text: blocked });
    activityNow(null);
    saveChat(chat);
    return;
  }

  const abort = session ? session.abort : new AbortController();
  if (!session) {
    runs.set(chat.id, { abort });
    emit(chat.id, { kind: 'status', running: true });
  }
  let reported = false;
  await toolchain.ready;   // leads are told what this PC can build with

  // Undo: save the project as it is, before the AI touches it
  if (!session) {
    activityNow('Saving a checkpoint (for Undo)');
    const cp = await checkpoints.save(chat.id, chat.cwd, `Before: ${text}`).catch(() => null);
    if (cp) updateItem(userIdx, { checkpoint: cp });
  }
  // something the AI should know first, like the user having undone its last changes
  const aside = !session && chat.pendingNote ? `(${chat.pendingNote})\n\n` : '';
  if (aside) chat.pendingNote = null;

  // A cloud lead hands out tasks in the background and keeps working; a local lead waits for the
  // report, since it would only compete with its helpers for the GPU.
  const background = provider !== 'local';
  const parent = { abort, overnight: !!session?.overnight, background };
  const canPropose = !helper && engineName !== 'gemini';   // Gemini can't be given Hatch's tools
  const ctx = {
    chat, provider, model,
    overnight: !!session?.overnight,
    helper: !!helper,
    noEdits: helper?.canEdit === false,   // a reviewer: may read, build and run, but not change files
    permission: PERMISSIONS.includes(chat.permission) ? chat.permission : settings.defaultPermission,
    text: history ? `Earlier in this chat (possibly with a different AI):\n${history}\n\nNew message from the user:\n${aside}${text}` : `${aside}${text}`,
    instructions: memory.buildInstructions({ local: provider === 'local', engine: engineName }) + (leads ? teams.leadNote(team, engineName, background) : '')
      + (canPropose ? skills.proposeNote(engineName) : ''),
    // where the local engine keeps its conversation and plan
    store: helper ? ((chat.helperState ||= {})[helper.name] ||= {}) : chat,
    // leads can hand work to their helpers
    team: leads ? {
      helpers: team.helpers,
      background,
      delegate: (name, task) => runHelper(chat, team, name, task, parent),   // waits for the report
      start: (name, task) => startJob(chat, team, name, task, parent),       // returns at once
      wait: () => waitJobs(chat, abort.signal),
    } : null,
    activity: activityNow,
    // messages the user sent while this turn is working (helpers don't get them: the lead does)
    takeMessages: helper ? () => [] : () => takeInbox(chat),
    steerNote,
    // the lead (never a helper) can propose a new skill; the user approves or declines it in the chat
    proposeSkill: canPropose ? ({ name, description, instructions }) => {
      const desc = String(description || '').replace(/\s+/g, ' ').trim();
      const body = String(instructions || '').trim();
      if (!String(name || '').trim() || !desc || !body) return { ok: false, text: 'A skill needs a name, a one-line description of when to use it, and the instructions.' };
      if (chat.items.filter(i => i.name === 'SkillProposal' && i.status === 'pending').length >= 3) {
        return { ok: false, text: 'Three skill proposals are already waiting for the user. Don\'t propose more for now.' };
      }
      const id = skills.skillId(name);
      addItem({ type: 'tool', id: `skill-${Date.now()}`, name: 'SkillProposal', status: 'pending', input: { name: id, description: desc, body, replaces: skills.exists(id) } });
      return { ok: true, text: `Sent the skill "${id}" to the user for approval (it shows in the chat). Carry on with your work; don't wait for the answer.` };
    } : null,
    sessionId: chat.sessions[key] || null,
    abort,
    signal: abort.signal,
    addItem,
    updateItem,
    findTool,
    appendText: (index, delta) => {
      chat.items[index].text += delta;
      emit(chat.id, { kind: 'item-update', index, patch: { text: chat.items[index].text } });
      saveSoon(chat);
    },
    toolResult: (id, content, isError) => {
      const idx = findTool(id);
      if (idx < 0) return;
      const denied = chat.items[idx].perm?.status === 'denied';
      updateItem(idx, { result: resultText(content), status: denied ? 'denied' : isError ? 'error' : 'done' });
    },
    askPermission: (toolName, input, toolUseId, signal) => {
      const reqId = crypto.randomUUID();
      let idx = findTool(toolUseId);
      if (idx < 0) idx = addItem({ type: 'tool', id: toolUseId, name: toolName, input, status: 'running' });
      updateItem(idx, { input, perm: { reqId, status: 'pending' } });
      return new Promise(resolve => {
        pendingPerms.set(reqId, { chatId: chat.id, resolve, idx });
        signal?.addEventListener('abort', () => { if (pendingPerms.delete(reqId)) resolve(false); });
      });
    },
    setSession: id => { if (id) chat.sessions[key] = id; },
    reportUsage: t => { usage.recordTurn(provider, t); send('usage:changed'); },
    noteRateLimit: info => { usage.noteClaudeRateLimit(info); send('usage:changed'); },
    fail: (message, { replacesLastReply } = {}) => {
      reported = true;
      if (usage.noteError(provider, message)) send('usage:changed');
      const last = chat.items.length - 1;
      if (chat.items[last]?.type === 'error' && chat.items[last].text === message) return;   // engines can report one failure twice
      if (replacesLastReply && chat.items[last]?.type === 'assistant' && chat.items[last].text.trim() === message.trim()) {
        updateItem(last, { type: 'error' });
      } else {
        addItem({ type: 'error', text: message });
      }
    },
  };

  try {
    let result = await engine.run(ctx);
    // the lead finished its turn while helpers are still working: wait for them, then let it check their work
    while (ctx.team?.background && !abort.signal.aborted && jobsPending(chat)) {
      activityNow('Waiting for helpers to finish');
      const reports = await waitJobs(chat, abort.signal);
      if (abort.signal.aborted || !reports) break;
      addItem({ type: 'note', text: 'Helpers finished. The lead is checking their work.' });
      activityNow('Checking the helpers\' work');
      result = await engine.run({
        ...ctx,
        text: `Your helpers finished. Their reports:\n\n${reports}\n\nCheck their work (look at the files, build and run it), fix or hand out what's still wrong, then tell the user where things stand.`,
        sessionId: chat.sessions[key] || null,
      });
    }
    return result;
  } catch (err) {
    if (abort.signal.aborted) { if (!helper) addItem({ type: 'note', text: 'Stopped' }); }
    else if (session) throw err;
    else if (!reported) ctx.fail(String(err?.message || err));
  } finally {
    if (!helper) {
      for (const [reqId, p] of pendingPerms) {
        if (p.chatId === chat.id) { pendingPerms.delete(reqId); p.resolve(false); }
      }
    }
    // a helper finishing must not touch the lead's cards, which may still be running
    chat.items.forEach((it, i) => {
      if (i >= start && it.type === 'tool' && it.status === 'running' && (!helper || it.agent === helper.name)) updateItem(i, { status: 'stopped' });
    });
    activityNow(null);
    if (!session) {
      runs.delete(chat.id);
      teamJobs.delete(chat.id);
      clearActivity(chat.id);
      emit(chat.id, { kind: 'status', running: false });
      // messages that arrived too late for this turn start the next one
      if (chat.inbox?.length) {
        const queued = chat.inbox.splice(0);
        for (const m of queued) patchItem(chat, m.idx, { queued: null });
        setTimeout(() => runTurn(chat, queued.map(m => m.text).join('\n\n'), null, { userIdx: queued[0].idx }), 0);
      }
    }
    saveChat(chat);
    if (!helper) memory.autoCompressMemory().then(r => { if (r) send('memory:changed'); }).catch(() => {});
  }
}

// ---------- teams: helpers doing tasks for the lead ----------

// Helpers work at the same time (unless the team says one at a time). A helper that's busy gets a
// copy ("Coder #2", with its own conversation) so one helper can take several tasks at once.
const MAX_COPIES = 3;
const slots = new Map();         // queue key -> { used: Set of slot numbers, waiters }
const activeHelpers = new Map(); // chatId -> Set of running helper runs

async function takeSlot(key, max) {
  const s = slots.get(key) || { used: new Set(), waiters: [] };
  slots.set(key, s);
  for (;;) {
    for (let i = 1; i <= max; i++) if (!s.used.has(i)) { s.used.add(i); return i; }
    await new Promise(r => s.waiters.push(r));
  }
}

function freeSlot(key, i) {
  const s = slots.get(key);
  s.used.delete(i);
  s.waiters.shift()?.();
  if (!s.used.size && !s.waiters.length) slots.delete(key);
}

// Small models sometimes use the helper's model name instead of its name; with one helper, any name means it.
function findHelper(team, name) {
  const want = String(name || '').trim().toLowerCase();
  return team.helpers.find(h => h.name.trim().toLowerCase() === want)
    || (want && team.helpers.find(h => h.model.toLowerCase().includes(want) || teams.modelName(h.model).toLowerCase().includes(want)))
    || (team.helpers.length === 1 ? team.helpers[0] : null);
}

// Why a task can't be handed to this helper at all ('' when it can).
function cantDelegate(team, helper, name, task) {
  if (!helper) return `There's no helper called "${name}". Your helpers: ${team.helpers.map(h => h.name).join(', ')}.`;
  if (!String(task || '').trim()) return 'The task was empty. Describe what the helper should do.';
  const why = teams.notReady(parseModel(helper.model).provider) || usage.budgetBlock(parseModel(helper.model).provider);
  return why ? `${helper.name} can't work right now: ${why} Do this part yourself or ask another helper.` : '';
}

async function runHelper(chat, team, name, task, parent) {
  const helper = findHelper(team, name);
  const why = cantDelegate(team, helper, name, task);
  if (why) return { ok: false, text: why };
  const { provider } = parseModel(helper.model);

  // Local models share one GPU: two at once (or switching between models) makes Ollama reload and
  // re-read everything, which is far slower than taking turns. Cloud AIs really work in parallel.
  const parallel = team.parallel !== false;
  const onGpu = provider === 'local';
  const key = onGpu ? 'ollama' : parallel ? `${chat.id}:${helper.name}` : chat.id;
  if (slots.get(key)?.used.size >= (onGpu || !parallel ? 1 : MAX_COPIES)) {
    setActivity(chat.id, helper.name, helper.model, onGpu ? 'Waiting for the GPU (a local model is busy)' : 'Waiting its turn');
  }
  const slot = await takeSlot(key, onGpu || !parallel ? 1 : MAX_COPIES);
  const me = slot === 1 ? helper : { ...helper, name: `${helper.name} #${slot}` };
  if (me !== helper) setActivity(chat.id, helper.name, helper.model, null);
  const active = activeHelpers.get(chat.id) || new Set();
  activeHelpers.set(chat.id, active);
  // while the lead or other helpers also change files, only the helper's own cards say what it changed
  const run = { overlapped: parent.background };
  active.add(run);
  if (active.size > 1) for (const r of active) r.overlapped = true;
  try {
    if (parent.abort.signal.aborted) return { ok: false, text: 'Stopped.' };
    const files = teams.snapshot(chat.cwd);
    const start = chat.items.length;
    let result = null;
    let error = '';
    try {
      result = await runTurn(chat, teams.helperPrompt(me, team, task), { abort: parent.abort, overnight: parent.overnight, helper: me });
    } catch (err) {
      error = String(err?.message || err);
    }
    const mine = chat.items.slice(start).filter(i => i.agent === me.name);
    const changes = run.overlapped ? teams.filesFromItems(mine, chat.cwd) : teams.changedSince(chat.cwd, files);
    return { ...teams.report(me, mine, changes, result, error), agent: me.name, provider, model: me.model };
  } finally {
    active.delete(run);
    if (!active.size) activeHelpers.delete(chat.id);
    freeSlot(key, slot);
  }
}

// ---------- background jobs: a cloud lead keeps working while its helpers do their tasks ----------

const teamJobs = new Map();   // chatId -> Map(job id -> { id, name, task, promise, done, delivered, report })

function startJob(chat, team, name, task, parent) {
  const helper = findHelper(team, name);
  const why = cantDelegate(team, helper, name, task);
  if (why) return { ok: false, text: why };
  let jobs = teamJobs.get(chat.id);
  if (!jobs) teamJobs.set(chat.id, jobs = new Map());
  const job = { id: jobs.size + 1, name: helper.name, task, done: false, delivered: false, report: null };
  jobs.set(job.id, job);
  job.promise = runHelper(chat, team, helper.name, task, parent).then(r => {
    job.done = true;
    job.report = r;
    // the report shows in the chat as soon as it arrives
    pushItem(chat, {
      type: 'tool', id: `hl-report-${Date.now()}-${job.id}`, name: 'HelperReport', status: r.ok ? 'done' : 'error',
      input: { agent: r.agent || helper.name, task }, result: r.text,
      by: r.provider || parseModel(helper.model).provider, agent: r.agent || helper.name, agentModel: r.model || helper.model,
    });
    return r;
  });
  return {
    ok: true,
    text: `Job ${job.id} started: ${helper.name} is working on it now. Keep working on other parts (not the files you gave ${helper.name}). Call wait_for_helpers when you need the reports; if you finish first, Hatch waits for your helpers and then gives you their reports.`,
  };
}

const jobsPending = chat => [...(teamJobs.get(chat.id)?.values() || [])].some(j => !j.delivered);

// Waits for every job that hasn't reported yet, and returns their reports.
async function waitJobs(chat, signal) {
  const open = [...(teamJobs.get(chat.id)?.values() || [])].filter(j => !j.delivered);
  if (!open.length) return '';
  await Promise.race([Promise.all(open.map(j => j.promise)), new Promise(r => signal.addEventListener('abort', r, { once: true }))]);
  const done = open.filter(j => j.done);
  for (const j of done) j.delivered = true;
  return done.map(j => `Job ${j.id} (${j.report.agent || j.name}): ${j.report.text}`).join('\n\n---\n\n');
}

// ---------- overnight work (local models) ----------

async function startOvernight(chat, { goal, until }) {
  const abort = new AbortController();
  runs.set(chat.id, { abort, overnight: true });
  emit(chat.id, { kind: 'status', running: true });
  pushItem(chat, { type: 'user', text: goal, model: chat.model });
  pushItem(chat, { type: 'note', text: `Working overnight until ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Hatch keeps the PC awake and saves a checkpoint after every working build.` });
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  const { model } = parseModel(chat.model);

  try {
    await overnight.run({
      chat, goal, until, model,
      signal: abort.signal,
      runSession: text => runTurn(chat, text, { abort, overnight: true }),
      verify: () => localEngine.verifyProject(chat.cwd),
      note: text => pushItem(chat, { type: 'note', text }),
      report: text => pushItem(chat, { type: 'assistant', text, by: 'local' }),
      onState: state => {
        chat.overnight = state;
        saveSoon(chat);
        emit(chat.id, { kind: 'overnight', state });
      },
    });
  } catch (err) {
    pushItem(chat, { type: 'error', text: `Overnight work stopped: ${err.message}` });
  } finally {
    powerSaveBlocker.stop(blocker);
    runs.delete(chat.id);
    saveChat(chat);
    emit(chat.id, { kind: 'status', running: false });
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'Hatch: overnight work finished', body: chat.title, icon: ICON });
      n.on('click', () => { win?.show(); win?.focus(); send('open-chat', chat.id); });
      n.show();
    }
  }
}

ipcMain.handle('overnight:start', (_e, { chatId, goal, until, model, cwd }) => {
  let chat = chatId && loadChat(chatId);
  if (!chat) {
    const id = crypto.randomUUID();
    const title = makeTitle(goal);
    chat = {
      id, title, createdAt: Date.now(), updatedAt: Date.now(), cwd: cwd || makeProjectDir(title, id),
      model, permission: 'always', sessions: {}, groupId: null, hidden: false, items: [],
    };
    chats.set(id, chat);
  }
  if (runs.has(chat.id)) return { error: 'This chat is busy.' };
  if (model) chat.model = model;
  if (engineFor(parseModel(chat.model).provider) !== 'local') return { error: 'Overnight work is for local models (with Hatch tools).' };
  saveChat(chat);
  startOvernight(chat, { goal, until });
  return { chatId: chat.id, chat: { ...chat, running: true } };
});

ipcMain.handle('overnight:stop', (_e, id) => { runs.get(id)?.abort.abort(); });

// ---------- IPC: chats ----------

ipcMain.handle('chats:list', () => listChats());

ipcMain.handle('chat:get', (_e, id) => {
  const chat = loadChat(id);
  return chat && { ...chat, running: runs.has(id), activity: activityList(id) };
});

ipcMain.handle('chat:send', (_e, args) => sendToChat(args));

// A message from the window or a phone: starts a turn (and a new chat when there's no chatId).
function sendToChat({ chatId, text, model, team, cwd, permission }) {
  let chat = chatId && loadChat(chatId);
  if (!chat) {
    const id = crypto.randomUUID();
    const title = makeTitle(text);
    chat = {
      id, title, createdAt: Date.now(), updatedAt: Date.now(),
      cwd: cwd || makeProjectDir(title, id),
      model: model || 'sub:', team: team || null, permission: permission || settings.defaultPermission,
      sessions: {}, groupId: null, hidden: false, items: [],
    };
    chats.set(id, chat);
    saveChat(chat);
  }
  // the AI is working: the message waits for its next step
  if (runs.has(chat.id)) {
    const idx = pushItem(chat, { type: 'user', text, model: chat.model, queued: 'waiting' });
    (chat.inbox ||= []).push({ text, idx });
    return { chatId: chat.id, queued: true };
  }
  if (model) chat.model = model;
  if (team !== undefined) chat.team = team || null;
  if (permission) chat.permission = permission;
  runTurn(chat, text);
  return { chatId: chat.id, chat: { ...chat, running: true } };
}

ipcMain.handle('chat:stop', (_e, id) => { runs.get(id)?.abort.abort(); });

ipcMain.handle('chat:set', (_e, id, patch) => {
  const chat = loadChat(id);
  if (!chat) return;
  for (const k of ['title', 'groupId', 'hidden', 'model', 'team', 'permission']) if (k in patch) chat[k] = patch[k];
  saveChat(chat, false);
});

// Deleting removes the chat; its project folder goes to the Recycle Bin only if asked.
ipcMain.handle('chat:delete', async (_e, id, { trashFolder = false } = {}) => {
  runs.get(id)?.abort.abort();
  const chat = loadChat(id);
  chats.delete(id);
  fs.rmSync(chatFile(id), { force: true });
  checkpoints.forget(id);
  if (trashFolder && chat?.cwd) {
    const rel = path.relative(PROJECTS_DIR, chat.cwd);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(chat.cwd)) await shell.trashItem(chat.cwd);
  }
});

// ---------- IPC: undo and redo ----------

ipcMain.handle('chat:undo', (_e, id, index) => undoChat(id, index));
ipcMain.handle('chat:redo', (_e, id, index) => redoChat(id, index));

async function undoChat(id, index) {
  const chat = loadChat(id);
  const it = chat?.items[index];
  if (!it?.checkpoint) return { error: 'There\'s no saved version from before this message.' };
  if (runs.has(id)) return { error: 'The AI is still working on the files. Stop it first.' };
  try {
    const r = await checkpoints.restore(id, chat.cwd, it.checkpoint);
    const short = makeTitle(it.text);
    pushItem(chat, {
      type: 'note', redo: r.redo,
      text: `Put the project back to how it was before "${short}".${r.problems.length ? ` Some files couldn't be changed (open in another program?): ${r.problems.join(', ')}` : ''}`,
    });
    chat.pendingNote = `The user undid every file change made after their message "${short}": the project files are back to how they were before it.`;
    saveChat(chat);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

async function redoChat(id, index) {
  const chat = loadChat(id);
  const it = chat?.items[index];
  if (!it?.redo) return { error: 'Nothing to bring back.' };
  if (runs.has(id)) return { error: 'The AI is still working on the files. Stop it first.' };
  try {
    const r = await checkpoints.restore(id, chat.cwd, it.redo);
    patchItem(chat, index, { redo: null });
    pushItem(chat, { type: 'note', text: `Brought the undone changes back.${r.problems.length ? ` Some files couldn't be changed: ${r.problems.join(', ')}` : ''}` });
    chat.pendingNote = 'The user brought back the file changes they had undone.';
    saveChat(chat);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

// ---------- IPC: playing what was built ----------

const PLAY_DIRS = ['', 'build', 'bin', 'dist', 'out', 'Release', 'Debug', 'x64/Release', 'x64/Debug'];

// Programs, web pages and Python scripts in the project, newest first.
function runnables(cwd) {
  const out = [];
  for (const sub of PLAY_DIRS) {
    let names;
    try { names = fs.readdirSync(path.join(cwd, sub)); } catch { continue; }
    for (const name of names) {
      const abs = path.join(cwd, sub, name);
      const kind = /\.exe$/i.test(name) ? 'program' : !sub && /\.html?$/i.test(name) ? 'page' : !sub && /\.py$/i.test(name) ? 'python' : null;
      if (!kind) continue;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        // only Python files meant to be run, not every module
        if (kind === 'python' && !/^(main|game|app|run)\.py$/i.test(name) && !/__main__|import pygame|import tkinter/.test(fs.readFileSync(abs, 'utf8'))) continue;
        out.push({ name: path.join(sub, name).replace(/\\/g, '/'), kind, mtime: st.mtimeMs });
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 12);
}

// 2 = a window program, 3 = a console program (read from the .exe's header)
function exeSubsystem(abs) {
  try {
    const buf = Buffer.alloc(1024);
    const fd = fs.openSync(abs, 'r');
    fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    const pe = buf.readUInt32LE(0x3c);
    return pe + 0x5e <= buf.length ? buf.readUInt16LE(pe + 0x5c) : 3;
  } catch {
    return 3;
  }
}

ipcMain.handle('project:runnables', (_e, id) => {
  const chat = loadChat(id);
  return chat?.cwd ? runnables(chat.cwd) : [];
});

ipcMain.handle('project:play', async (_e, id, name) => {
  const chat = loadChat(id);
  const target = chat && runnables(chat.cwd).find(r => r.name === name);
  if (!target) return { error: `${name} isn't in the project folder any more.` };
  const abs = path.join(chat.cwd, target.name);
  const dir = path.dirname(abs);
  if (target.kind === 'page') {
    const err = await shell.openPath(abs);
    return err ? { error: err } : { ok: true };
  }
  // console programs get a window that stays open, so their output can be read
  const inConsole = cmd => spawn('cmd.exe', ['/d', '/s', '/c', `start "${path.basename(abs)}" /D "${dir}" cmd /k ${cmd}`],
    { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  if (target.kind === 'python') inConsole(`python "${abs}"`);
  else if (exeSubsystem(abs) === 2) spawn(abs, [], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
  else inConsole(`"${abs}"`);
  return { ok: true };
});

ipcMain.handle('groups:set', (_e, groups) => {
  settings.groups = groups;
  saveSettings();
});

ipcMain.handle('perm:respond', (_e, reqId, decision) => respondPermission(reqId, decision));

function respondPermission(reqId, decision) {
  const p = pendingPerms.get(reqId);
  if (!p) return;
  pendingPerms.delete(reqId);
  const chat = loadChat(p.chatId);
  if (decision === 'always') {
    chat.permission = 'always';
    emit(chat.id, { kind: 'permission', permission: 'always' });
  }
  const allowed = decision !== 'deny';
  Object.assign(chat.items[p.idx], { perm: { reqId, status: allowed ? 'allowed' : 'denied' }, ...(allowed ? {} : { status: 'denied' }) });
  emit(chat.id, { kind: 'item-update', index: p.idx, patch: chat.items[p.idx] });
  p.resolve(allowed);
}

ipcMain.handle('folder:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));

// ---------- IPC: connections ----------

async function ollamaModels() {
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    return {
      ok: true,
      models: (data.models || []).map(m => ({
        name: m.name, size: m.details?.parameter_size || '',
        tools: !m.capabilities || m.capabilities.includes('tools'),
        vision: (m.capabilities || []).includes('vision'),
      })),
    };
  } catch {
    return { ok: false, models: [], error: `Can't reach Ollama at ${settings.ollamaUrl}` };
  }
}

const loginCache = { sub: null, chatgpt: null };

ipcMain.handle('connections:get', async (_e, { refresh = false } = {}) => {
  if (refresh || !loginCache.sub) [loginCache.sub, loginCache.chatgpt] = await Promise.all([signin.status('sub'), signin.status('chatgpt')]);
  return {
    logins: loginCache,
    keys: Object.fromEntries(['anthropic', 'openai', 'gemini', 'openrouter', 'custom'].map(k => [k, keyHint(k)])),
    ollama: await ollamaModels(),
    nodeOk: !!NODE_EXE,
  };
});

ipcMain.handle('auth:signin', (_e, provider) => {
  signin.signIn(provider, win, async ev => {
    loginCache[provider] = await signin.status(provider);
    send('auth:event', { ...ev, status: loginCache[provider] });
  });
});
ipcMain.handle('auth:browser', () => signin.openInBrowser());
ipcMain.handle('auth:cancel', () => signin.cancel());
ipcMain.handle('auth:signout', async (_e, provider) => {
  await signin.signOut(provider);
  loginCache[provider] = await signin.status(provider);
  return loginCache[provider];
});

ipcMain.handle('keys:set', (_e, name, value) => { setKey(name, value); return keyHint(name); });

let openRouterCache = { at: 0, models: [] };
ipcMain.handle('openrouter:models', async () => {
  if (Date.now() - openRouterCache.at < 6 * 3600e3 && openRouterCache.models.length) return openRouterCache.models;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10000) });
    const data = (await res.json()).data || [];
    openRouterCache = {
      at: Date.now(),
      models: data.filter(m => (m.supported_parameters || []).includes('tools')).map(m => ({ id: m.id, name: m.name })),
    };
  } catch {}
  return openRouterCache.models;
});

// ---------- IPC: settings, usage, memory ----------

const EDITABLE = ['ollamaUrl', 'localEngine', 'localContext', 'localThinking', 'visionModel', 'custom', 'extraModels', 'favorites', 'defaultPermission', 'budgets', 'stopAtBudget', 'showUsageMeter', 'memory', 'teams'];

ipcMain.handle('settings:get', () => {
  const out = Object.fromEntries(EDITABLE.map(k => [k, settings[k]]));
  out.groups = settings.groups;
  out.paths = { projects: PROJECTS_DIR, ...memory.FILES };
  return out;
});

ipcMain.handle('settings:set', (_e, patch) => {
  for (const k of EDITABLE) if (k in patch) settings[k] = patch[k];
  if ('ollamaUrl' in patch) settings.ollamaUrl = (patch.ollamaUrl || '').trim().replace(/\/+$/, '') || 'http://localhost:11434';
  saveSettings();
});

ipcMain.handle('usage:get', (_e, opts) => usage.getUsage(opts));

ipcMain.handle('memory:get', () => ({ instructions: memory.readFile('instructions'), memory: memory.readFile('memory'), files: memory.FILES }));
ipcMain.handle('memory:set', (_e, kind, text) => memory.writeFile(kind, text));
ipcMain.handle('memory:compress', (_e, kind, model) => memory.compress(kind, model));
ipcMain.handle('memory:saveCompressed', (_e, kind, text) => memory.saveWithBackup(kind, text));
ipcMain.handle('memory:open', (_e, kind) => shell.openPath(memory.FILES[kind]));

ipcMain.handle('guides:list', () => guides.list());
ipcMain.handle('guides:get', (_e, name) => guides.read(name));
ipcMain.handle('guides:set', (_e, name, text) => guides.write(name, text));
ipcMain.handle('guides:open', () => shell.openPath(guides.GUIDES_DIR));
// ---------- IPC: skills and libraries ----------

ipcMain.handle('skills:list', () => skills.list().map(({ dir, ...s }) => s));
ipcMain.handle('skills:find', (_e, url) => skills.findOnGitHub(url));
ipcMain.handle('skills:install', (_e, repo, picks) => skills.installFromGitHub(repo, picks));
ipcMain.handle('skills:importFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pick a skill folder (or a folder of skills)', properties: ['openDirectory'] });
  return r.canceled ? null : skills.importFolder(r.filePaths[0]);
});
ipcMain.handle('skills:setEnabled', (_e, name, on) => skills.setEnabled(name, on));
ipcMain.handle('skills:remove', (_e, name) => skills.remove(name));
ipcMain.handle('skills:get', (_e, name) => skills.read(name));
ipcMain.handle('skills:save', (_e, data) => {
  try {
    return { name: skills.save(data) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('skills:decide', (_e, chatId, index, decision, edited) => decideSkill(chatId, index, decision, edited));

// An AI's skill proposal in a chat: approve it (maybe after editing it) or decline it.
function decideSkill(chatId, index, decision, edited) {
  const chat = loadChat(chatId);
  const it = chat?.items[index];
  if (it?.name !== 'SkillProposal' || it.status !== 'pending') return { error: 'That proposal was already decided.' };
  if (decision === 'decline') {
    patchItem(chat, index, { status: 'denied', result: 'You declined this skill.' });
    noteForAI(chat, `The user declined your proposed skill "${it.input.name}".`);
    return { ok: true };
  }
  try {
    const data = edited || it.input;
    const name = skills.save({ name: data.name, description: data.description, body: data.body, source: `Proposed by ${it.agent && it.agent !== 'Lead' ? it.agent : PROVIDERS[it.by]?.label || 'an AI'} in "${chat.title}"` });
    patchItem(chat, index, { status: 'done', input: { ...it.input, ...data, name }, result: `Saved as the skill "${name}". Every AI can use it in new chats.` });
    noteForAI(chat, `The user approved your proposed skill "${name}"${edited ? ' (after editing it)' : ''}. It's available in new chats.`);
    return { ok: true, name };
  } catch (err) {
    return { error: err.message };
  }
}
ipcMain.handle('skills:open', () => shell.openPath(skills.SKILLS_DIR));

ipcMain.handle('libs:status', () => ({ raylib: libs.raylib() }));
ipcMain.handle('libs:installRaylib', async () => {
  const r = await libs.installRaylib(msg => send('libs:progress', msg));
  return { raylib: r };
});

// ---------- IPC: local model manager ----------

ipcMain.handle('models:list', () => localModels.list());
ipcMain.handle('models:pull', async (_e, name) => {
  const model = String(name || '').trim();
  if (!/^[\w.\-/:]+$/.test(model)) return { error: 'That doesn\'t look like a model name (like qwen2.5-coder:14b).' };
  try {
    await localModels.pull(model, p => send('models:progress', { name: model, ...p }));
    send('models:progress', { name: model, done: true });
    return { ok: true };
  } catch (err) {
    send('models:progress', { name: model, error: err.message });
    return { error: err.message };
  }
});
ipcMain.handle('models:cancelPull', (_e, name) => localModels.cancelPull(name));
ipcMain.handle('models:delete', async (_e, name) => {
  try {
    await localModels.remove(name);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('toolchain:get', async (_e, { refresh = false } = {}) => {
  await (refresh ? toolchain.refresh() : toolchain.ready);
  return toolchain.describe();
});

// ---------- window ----------

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 820,
    minHeight: 560,
    title: 'Hatch',
    icon: ICON,
    backgroundColor: '#14181a',
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // so a pinned taskbar button relaunches Hatch instead of bare Electron (when running from source)
  win.setAppDetails({
    appId: APP_ID,
    appIconPath: ICON,
    relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${APP_DIR}"`,
    relaunchDisplayName: 'Hatch',
  });
  win.once('ready-to-show', () => win.show());
  // closing the window would end overnight work, so check first
  win.on('close', e => {
    if (![...runs.values()].some(r => r.overnight)) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Keep working', 'Stop and close'], defaultId: 0, cancelId: 0,
      title: 'Overnight work is running', message: 'Hatch is working overnight. Closing it stops the work.',
      detail: 'You can minimize Hatch instead; it keeps working in the background.',
    });
    if (choice === 0) e.preventDefault();
  });
  win.loadFile(path.join(APP_DIR, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    }
  });
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// ---------- phone access (lib/remote.mjs serves the phone; this is what it can see and do) ----------

const CLAUDE_CHOICES = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];

// What a new chat on the phone can use: teams, then every AI that's ready.
async function phoneModels() {
  if (!loginCache.sub) [loginCache.sub, loginCache.chatgpt] = await Promise.all([signin.status('sub'), signin.status('chatgpt')]);
  const out = (settings.teams || []).map(t => ({ value: t.lead, team: t.id, label: `Team: ${t.name}` }));
  if (loginCache.sub?.signedIn) out.push(...CLAUDE_CHOICES.map(([m, l]) => ({ value: `sub:${m}`, label: `Claude ${l}` })));
  if (keyHint('anthropic')) out.push(...CLAUDE_CHOICES.slice(1).map(([m, l]) => ({ value: `api:${m}`, label: `Claude API ${l}` })));
  if (loginCache.chatgpt?.signedIn) out.push({ value: 'chatgpt:', label: 'ChatGPT' });
  if (keyHint('openai')) out.push({ value: 'openai:', label: 'OpenAI' });
  if (keyHint('gemini') && NODE_EXE) out.push({ value: 'gemini:', label: 'Gemini' });
  if (keyHint('openrouter')) out.push(...(settings.favorites?.openrouter || []).map(id => ({ value: `openrouter:${id}`, label: `OpenRouter ${id}` })));
  for (const m of (await ollamaModels()).models) if (m.tools) out.push({ value: `local:${m.name}`, label: `Local ${m.name.replace(/:latest$/, '')}` });
  return out;
}

// Long file contents and outputs are cut down for the phone's screen (and its data plan).
function forPhone(item) {
  const cut = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n… (more on the PC)` : s);
  const tail = (s, n) => (typeof s === 'string' && s.length > n ? `…\n${s.slice(-n)}` : s);
  const out = { ...item, result: cut(item.result, 3000), text: cut(item.text, 20000) };
  if (item.input) out.input = { ...item.input, content: tail(item.input.content, 3000), old_string: cut(item.input.old_string, 1500), new_string: cut(item.input.new_string, 1500), body: cut(item.input.body, 6000) };
  return out;
}

const phoneApi = {
  state: async () => ({
    version: app.getVersion(),
    chats: listChats().filter(c => !c.hidden).slice(0, 80),
    models: await phoneModels(),
    defaultPermission: settings.defaultPermission,
  }),
  chat: id => {
    const chat = loadChat(id);
    if (!chat) return { error: 'That chat is gone.' };
    const offset = Math.max(0, chat.items.length - 150);   // the latest part of a long chat
    return {
      id: chat.id, title: chat.title, model: chat.model, team: teams.teamFor(chat)?.name || null, permission: chat.permission,
      folder: path.basename(chat.cwd), running: runs.has(id), activity: activityList(id), offset, items: chat.items.slice(offset).map(forPhone),
    };
  },
  actions: {
    send: b => {
      const text = String(b.text || '').trim();
      if (!text) return { error: 'Type a message first.' };
      const r = sendToChat({ chatId: b.chatId || null, text, model: b.model || undefined, team: b.chatId ? undefined : b.team || null, permission: b.permission || undefined });
      return { chatId: r.chatId, queued: !!r.queued };
    },
    stop: b => { runs.get(b.chatId)?.abort.abort(); },
    perm: b => respondPermission(b.reqId, ['allow', 'always', 'deny'].includes(b.decision) ? b.decision : 'deny'),
    skill: b => decideSkill(b.chatId, Number(b.index), b.decision === 'approve' ? 'approve' : 'decline'),
    undo: b => undoChat(b.chatId, Number(b.index)),
    redo: b => redoChat(b.chatId, Number(b.index)),
  },
};

ipcMain.handle('remote:get', () => remote.status());
ipcMain.handle('remote:set', (_e, patch) => { remote.configure(patch); return remote.status(); });
ipcMain.handle('remote:reset', () => { remote.resetKey(); return remote.status(); });

// ---------- version and updates ----------

ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, homepage: PKG.homepage }));
ipcMain.handle('update:get', () => updater.getStatus());
ipcMain.handle('update:check', () => updater.check());
// restarting stops whatever the AIs are doing, so the window asks first
ipcMain.handle('update:install', () => updater.install());

app.whenReady().then(() => {
  createWindow();
  updater.start(status => send('update:status', status));
  remote.init(phoneApi, () => send('remote:changed'));
});
app.on('window-all-closed', () => app.quit());
