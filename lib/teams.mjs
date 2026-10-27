// Teams: a lead AI that hands work to helper AIs (any AI Hatch can run), to spend less of the
// lead's usage. A team is a preset in settings: { id, name, lead: "provider:model",
// helpers: [{ name, model: "provider:model", role }] }. Leads get a "delegate" tool (Claude and
// Codex) or a <delegate> tag (Hatch's local agent); each call runs the helper in the same project
// folder and answers with its report.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, PROVIDERS, settings, getKey, parseModel } from './config.mjs';

const MAX_REPORT = 6000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.vs', '.venv', 'venv']);
const BUILD_JUNK = /\.(obj|pdb|ilk|exp|idb|pyc|tmp)$/i;

export function teamFor(chat) {
  if (!chat.team) return null;
  const team = (settings.teams || []).find(t => t.id === chat.team);
  return team?.lead && team.helpers?.length ? team : null;
}

export function modelName(value) {
  const { provider, model } = parseModel(value);
  const label = PROVIDERS[provider]?.label || provider;
  return model ? `${label} ${model.replace(/:latest$/, '')}` : label;
}

// Why a helper can't run at all (missing key or setup); sign-in problems show up when it runs.
export function notReady(provider) {
  const p = PROVIDERS[provider];
  if (!p) return 'Hatch doesn\'t know that AI.';
  if (provider === 'custom' && !settings.custom?.baseUrl) return 'the custom provider isn\'t set up in Settings.';
  if (p.key && provider !== 'custom' && !getKey(p.key)) return `there's no ${p.label} API key in Settings.`;
  return '';
}

// background: the lead's delegate tool returns at once and it keeps working (cloud leads).
export function leadNote(team, engine, background = false) {
  const first = team.helpers[0].name;
  const parallel = team.parallel !== false;
  const local = team.helpers.filter(h => parseModel(h.model).provider === 'local');
  const how = engine === 'local'
    ? `Hand a task to a helper by name, like <delegate to="${first}">the complete task</delegate>, then stop and wait: Hatch gives you their report.`
    : background
      ? `Hand a task to a helper with the delegate tool (agent = the helper's name, task = the complete task). It starts the helper and returns right away, so you keep working while they do. Call wait_for_helpers when you need their reports. If you finish your part first, Hatch waits for the helpers and then gives you their reports so you can check the work.
- Work on something else meanwhile (other files, the parts that need you most), but don't touch the files a helper is working on until it reports back.`
      : 'Hand a task to a helper with the delegate tool (agent = the helper\'s name, task = the complete task). It returns their report when they finish.';
  const together = !parallel ? '- They work one at a time, in this same project folder, and see each other\'s files.'
    : `- Helpers can work at the same time${engine === 'local' ? ': write several <delegate> tags one after another in the same reply, then stop' : ': call delegate once per task'}. A busy helper gets a copy (like "${first} #2"), so one helper can take several tasks${local.length ? ', except local models, which take turns on the PC\'s GPU' : ''}.
- Tasks that run at the same time must not touch the same files: split the work by file (one helper does player.cpp, another enemy.cpp), then join the pieces after they finish. When one task needs another's result, give them out one after the other.
- They all work in this same project folder and see each other's files.`;
  const slow = local.length ? `\n- ${local.map(h => h.name).join(' and ')} ${local.length > 1 ? 'run' : 'runs'} on this PC and ${local.length > 1 ? 'are' : 'is'} much slower and weaker than you: give ${local.length > 1 ? 'them' : 'it'} small, exact tasks (one file, clear function list, exact build command) rather than whole features.` : '';
  return `

# Your team
You lead a team in Hatch. Your helpers are other AIs, and using them saves your own usage, so give them the hands-on work: writing code, building, testing and fixing errors.
${team.helpers.map(h => `- "${h.name}" (runs on ${modelName(h.model)}): ${h.role || 'general helper'}${h.canEdit === false ? ' (can read, build and run, but not change files)' : ''}`).join('\n')}
${how}
- Helpers can't see this chat. Every task must stand on its own: the goal, the exact files they may change, how to build and test it, and what "done" looks like.
${together}${slow}
- You plan and review: split the work into clear tasks, delegate them, then check the results (look at the key files, build or run it) before telling the user it's done. Fix small things yourself; send bigger problems back to a helper with exact details.
- If a helper fails twice on the same task, do it yourself or give it to another helper.`;
}

export function helperPrompt(helper, team, task) {
  const rules = helper.canEdit === false
    ? 'You can read files, build and run things, but you can\'t change any files: find the problems and describe the exact fixes in your report.'
    : 'Do the task yourself: write the code, build or run it to test it, and fix any problems. Only change the files the task is about, and don\'t create other files unless the task asks for them.';
  return `You're ${helper.name}, a helper on a team in Hatch.${helper.role ? ` Your role: ${helper.role}.` : ''} The lead AI (${modelName(team.lead)}) gave you this task:

${task.trim()}

${rules} Nobody can answer questions, so make sensible choices on your own; if you can't do it, stop and say why rather than guessing.${team.parallel !== false ? ' Others may be working in the project folder at the same time.' : ''} When you're done, finish with a short report for the lead: what you did, which files you changed, and whether it builds and works (or what is still wrong).`;
}

