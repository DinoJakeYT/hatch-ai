// Skills: folders with a SKILL.md (instructions, plus optional scripts and reference files), the
// format Claude Code, Codex and Gemini share. Imported from GitHub or a local folder and given to
// every AI: Claude loads the folder as a plugin, the others get a catalog and read SKILL.md themselves.
import { shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

export const PLUGIN_DIR = path.join(DATA_DIR, 'skills-plugin');
export const SKILLS_DIR = path.join(PLUGIN_DIR, 'skills');
const OFF_DIR = path.join(DATA_DIR, 'skills-off');
const REGISTRY = path.join(DATA_DIR, 'skills.json');
const MAX_FILES = 300;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

fs.mkdirSync(SKILLS_DIR, { recursive: true });
fs.mkdirSync(OFF_DIR, { recursive: true });
const manifest = path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');
if (!fs.existsSync(manifest)) {
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ name: 'hatch-skills', version: '1.0.0', description: 'Skills imported into Hatch' }, null, 2));
}

let registry = {};   // folder name -> { source, installedAt }
try { registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch {}
const saveRegistry = () => fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2));

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';

// Reads the "---" front matter of a SKILL.md: name and description (single line or an indented block).
export function parseSkill(text) {
  const m = /^﻿?---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = { name: '', description: '', body: m ? text.slice(m[0].length).trim() : text.trim() };
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv || !['name', 'description'].includes(kv[1])) continue;
    let v = kv[2].trim();
    if (/^[|>][-+]?$/.test(v) || v === '') {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      v = block.join(' ');
    }
    let plain = null;
    if (/^".*"$/.test(v)) try { plain = JSON.parse(v); } catch {}   // a double-quoted value with \" escapes
    out[kv[1]] = plain ?? v.replace(/^["']|["']$/g, '');
  }
  return out;
}

function skillAt(dir, enabled) {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const s = parseSkill(fs.readFileSync(file, 'utf8'));
  const name = path.basename(dir);
  return { name, title: s.name || name, description: s.description, enabled, dir, source: registry[name]?.source || '' };
}

export function list() {
  const read = (root, enabled) => fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => skillAt(path.join(root, e.name), enabled)).filter(Boolean);
  return [...read(SKILLS_DIR, true), ...read(OFF_DIR, false)].sort((a, b) => a.name.localeCompare(b.name));
}

// Enabled skills, for the AIs' instructions.
export function catalog() {
  return list().filter(s => s.enabled).map(s => ({
    name: s.name,
    description: (s.description || s.title).slice(0, 300),
    path: path.join(s.dir, 'SKILL.md'),
  }));
}

function filesIn(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) filesIn(p, base, out);
    else out.push(path.relative(base, p).replace(/\\/g, '/'));
    if (out.length > 60) break;
  }
  return out;
}

export function load(name) {
  const s = list().find(k => k.enabled && (k.name === slug(name) || k.title.toLowerCase() === String(name).toLowerCase()));
  if (!s) return null;
  const parsed = parseSkill(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'));
  const text = parsed.body.length > 12000 ? `${parsed.body.slice(0, 12000)}\n… (cut; read SKILL.md for the rest)` : parsed.body;
  return { name: s.name, description: s.description, dir: s.dir, text, files: filesIn(s.dir) };
}

export function setEnabled(name, on) {
  const from = path.join(on ? OFF_DIR : SKILLS_DIR, name);
  const to = path.join(on ? SKILLS_DIR : OFF_DIR, name);
  if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
}

export async function remove(name) {
  for (const root of [SKILLS_DIR, OFF_DIR]) {
    const dir = path.join(root, name);
    if (fs.existsSync(dir)) await shell.trashItem(dir);
  }
  delete registry[name];
  saveRegistry();
}

function install(srcDir, wantedName, source) {
  const name = slug(wantedName);
  for (const root of [SKILLS_DIR, OFF_DIR]) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  fs.cpSync(srcDir, path.join(SKILLS_DIR, name), {
    recursive: true,
    filter: src => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src),
  });
  registry[name] = { source, installedAt: Date.now() };
  saveRegistry();
  return name;
}

