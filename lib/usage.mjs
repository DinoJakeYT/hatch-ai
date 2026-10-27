// Usage and limits: what each turn used, plus the live plan/credit limits each service exposes.
//   Claude subscription -> 5-hour / weekly windows (from the Claude engine)
//   ChatGPT sign-in     -> 5-hour / weekly windows (Codex writes them into its session files)
//   OpenRouter          -> credits used / limit (OpenRouter's key endpoint)
//   API keys            -> tokens and cost counted here, against an optional monthly budget
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { DATA_DIR, CLAUDE_EXE, settings, getKey, cleanEnv } from './config.mjs';

const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const LIMITS_FILE = path.join(DATA_DIR, 'limits.json');

let usage = { months: {}, days: {} };
let limits = { sub: null, chatgpt: null, openrouter: null, blocked: {} };
try { usage = { ...usage, ...JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) }; } catch {}
try { limits = { ...limits, ...JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')) }; } catch {}

const save = () => {
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  fs.writeFileSync(LIMITS_FILE, JSON.stringify(limits));
};

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

function bump(bucket, provider, t) {
  const row = bucket[provider] ||= { turns: 0, input: 0, output: 0, cached: 0, cost: 0 };
  row.turns += 1;
  row.input += t.input || 0;
  row.output += t.output || 0;
  row.cached += t.cached || 0;
  row.cost += t.cost || 0;
}

// t: { input, output, cached, cost } - cost only for API-key providers where it's real spend
export function recordTurn(provider, t) {
  bump(usage.months[monthKey()] ||= {}, provider, t);
  bump(usage.days[dayKey()] ||= {}, provider, t);
  const days = Object.keys(usage.days).sort();
  for (const d of days.slice(0, Math.max(0, days.length - 62))) delete usage.days[d];
  delete limits.blocked[provider];
  save();
}

export function monthCost(provider) {
  return usage.months[monthKey()]?.[provider]?.cost || 0;
}

// Returns a reason string when the user's own monthly budget should stop this provider.
export function budgetBlock(provider) {
  const budgetName = { api: 'anthropic', openrouter: 'openrouter' }[provider];
  const budget = budgetName && settings.budgets[budgetName];
  if (!settings.stopAtBudget || !budget) return null;
  const spent = provider === 'openrouter' && limits.openrouter ? limits.openrouter.monthUsage ?? monthCost(provider) : monthCost(provider);
  return spent >= budget ? `Monthly budget of $${budget} reached for this provider. Change it in Settings → Usage.` : null;
}

// ---------- limit errors ----------

const LIMIT_RE = /usage limit|rate.?limit|quota|exceeded|too many requests|\b429\b|out of credits|insufficient.?(credits|funds|balance)/i;

export function noteError(provider, message) {
  if (!LIMIT_RE.test(message || '')) return false;
  const m = /try again at ([^.]+?)\.?$/i.exec(message) || /resets? (?:at|in) ([^.]+)/i.exec(message);
  limits.blocked[provider] = { message, at: Date.now(), resetsText: m ? m[1].trim() : '' };
  save();
  return true;
}

// ---------- Claude subscription ----------

export function noteClaudeRateLimit(info) {
  if (!info) return;
  const cur = limits.sub ||= { windows: {} };
  cur.status = info.status;
  if (info.rateLimitType) {
    cur.windows[info.rateLimitType] = {
      pct: info.utilization != null ? Math.round(info.utilization * (info.utilization <= 1 ? 100 : 1)) : cur.windows[info.rateLimitType]?.pct ?? null,
      resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
    };
  }
  cur.updatedAt = Date.now();
  save();
}

// Asks the Claude engine for /usage without sending a message (no usage is spent).
export async function refreshClaudeLimits() {
  if (!fs.existsSync(CLAUDE_EXE)) return;
  const abort = new AbortController();
  const idle = (async function* () { await new Promise(r => abort.signal.addEventListener('abort', r)); })();
  try {
    const q = query({
      prompt: idle,
      options: { cwd: os.tmpdir(), env: cleanEnv(), pathToClaudeCodeExecutable: CLAUDE_EXE, abortController: abort, settingSources: [] },
    });
    const u = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000)),
    ]);
    if (u?.rate_limits) {
      const windows = {};
      for (const [k, v] of Object.entries(u.rate_limits)) {
        if (v && typeof v === 'object' && 'utilization' in v) {
          windows[k] = { pct: v.utilization != null ? Math.round(v.utilization) : null, resetsAt: v.resets_at ? Date.parse(v.resets_at) : null };
        }
      }
      limits.sub = { ...(limits.sub || {}), windows, plan: u.subscription_type || null, updatedAt: Date.now() };
      save();
    }
  } catch {
    // signed out or offline: keep the last known numbers
  } finally {
    abort.abort();
  }
}

// ---------- ChatGPT (Codex) ----------

const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

function newestFiles(dir, n) {
  const out = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push({ p, t: fs.statSync(p).mtimeMs });
    }
  };
  walk(dir);
  return out.sort((a, b) => b.t - a.t).slice(0, n).map(f => f.p);
}

// Codex records the plan windows in each session file; read the newest one that has them.
export function refreshCodexLimits() {
  for (const file of newestFiles(CODEX_SESSIONS, 12)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"') || !lines[i].includes('"primary":{')) continue;
      try {
        const rl = JSON.parse(lines[i])?.payload?.rate_limits;
        if (!rl?.primary) continue;
        const win = w => w && { pct: Math.round(w.used_percent), minutes: w.window_minutes, resetsAt: w.resets_at ? w.resets_at * 1000 : null };
        limits.chatgpt = { windows: { five_hour: win(rl.primary), seven_day: win(rl.secondary) }, updatedAt: fs.statSync(file).mtimeMs };
        save();
        return;
      } catch {}
    }
  }
}

// ---------- OpenRouter ----------

export async function refreshOpenRouter() {
  const key = getKey('openrouter');
  if (!key) { limits.openrouter = null; return; }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    const d = (await res.json()).data;
    if (d) {
      limits.openrouter = {
        usage: d.usage ?? null, monthUsage: d.usage_monthly ?? null, limit: d.limit ?? null,
        remaining: d.limit_remaining ?? null, freeTier: !!d.is_free_tier, updatedAt: Date.now(),
      };
      save();
    }
  } catch {}
}

// ---------- summary for the window ----------

export async function getUsage({ refresh = false } = {}) {
  if (refresh) {
    refreshCodexLimits();
    await Promise.all([refreshClaudeLimits(), refreshOpenRouter()]);
  }
  return {
    limits,
    month: usage.months[monthKey()] || {},
    today: usage.days[dayKey()] || {},
    budgets: settings.budgets,
    stopAtBudget: settings.stopAtBudget,
  };
}
