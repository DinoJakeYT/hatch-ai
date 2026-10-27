// Paths, settings, encrypted API keys and the list of AI providers.
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

app.setName('Hatch');
export const DATA_DIR = app.getPath('userData');                       // %APPDATA%\Hatch
export const CHATS_DIR = path.join(DATA_DIR, 'chats');
export const PROJECTS_DIR = path.join(app.getPath('documents'), 'Hatch Projects');
export const ICON = path.join(APP_DIR, 'assets', 'hatch.ico');

// Claude Code: the one installed on this PC, or else the copy that comes with the Agent SDK
const SDK_CLAUDE = path.join(APP_DIR, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe');
export const CLAUDE_EXE = [path.join(os.homedir(), '.local', 'bin', 'claude.exe'), SDK_CLAUDE].find(p => fs.existsSync(p)) || SDK_CLAUDE;
export const CODEX_EXE = path.join(APP_DIR, 'node_modules', '@openai', 'codex-win32-x64', 'vendor',
  'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
export const GEMINI_JS = path.join(APP_DIR, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');

// Gemini CLI needs a real Node.js (Electron's built-in one confuses its argument parser)
export const NODE_EXE = (() => {
  try {
    return execFileSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
})();

fs.mkdirSync(CHATS_DIR, { recursive: true });

// ---------- providers ----------
// A chat's model is stored as "provider:model", e.g. "sub:opus", "chatgpt:", "local:glm-4.7-flash:latest".

export const PROVIDERS = {
  sub: { engine: 'claude', label: 'Claude', sub: 'Subscription', login: true },
  api: { engine: 'claude', label: 'Claude', sub: 'API key', key: 'anthropic' },
  chatgpt: { engine: 'codex', label: 'ChatGPT', sub: 'Sign-in', login: true },
  openai: { engine: 'codex', label: 'OpenAI', sub: 'API key', key: 'openai' },
  gemini: { engine: 'gemini', label: 'Gemini', sub: 'API key', key: 'gemini' },
  openrouter: { engine: 'claude', label: 'OpenRouter', sub: 'API key', key: 'openrouter' },
  custom: { engine: 'claude', label: 'Custom', sub: 'API', key: 'custom' },
  local: { engine: 'local', label: 'Local', sub: 'Ollama' },
};

// Local models normally use Hatch's own simple tools; big ones can use Claude Code's instead.
export function engineFor(provider) {
  if (provider === 'local' && settings.localEngine === 'claude') return 'claude';
  return PROVIDERS[provider].engine;
}

export const PERMISSIONS = ['ask', 'edits', 'always', 'full', 'readonly'];

export function parseModel(value) {
  const v = value || '';
  const i = v.indexOf(':');
  if (i < 0 || !PROVIDERS[v.slice(0, i)]) return { provider: 'sub', model: v };
  return { provider: v.slice(0, i), model: v.slice(i + 1) };
}

// ---------- settings ----------

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const settings = {
  ollamaUrl: 'http://localhost:11434',
  localEngine: 'hatch',                       // 'hatch' (simple tools) or 'claude' (Claude Code tools)
  localContext: 32768,
  localThinking: 'auto',                      // 'auto' (think when working alone, not as a helper), 'on', 'off'
  visionModel: '',                            // local model that describes screenshots ('' = first one with vision)
  keys: {},                                 // provider key name -> encrypted base64
  custom: { name: 'Custom', baseUrl: '', models: '' },
  extraModels: { chatgpt: '', openai: '', gemini: '' },
  favorites: { openrouter: [] },
  defaultPermission: 'edits',
  groups: [],                                 // [{ id, name, collapsed, hidden }]
  teams: null,                                // [{ id, name, lead, helpers: [{ name, model, role }] }] (null = never set up)
  budgets: { anthropic: 0, openrouter: 0 },   // monthly USD, 0 = no budget
  stopAtBudget: false,
  showUsageMeter: true,
  memory: { inlineLimit: 6000, autoCompress: false, compressAt: 8000, compressModel: '' },
};

try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  for (const [k, v] of Object.entries(saved)) {
    settings[k] = v && typeof v === 'object' && !Array.isArray(v) && settings[k] && typeof settings[k] === 'object'
      ? { ...settings[k], ...v } : v;
  }
} catch {}

export function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function getKey(name) {
  const enc = settings.keys[name];
  if (!enc) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
}

export function setKey(name, value) {
  const v = (value || '').trim();
  if (v) settings.keys[name] = safeStorage.encryptString(v).toString('base64');
  else delete settings.keys[name];
  saveSettings();
}

export function keyHint(name) {
  const k = getKey(name);
  return k ? k.slice(-4) : '';
}

// Base environment for every engine: anything inherited that could silently switch
// billing (API keys, base URLs) is removed; each engine adds back only what it needs.
export function cleanEnv() {
  const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'hatch/1.0.0' };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY',
    'CODEX_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  return env;
}

// ---------- one-time move from the old "Claude2" app ----------

export function migrateFromClaude2() {
  const oldData = path.join(app.getPath('appData'), 'Claude2');
  const oldChats = path.join(oldData, 'chats');
  const oldProjects = path.join(app.getPath('documents'), 'Claude2 Projects');
  if (!fs.existsSync(oldChats) || fs.readdirSync(CHATS_DIR).length) return;

  if (fs.existsSync(oldProjects) && !fs.existsSync(PROJECTS_DIR)) fs.renameSync(oldProjects, PROJECTS_DIR);
  for (const f of fs.readdirSync(oldChats)) {
    if (!f.endsWith('.json')) continue;
    try {
      const chat = JSON.parse(fs.readFileSync(path.join(oldChats, f), 'utf8'));
      if (chat.cwd?.startsWith(oldProjects)) chat.cwd = PROJECTS_DIR + chat.cwd.slice(oldProjects.length);
      if (chat.sessionId) { chat.sessions = { claude: chat.sessionId }; delete chat.sessionId; }
      if (chat.model && !chat.model.includes(':')) chat.model = `sub:${chat.model}`;
      chat.permission = chat.autoApprove ? 'always' : 'edits';
      delete chat.autoApprove;
      fs.writeFileSync(path.join(CHATS_DIR, f), JSON.stringify(chat));
    } catch {}
  }
  try {
    const old = JSON.parse(fs.readFileSync(path.join(oldData, 'settings.json'), 'utf8'));
    if (old.ollamaUrl) { settings.ollamaUrl = old.ollamaUrl; saveSettings(); }
  } catch {}
}