// ---------- written in Hatch: by the user, or proposed by an AI and approved ----------

export const skillId = slug;
const where = name => [SKILLS_DIR, OFF_DIR].map(root => path.join(root, name)).find(d => fs.existsSync(path.join(d, 'SKILL.md')));
export const exists = name => !!where(slug(name));

// Told to lead AIs (never helpers): when and how to propose a new skill.
export function proposeNote(engine) {
  const how = engine === 'local'
    ? 'write <newskill name="short-name" description="one line: when to use it">the instructions, in Markdown</newskill>'
    : 'use the propose_skill tool';
  return `

# Making new skills
Skills are reusable instructions that every AI in Hatch can use in later chats. When you've worked out something clearly worth reusing (a reliable recipe for this kind of project, the user's preferences and conventions, the fix for a problem that keeps coming up), you can propose a new skill: ${how}. Give it a short name in lowercase-with-dashes, a one-line description that says when to use it, and clear step-by-step instructions. The user approves or declines it, and it only applies to new chats, so keep working meanwhile. Propose at most one per task, never for a one-off request, and never put secrets in a skill. If a skill with that name exists, yours replaces it once approved.`;
}

// A skill's text, for editing.
export function read(name) {
  const dir = where(slug(name));
  if (!dir) return null;
  const s = parseSkill(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  return { name: path.basename(dir), description: s.description, body: s.body, enabled: dir.startsWith(SKILLS_DIR), source: registry[path.basename(dir)]?.source || '' };
}

// Creates or updates a skill (previous: its old name, when it's being renamed). The last version is kept as SKILL.md.bak.
export function save({ name, description, body, previous = null, source = 'Made in Hatch' }) {
  const id = slug(name);
  const desc = String(description || '').replace(/\s+/g, ' ').trim();
  const text = String(body || '').trim();
  if (!String(name || '').trim()) throw new Error('Give the skill a name.');
  if (!desc) throw new Error('Describe when the AI should use this skill.');
  if (!text) throw new Error('Write the skill\'s instructions.');
  let dir = where(id);
  const old = previous && slug(previous) !== id ? where(slug(previous)) : null;
  if (old) {
    if (dir) throw new Error(`There's already a skill called "${id}".`);
    dir = path.join(path.dirname(old), id);
    fs.renameSync(old, dir);
    registry[id] = registry[path.basename(old)] || { source, installedAt: Date.now() };
    delete registry[path.basename(old)];
  }
  dir ||= path.join(SKILLS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, 'SKILL.md.bak'));
  fs.writeFileSync(file, `---\nname: ${id}\ndescription: ${JSON.stringify(desc)}\n---\n\n${text}\n`);
  registry[id] ||= { source, installedAt: Date.now() };
  saveRegistry();
  return id;
}

// ---------- from a folder on this PC ----------

function findSkillFiles(dir, depth = 0, out = []) {
  if (depth > 4 || out.length > 100) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  if (entries.some(e => e.isFile() && e.name.toLowerCase() === 'skill.md')) { out.push(dir); return out; }
  for (const e of entries) {
    if (e.isDirectory() && !['.git', 'node_modules'].includes(e.name)) findSkillFiles(path.join(dir, e.name), depth + 1, out);
  }
  return out;
}

export function importFolder(folder) {
  const dirs = findSkillFiles(folder);
  if (!dirs.length) throw new Error('No SKILL.md found in that folder.');
  return dirs.map(d => {
    const md = fs.readdirSync(d).find(f => f.toLowerCase() === 'skill.md');
    const s = parseSkill(fs.readFileSync(path.join(d, md), 'utf8'));
    const name = install(d, s.name || path.basename(d), d);
    // the copy (never the original) gets the standard file name
    if (md !== 'SKILL.md') fs.renameSync(path.join(SKILLS_DIR, name, md), path.join(SKILLS_DIR, name, 'SKILL.md'));
    return name;
  });
}