// ---------- what a helper changed ----------

export function snapshot(cwd) {
  const out = new Map();
  const walk = (dir, depth) => {
    if (depth > 6 || out.size > 3000) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs, depth + 1); continue; }
      try { out.set(path.relative(cwd, abs).replace(/\\/g, '/'), fs.statSync(abs).mtimeMs); } catch {}
    }
  };
  walk(cwd, 0);
  return out;
}

export function changedSince(cwd, before) {
  const after = snapshot(cwd);
  const changed = [...after].filter(([f, t]) => before.get(f) !== t).map(([f]) => f);
  const deleted = [...before.keys()].filter(f => !after.has(f));
  return { changed: changed.filter(f => !BUILD_JUNK.test(f)), deleted };
}

// The files a helper's own cards say it wrote (when other helpers changed files at the same time).
export function filesFromItems(items, cwd) {
  const out = new Set();
  const add = p => { if (p) out.add(path.relative(cwd, path.resolve(cwd, p)).replace(/\\/g, '/')); };
  for (const it of items) {
    if (it.type !== 'tool' || it.status !== 'done' || !it.input) continue;
    if (['Write', 'Edit', 'MultiEdit'].includes(it.name)) add(it.input.file_path);
    else if (it.name === 'NotebookEdit') add(it.input.notebook_path);
    else if (it.name === 'Patch') for (const c of it.input.changes || []) add(c.path);
    else if (it.name === 'Template') for (const f of it.input.files || []) add(f);
  }
  return { changed: [...out], deleted: [] };
}

// The helper's answer for the lead: its own words, plus what Hatch saw happen.
export function report(helper, items, files, result, error) {
  const said = items.filter(i => i.type === 'assistant' && i.text.trim()).map(i => i.text.trim());
  const problems = items.filter(i => i.type === 'error').map(i => i.text);
  const stops = items.filter(i => i.type === 'note' && /^(Stopped|Session ended)/.test(i.text)).map(i => i.text);
  let words = said.slice(-2).join('\n\n') || `(${helper.name} didn't write a report.)`;
  if (words.length > MAX_REPORT) words = `…${words.slice(-MAX_REPORT)}`;
  const facts = [];
  if (files.changed.length) facts.push(`Files changed: ${files.changed.slice(0, 30).join(', ')}${files.changed.length > 30 ? ` and ${files.changed.length - 30} more` : ''}.`);
  else facts.push('No files changed.');
  if (files.deleted.length) facts.push(`Files deleted: ${files.deleted.slice(0, 15).join(', ')}.`);
  if (result?.codeChanged) facts.push(result.verified ? 'Hatch built the code: it builds.' : 'Hatch built the code: it does NOT build yet.');
  facts.push(...stops, ...problems.map(p => `Error: ${p}`));
  if (error) facts.push(`${helper.name} failed: ${error}`);
  const ok = !error && !problems.length && !result?.stuck;
  return { ok, text: `${helper.name}'s report:\n${words}\n\nWhat Hatch saw: ${facts.join(' ')}`, changed: files.changed, builds: result?.codeChanged ? !!result.verified : null };
}

// ---------- Codex leads: an MCP server that passes Hatch's tools (delegate, propose_skill) back to Hatch ----------

const live = new Map();   // token -> { team, proposeSkill } of the turn it belongs to
let bridgeUrl = null;

async function callTool({ team, proposeSkill }, tool, args) {
  if (tool === 'propose_skill' && proposeSkill) return proposeSkill(args);
  if (tool === 'wait_for_helpers' && team) return { ok: true, text: (await team.wait()) || 'No helpers are working, and there are no new reports.' };
  if (tool === 'delegate' && team) return (team.background ? team.start : team.delegate)(args.agent, args.task);
  return { ok: false, text: `Hatch can't do "${tool}" here.` };
}

function startBridge() {
  bridgeUrl ||= new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/delegate') { res.writeHead(404).end(); return; }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        let msg;
        try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        const handle = live.get(msg.token);
        if (!handle) { res.writeHead(403).end(); return; }
        let r;
        try {
          r = await callTool(handle, msg.tool, msg.args || {});
        } catch (err) {
          r = { ok: false, text: String(err?.message || err) };
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: r.ok, text: r.text }));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  return bridgeUrl;
}

// Codex config for the "hatch" MCP server; call the returned close() when the turn ends.
export async function codexServer({ team = null, proposeSkill = null }) {
  const url = await startBridge();
  const token = crypto.randomUUID();
  live.set(token, { team, proposeSkill });
  const helpers = (team?.helpers || []).map(h => ({ name: h.name, role: h.role || '', model: modelName(h.model) }));
  return {
    config: {
      command: process.execPath,
      args: [path.join(APP_DIR, 'tools', 'hatch-mcp.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1', HATCH_BRIDGE: url, HATCH_TOKEN: token, HATCH_HELPERS: JSON.stringify(helpers),
        HATCH_BACKGROUND: team?.background ? '1' : '', HATCH_SKILLS: proposeSkill ? '1' : '',
      },
      startup_timeout_sec: 30,
      tool_timeout_sec: 4 * 3600,
    },
    close: () => live.delete(token),
  };
}