// ---------- from GitHub ----------

// "owner/repo", https://github.com/owner/repo, .../tree/<branch>/<folder>, or .../blob/<branch>/<folder>/SKILL.md
export function parseGitHubUrl(input) {
  const s = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?$/i.exec(s);
  if (!m) m = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3] || '', dir: (m[4] || '').replace(/\/?SKILL\.md$/i, '') };
}

async function gh(apiPath) {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    headers: { 'User-Agent': 'Hatch', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) throw new Error("GitHub couldn't find that repository (it may be private or misspelled).");
  if (res.status === 403 || res.status === 429) throw new Error("GitHub's limit for lookups without an account was reached. Try again in an hour.");
  if (!res.ok) throw new Error(`GitHub: ${res.status}`);
  return res.json();
}

const rawUrl = (r, p) => `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.ref}/${p.split('/').map(encodeURIComponent).join('/')}`;
const trees = new Map();

export async function findOnGitHub(input) {
  const r = parseGitHubUrl(input);
  if (!r) throw new Error('That doesn\'t look like a GitHub link. Use something like https://github.com/owner/repo');
  if (!r.ref) r.ref = (await gh(`/repos/${r.owner}/${r.repo}`)).default_branch;
  const tree = await gh(`/repos/${r.owner}/${r.repo}/git/trees/${encodeURIComponent(r.ref)}?recursive=1`);
  trees.set(`${r.owner}/${r.repo}@${r.ref}`, tree.tree || []);
  const prefix = r.dir ? `${r.dir}/` : '';
  const mds = (tree.tree || []).filter(e => e.type === 'blob' && /(^|\/)SKILL\.md$/i.test(e.path) && e.path.startsWith(prefix)).slice(0, 60);

  const found = [];
  for (let i = 0; i < mds.length; i += 8) {
    await Promise.all(mds.slice(i, i + 8).map(async e => {
      try {
        const s = parseSkill(await (await fetch(rawUrl(r, e.path), { signal: AbortSignal.timeout(20000) })).text());
        const dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
        found.push({ dir, name: s.name || path.posix.basename(dir) || r.repo, description: s.description });
      } catch {}
    }));
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return { repo: { owner: r.owner, repo: r.repo, ref: r.ref }, skills: found, truncated: !!tree.truncated };
}

export async function installFromGitHub(repo, picks) {
  const key = `${repo.owner}/${repo.repo}@${repo.ref}`;
  if (!trees.has(key)) trees.set(key, (await gh(`/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(repo.ref)}?recursive=1`)).tree || []);
  const tree = trees.get(key);
  const installed = [];
  for (const pick of picks) {
    const prefix = pick.dir ? `${pick.dir}/` : '';
    const blobs = tree.filter(e => e.type === 'blob' && e.path.startsWith(prefix) && !e.path.split('/').some(seg => seg === '..' || seg === '.git'));
    if (blobs.length > MAX_FILES) throw new Error(`"${pick.name}" has too many files (${blobs.length}) to be a skill.`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-skill-'));
    let total = 0;
    for (const b of blobs) {
      if ((b.size || 0) > MAX_FILE_BYTES) continue;
      total += b.size || 0;
      if (total > MAX_TOTAL_BYTES) throw new Error(`"${pick.name}" is too big to import.`);
      const res = await fetch(rawUrl(repo, b.path), { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Couldn't download ${b.path} (${res.status}).`);
      const to = path.join(tmp, ...b.path.slice(prefix.length).split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, Buffer.from(await res.arrayBuffer()));
    }
    const source = `https://github.com/${repo.owner}/${repo.repo}/tree/${repo.ref}/${pick.dir}`.replace(/\/$/, '');
    installed.push(install(tmp, pick.name, source));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return installed;
}
