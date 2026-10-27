// Hatch's own agent for local (Ollama) models.
// Small models get lost in big tool schemas, so they act through a handful of simple tags
// in their reply, which Hatch carries out while the reply streams in:
//   <plan>- [ ] step</plan>   <file path="..">content</file>   <edit path=".."><find>..</find><replace>..</replace></edit>
//   <run timeout="5">command</run>   <read path=".."/>   <list path="."/>   <open path=".."/>   <remember>fact</remember>
// Hatch also keeps them on the method a stronger agent follows (see lib/guides.mjs): it tells them
// what this PC has, rejects placeholder files, blocks repeating a failed command unchanged,
// points at the exact lines compiler errors refer to, builds the code itself when the model
// says "done" without testing, and stops honestly when it can't get there.
import { shell } from 'electron';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { settings, cleanEnv, DATA_DIR, APP_DIR } from '../lib/config.mjs';
import { raylib, raylibBuildFlags } from '../lib/libs.mjs';
import { appendMemory } from '../lib/memory.mjs';
import * as toolchain from '../lib/toolchain.mjs';
import * as guides from '../lib/guides.mjs';
import * as preview from '../lib/preview.mjs';
import * as vision from '../lib/vision.mjs';
import * as skills from '../lib/skills.mjs';

const fwdSlash = p => p.replace(/\\/g, '/');

const PREVIEW_DIR = path.join(DATA_DIR, 'previews');
const TEMPLATES_DIR = path.join(APP_DIR, 'templates');

const MAX_ROUNDS = 40;
const MAX_FAILED_BUILDS = 8;
const HELPER_ROUNDS = 25;
const HELPER_FAILED_BUILDS = 5;
const MAX_NUDGES = 2;
const MAX_OUTPUT = 6000;
const COMMAND_TIMEOUT = 180000;
const TAGS = ['plan', 'file', 'edit', 'run', 'read', 'list', 'open', 'remember', 'preview', 'template', 'skill', 'delegate', 'newskill'];
const NO_CARD = ['plan', 'newskill'];   // these show up their own way (the plan list, a skill proposal)
const CODE_EXT = /\.(c|cc|cpp|cxx|h|hpp|py|js|mjs|cjs|ts|cs|java|go|rs)$/i;
const CHECK_CMD = /(^|[\s;&|(])(cl|g\+\+|gcc|clang\+\+|clang|cmake|msbuild|python|py|node|dotnet|javac|cargo|go|tsc|make|ninja)(\.exe)?(\s|$)/i;
const RUNNABLE = /\.(exe|bat|cmd|ps1|vbs|msi|com|scr)$/i;
// running the program itself (not building it): may wait for input or never end, so it gets a short leash
const PROGRAM_RUN = /(^|[;&|]\s*)(\.\/|start\s)|\.exe(\s|$)|(^|[;&|]\s*)(python|py)\s+(?!-m\s+(pip|py_compile))\S+\.py|(^|[;&|]\s*)node\s+(?!--check)\S+\.m?js/i;
const PROGRAM_TIMEOUT = 8000;

const BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(p => fs.existsSync(p));
const SHELL = BASH ? { exe: BASH, args: c => ['-c', c], name: 'bash (Git Bash on Windows)' }
  : { exe: 'powershell.exe', args: c => ['-NoProfile', '-Command', c], name: 'PowerShell on Windows' };

function systemPrompt(cwd, instructions, chosenGuides, { canPropose = false } = {}) {
  return `You are Hatch, an assistant that builds things on the user's Windows computer. You create files and run commands yourself by writing action tags. Never just show code and tell the user to save it.

Project folder: ${cwd}
All paths are relative to it. Commands run in ${SHELL.name} inside it.

Action tags (Hatch carries them out and the user watches):
<plan>
- [ ] step
- [x] finished step
</plan>                          your checklist (write it again when a step is done)
<file path="src/game.js">
the COMPLETE file content
</file>                          create or replace a file
<edit path="src/game.js"><find>exact existing text</find><replace>new text</replace></edit>
<run>command</run>               run a command; you get its output back
<run timeout="5">./game.exe</run>  start a program for 5 seconds to check it runs
<read path="src/game.js"/>       get a file's content back
<list path="."/>                 get the list of files back
<open path="index.html"/>        open a file for the user (a web page in their browser, a game .exe)
<preview path="index.html"/>     take a screenshot of a web page, image or program (.exe) and get told what it looks like
<template name="cpp-3d-opengl"/> copy a starter project that already builds and runs (see the guides for names)
<remember>one short fact</remember>  save a lasting fact about the user or their projects${canPropose ? `
<newskill name="short-name" description="when to use it">step-by-step instructions</newskill>  propose a reusable skill (the user approves it)` : ''}

Rules:
- When asked to build something, start doing it right away with action tags. Don't ask for permission first, and don't write a tutorial: act.
- Every file goes in a <file> tag with its full content. Never show code in \`\`\` blocks, and never wrap <file> content in \`\`\` fences.
- Every command goes in a <run> tag. Never show commands in \`\`\` blocks.
- Keep the talking short: one or two sentences between actions.
- After <run>, <read> or <list>, stop writing and wait for the result.
- Never start servers or programs that keep running, except with <run timeout="5">.

Example:
User: make a C++ program that says hello
Assistant: On it!
<plan>
- [ ] Write main.cpp
- [ ] Build and test it
</plan>
<file path="main.cpp">
#include <iostream>
int main() { std::cout << "Hello!" << std::endl; return 0; }
</file>
<run>${toolchain.cppBuildCommand(['main.cpp'], 'hello.exe', {}) || 'g++ main.cpp -o hello.exe'}</run>
(Hatch shows you the build output, then you continue:)
<run>./hello.exe</run>
(it printed Hello!)
<plan>
- [x] Write main.cpp
- [x] Build and test it
</plan>
Done! Run hello.exe to see it.

${toolchain.summary()}

${skillList()}

${chosenGuides.map(g => g.text).join('\n\n')}

${instructions}`;
}

function skillList() {
  const list = skills.catalog();
  if (!list.length) return '';
  return `Skills (extra know-how). When one fits the task, load it first with <skill name="..."/> and follow it:\n${list.map(s => `- ${s.name}: ${s.description}`).join('\n')}`;
}

// ---------- streaming tag parser ----------

function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>\/]+))/g)) out[m[1]] = m[2] ?? m[3] ?? m[4];
  return out;
}

// Turns streamed text into events: text, open, body, close, self.
class ActionParser {
  constructor() { this.buf = ''; this.mode = 'text'; this.tag = null; this.attrs = null; this.body = ''; }

  push(chunk, final = false) {
    this.buf += chunk;
    const ev = [];
    for (;;) {
      if (this.mode === 'text') {
        const i = this.buf.indexOf('<');
        if (i < 0) { if (this.buf) ev.push({ type: 'text', text: this.buf }); this.buf = ''; break; }
        if (i > 0) { ev.push({ type: 'text', text: this.buf.slice(0, i) }); this.buf = this.buf.slice(i); }
        // a closing tag with nothing open (the model's leftovers): drop it
        const stray = /^<\/(plan|file|edit|run|read|list|open|remember|preview|template|skill|delegate|newskill|find|replace)>/.exec(this.buf);
        if (stray) { this.buf = this.buf.slice(stray[0].length); continue; }
        const m = /^<(plan|file|edit|run|read|list|open|remember|preview|template|skill|delegate|newskill)\b([^>]*?)(\/?)>/.exec(this.buf);
        if (m) {
          this.buf = this.buf.slice(m[0].length);
          const attrs = parseAttrs(m[2]);
          if (m[3] === '/') { ev.push({ type: 'self', tag: m[1], attrs }); continue; }
          this.mode = 'tag'; this.tag = m[1]; this.attrs = attrs; this.body = '';
          ev.push({ type: 'open', tag: m[1], attrs });
          continue;
        }
        // maybe the start of a tag that hasn't fully arrived
        const name = /^<\/?([a-z]*)/i.exec(this.buf)[1].toLowerCase();
        const partial = !this.buf.includes('>') && this.buf.length < 400 && [...TAGS, 'find', 'replace'].some(t => t.startsWith(name) || (name === t));
        if (partial && !final) break;
        ev.push({ type: 'text', text: '<' });
        this.buf = this.buf.slice(1);
      } else {
        const close = `</${this.tag}>`;
        const j = this.buf.indexOf(close);
        if (j < 0) {
          let keep = 0;   // a closing tag might be split across chunks
          for (let k = Math.min(close.length - 1, this.buf.length); k > 0; k--) if (close.startsWith(this.buf.slice(-k))) { keep = k; break; }
          this.body += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          if (final) {
            this.body += this.buf; this.buf = '';
            ev.push({ type: 'close', tag: this.tag, attrs: this.attrs, body: this.body, incomplete: true });
            this.mode = 'text';
          } else ev.push({ type: 'body', tag: this.tag, body: this.body });
          break;
        }
        this.body += this.buf.slice(0, j);
        this.buf = this.buf.slice(j + close.length);
        ev.push({ type: 'close', tag: this.tag, attrs: this.attrs, body: this.body });
        this.mode = 'text';
      }
    }
    return ev;
  }
}

// What the model is doing when it opens a tag, for the activity bar.
function tagStatus(tag, attrs = {}) {
  const file = String(attrs.path || '').split(/[\\/]/).pop();
  switch (tag) {
    case 'file': return file ? `Writing ${file}` : 'Writing a file';
    case 'edit': return file ? `Editing ${file}` : 'Editing a file';
    case 'run': return 'Running a command';
    case 'read': return file ? `Reading ${file}` : 'Reading a file';
    case 'list': return 'Looking at the files';
    case 'plan': return 'Planning';
    case 'delegate': return `Handing a task to ${attrs.to || attrs.agent || 'a helper'}`;
    case 'preview': return 'Taking a screenshot';
    case 'template': return 'Copying a starter project';
    case 'skill': return 'Loading a skill';
    case 'remember': return 'Saving to memory';
    case 'newskill': return 'Proposing a skill';
    default: return 'Working';
  }
}

function stripFences(s) {
  let t = s.replace(/^\s*\n/, '');
  const m = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(t);
  if (m) t = m[1];
  return t.replace(/\s+$/, '') + '\n';
}

function parsePlan(body) {
  const steps = [];
  for (const line of body.split('\n')) {
    const m = /^\s*(?:[-*]|\d+[.)])\s*(?:\[([ xX✓-])\]\s*)?(.+?)\s*$/.exec(line);
    if (m && m[2]) steps.push({ content: m[2], status: m[1] && m[1] !== ' ' ? 'completed' : 'pending' });
  }
  const next = steps.find(s => s.status === 'pending');
  if (next) next.status = 'in_progress';
  return steps;
}

const PLACEHOLDER = /(^|\n)\s*(\/\/|#|\/\*|<!--)?\s*(\.\.\.|…)\s*(\*\/|-->)?\s*(\n|$)|your code (goes )?here|rest of (the )?(code|file|implementation)|implementation goes here|TODO:? implement|same as (before|above)|\(omitted\)|code omitted/i;

function looksUnfinished(p, content) {
  if (!CODE_EXT.test(p || '')) return false;
  return content.trim().length < 12 || PLACEHOLDER.test(content);
}

// ---------- fallbacks for models that ignore the tags ----------

const FILE_RE = /([\w./\\-]+\.(?:html?|css|js|mjs|cjs|jsx|ts|tsx|json|py|md|txt|java|cs|cpp|cc|c|h|hpp|go|rs|rb|php|lua|gd|sh|bat|ps1|xml|yml|yaml|toml|svg|ini|cfg|sql|vue|svelte))\b/i;
const SHELL_LANGS = /^(bash|sh|shell|console|cmd|powershell|ps|ps1|zsh|terminal|text|plaintext)$/i;

const LANG_EXT = {
  cpp: /\.(cpp|cc|cxx)$/i, 'c++': /\.(cpp|cc|cxx)$/i, c: /\.c$/i, h: /\.h(pp)?$/i, python: /\.py$/i, py: /\.py$/i,
  html: /\.html?$/i, javascript: /\.m?js$/i, js: /\.m?js$/i, css: /\.css$/i, java: /\.java$/i, csharp: /\.cs$/i, cs: /\.cs$/i,
};
const LANG_DEFAULT = { cpp: 'main.cpp', 'c++': 'main.cpp', c: 'main.c', python: 'main.py', py: 'main.py', html: 'index.html' };

// Code blocks labelled with a file name: "#### Engine.js", "**src/a.js**", ```js src/a.js, or "// file: a.js" on line one.
// Unlabelled blocks take the last matching file name mentioned before them, or a default for a lone block.
function looseFiles(text) {
  const out = [];
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*```\s*([^\s`]*)\s*(.*)$/.exec(lines[i]);
    if (!open) continue;
    let j = i + 1;
    while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) j++;
    blocks.push({ start: i, lang: open[1].toLowerCase(), info: open[2], body: lines.slice(i + 1, j) });
    i = j;
  }
  for (const b of blocks) {
    if (SHELL_LANGS.test(b.lang) || !b.body.some(l => l.trim())) continue;
    let name = (FILE_RE.exec(b.info) || FILE_RE.exec(b.lang.includes('.') ? b.lang : '') || [])[1];
    for (let k = b.start - 1; k >= Math.max(0, b.start - 4) && !name; k--) {
      const l = lines[k].trim();
      if (l && l.length < 160) name = (FILE_RE.exec(l.replace(/[#*`:"()]/g, ' ')) || [])[1];
    }
    if (!name && b.body[0]) {
      const c = /^\s*(?:\/\/|#|<!--|\/\*|--|;)\s*(?:file(?:name)?:?\s*)?([\w./\\-]+\.\w{1,6})\s*(?:-->|\*\/)?\s*$/i.exec(b.body[0]);
      if (c && FILE_RE.test(c[1])) name = c[1];
    }
    const extRe = LANG_EXT[b.lang];
    if (name && extRe && !extRe.test(name)) name = null;   // "main.cpp" mentioned near a CSS block isn't its name
    if (!name && extRe) {
      const before = lines.slice(0, b.start).join('\n');
      const mentioned = [...before.matchAll(new RegExp(FILE_RE.source, 'gi'))].map(m => m[1]).filter(n => extRe.test(n));
      name = mentioned.pop() || (blocks.filter(x => x.lang === b.lang).length === 1 ? LANG_DEFAULT[b.lang] : null);
    }
    if (name) out.push({ path: name.replace(/\\/g, '/'), content: b.body.join('\n').replace(/\s+$/, '') + '\n' });
  }
  return out;
}

const JSON_TOOL_NAMES = {
  write_file: 'file', create_file: 'file', write: 'file', save_file: 'file',
  edit_file: 'edit', replace: 'edit', edit: 'edit',
  run_command: 'run', bash: 'run', run: 'run', execute: 'run', shell: 'run', run_shell_command: 'run',
  read_file: 'read', read: 'read', list_files: 'list', list_directory: 'list', ls: 'list',
};

// {"name": "write_file", "arguments": {...}} blocks some models print instead of using tags
function jsonToolCalls(text) {
  const out = [];
  for (const m of text.matchAll(/\{[^{}]*"name"\s*:\s*"([\w.-]+)"[^{}]*"(?:arguments|parameters|input)"\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\})\s*\}/g)) {
    const kind = JSON_TOOL_NAMES[m[1].toLowerCase()];
    if (!kind) continue;
    try {
      const a = JSON.parse(m[2]);
      out.push({ tag: kind, attrs: { path: a.file_path || a.path || a.filename }, body: kind === 'file' ? a.content ?? '' : kind === 'run' ? a.command ?? '' : '', find: a.old_string ?? a.find, replace: a.new_string ?? a.replace });
    } catch {}
  }
  return out;
}

// ---------- actions ----------

const isInside = (dir, abs) => {
  const rel = path.relative(dir, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

function insideProject(cwd, p, full) {
  if (!p) throw new Error('No path given.');
  const abs = path.resolve(cwd, p.replace(/^["']|["']$/g, ''));
  if (!full && !isInside(cwd, abs)) throw new Error(`"${p}" is outside the project folder.`);
  return abs;
}

// Reading may also look inside installed skills and Hatch's templates.
function readable(cwd, p, full) {
  const abs = path.resolve(cwd, (p || '').replace(/^["']|["']$/g, ''));
  if (p && (isInside(skills.SKILLS_DIR, abs) || isInside(TEMPLATES_DIR, abs))) return abs;
  return insideProject(cwd, p, full);
}

function listFiles(dir, depth = 0, prefix = '') {
  if (depth > 3) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (['node_modules', '.git', '__pycache__'].includes(e.name)) { out.push(`${prefix}${e.name}/ (skipped)`); continue; }
    if (e.isDirectory()) out.push(`${prefix}${e.name}/`, ...listFiles(path.join(dir, e.name), depth + 1, `${prefix}${e.name}/`));
    else out.push(`${prefix}${e.name}`);
    if (out.length > 200) break;
  }
  return out;
}

function sourceFiles(dir, re, depth = 0) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (depth < 3 && !['node_modules', '.git', 'build', 'out', 'bin', 'obj', '__pycache__'].includes(e.name)) out.push(...sourceFiles(path.join(dir, e.name), re, depth + 1));
    } else if (re.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

// Builds and tools get "end of input" so nothing hangs on a question. A program being tried out
// gets a keyboard nobody types on, like a real window waiting for its player.
function runCommand(command, cwd, signal, timeoutMs = COMMAND_TIMEOUT, { keyboard = false } = {}) {
  return new Promise(resolve => {
    const proc = spawn(SHELL.exe, SHELL.args(command), { cwd, env: toolchain.commandEnv(cleanEnv()), windowsHide: true, stdio: [keyboard ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const add = d => { out += d; if (out.length > 200000) out = out.slice(-100000); };
    proc.stdout.on('data', add);
    proc.stderr.on('data', add);
    const kill = () => execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal.addEventListener('abort', kill);
    proc.on('error', err => { out += String(err.message); });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, timedOut, out: collapseRepeats(out.trim()) || '(no output)' });
    });
  });
}

const clipOut = s => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT / 2)}\n… (cut) …\n${s.slice(-MAX_OUTPUT / 2)}` : s);

// "x\nx\nx\n…" -> "x\n… (same line repeated N more times)", plus a hint when a program clearly loops.
function collapseRepeats(out) {
  const lines = out.split(/\r?\n/);
  const kept = [];
  let maxRun = 0;
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === lines[i].trim()) j++;
    const n = j - i;
    maxRun = Math.max(maxRun, n);
    kept.push(lines[i]);
    if (n > 3) kept.push(`… (same line repeated ${n - 1} more times)`);
    else for (let k = i + 1; k < j; k++) kept.push(lines[k]);
    i = j;
  }
  const hint = maxRun > 30
    ? '\n[Hatch: the program printed the same line over and over, so it loops forever once its input runs out or is invalid. Make it exit when reading input fails (C++: if (!(std::cin >> guess)) return 0;).]'
    : '';
  return kept.join('\n') + hint;
}

// A reply stuck repeating itself: the same stretch of text (a line, or a whole <edit> block)
// three times in a row at the end, or very few distinct lines over the last stretch.
function isRunaway(raw) {
  if (raw.length < 1500) return false;
  const tail = raw.slice(-4000);
  // long blocks repeated 3 times, or short ones 8 times (a few identical map rows in a game are fine)
  for (let p = 30; p * 3 <= tail.length && p <= 1300; p++) {
    const a = tail.slice(-p);
    if (!a.trim()) continue;
    let k = 1;
    while (k < 8 && (k + 1) * p <= tail.length && tail.slice(-(k + 1) * p, -k * p) === a) k++;
    if ((k >= 3 && p >= 200) || k >= 8) return true;
  }
  const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length >= 25 && new Set(lines).size <= 3;
}

// Commands copied from elsewhere (often a team lead's task) that don't work in Hatch's shell:
// "call vcvars64.bat && cl ..." (Visual C++ is already set up here) and a bare "game.exe"
// (bash only runs programs in the current folder as ./game.exe).
function fixShellCommand(command, cwd) {
  let c = command;
  const vc = /vcvars\w*\.bat\W*?(?:>\s*nul\s*)?&&\s*([\s\S]+)$/i.exec(c);
  if (vc) c = vc[1].replace(/["'`]+\s*$/, '').trim();
  const exe = /^([\w.-]+\.exe)(\s|$)/i.exec(c);
  if (exe && fs.existsSync(path.join(cwd, exe[1]))) c = `./${c}`;
  return c;
}

// Models often half-remember the raylib build command; add whatever it needs.
function fixRaylibBuild(command, cwd) {
  if (!/(^|[\s;&|])cl(\.exe)?\s/i.test(command)) return command;
  const flags = raylibBuildFlags();
  if (!flags) return command;
  const usesRaylib = /raylib/i.test(command) || sourceFiles(cwd, /\.(cpp|cc|cxx|h|hpp)$/i)
    .some(f => { try { return /#include\s*[<"]raylib\.h[>"]/.test(fs.readFileSync(f, 'utf8')); } catch { return false; } });
  if (!usesRaylib) return command;
  let [left, right = ''] = command.split(/\s-link\s/i);
  if (!/(^|\s)[-/]MD\b/.test(left)) left = left.replace(/(^|[\s;&|])(cl(\.exe)?)\s/i, '$1$2 -MD ');
  if (!/-I\s*"?[^"\s]*raylib/i.test(left)) left = left.replace(/(cl(\.exe)?\s+-MD)\s/i, `$1 ${flags.compile.replace('-MD ', '')} `);
  const libs = flags.link.match(/"[^"]+"|\S+/g);
  for (const lib of libs) {
    const name = lib.replace(/"/g, '').split('/').pop().toLowerCase();
    if (!left.toLowerCase().includes(name)) left += ` ${lib}`;
  }
  if (!/subsystem/i.test(right)) right += ' -subsystem:windows';
  if (!/-entry/i.test(right)) right += ` ${flags.entry}`;
  return `${left.trim()} -link ${right.trim()}`;
}

// The first errors in compiler/interpreter output, each with the code lines it points at.
function focusErrors(out, cwd) {
  const found = [];
  const add = (file, line, msg) => {
    if (found.length >= 6 || found.some(f => f.file === file && f.line === line && f.msg === msg)) return;
    found.push({ file, line, msg });
  };
  for (const l of out.split(/\r?\n/)) {
    let m;
    if ((m = /^(.+?)\((\d+)(?:,\d+)?\)\s*:\s*(?:fatal\s+)?error\s+\w*\d*:\s*(.+)$/.exec(l))) add(m[1], +m[2], m[3]);
    else if ((m = /^(.+?):(\d+):(?:\d+:)?\s*(?:fatal\s+)?error:\s*(.+)$/.exec(l))) add(m[1], +m[2], m[3]);
    else if ((m = /error (LNK\d+: .+)$/.exec(l))) add(null, null, m[1]);
    else if ((m = /^(.+\.(?:m?js|cjs|ts)):(\d+)$/.exec(l.trim()))) add(m[1], +m[2], '');
    else if ((m = /^\s*File "(.+?)", line (\d+)/.exec(l))) add(m[1], +m[2], '');
    else if ((m = /^(\w*Error: .+)$/.exec(l.trim())) && found.length && !found[found.length - 1].msg) found[found.length - 1].msg = m[1];
  }
  if (!found.length) return '';
  // Small files are shown whole (the model usually can't picture the file after its edits); big ones around the error.
  const shownWhole = new Set();
  const whole = [];
  const blocks = found.map(f => {
    let ctx = '';
    if (f.file && f.line) {
      try {
        const abs = path.isAbsolute(f.file) ? f.file : path.join(cwd, f.file);
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        if (lines.length <= 250) {
          if (!shownWhole.has(abs)) {
            shownWhole.add(abs);
            const errLines = new Set(found.filter(x => x.file === f.file).map(x => x.line));
            whole.push(`Current ${f.file} (> marks error lines):\n${lines.map((l, i) => `${errLines.has(i + 1) ? '>' : ' '}${String(i + 1).padStart(4)} | ${l}`).join('\n')}`);
          }
        } else {
          for (let n = Math.max(1, f.line - 3); n <= Math.min(lines.length, f.line + 3); n++) ctx += `${n === f.line ? '>' : ' '}${String(n).padStart(4)} | ${lines[n - 1]}\n`;
        }
      } catch {}
    }
    return `- ${f.file ? `${path.basename(f.file)} line ${f.line}: ` : ''}${f.msg}${ctx ? `\n${ctx}` : ''}`;
  });
  return `Errors to fix first:\n${blocks.join('\n')}${whole.length ? `\n\n${whole.join('\n\n')}` : ''}`;
}

const REWRITE_HINT = n => `\nThat's ${n} failed builds in a row. Stop patching with <edit>: rewrite the whole file correctly with <file> (its current content is shown above).`;

// ---------- history ----------

// Older replies keep their tags but not full file bodies, so the context stays small.
function slimHistory(history) {
  return history.map((m, i) => {
    if (i >= history.length - 2) return m;
    let c = m.content.replace(/<file\b([^>]*)>([\s\S]*?)<\/file>/g, (_, a, body) => `<file${a}>[${body.split('\n').length} lines written]</file>`);
    if (c.length > 4000) c = `${c.slice(0, 2000)}\n… (older text cut) …\n${c.slice(-1500)}`;
    return { ...m, content: c };
  });
}

async function ollamaChat(body, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${settings.ollamaUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
      });
      if (!res.ok) throw new Error(`Ollama: ${(await res.text()).replace(/^\{"error":"|"\}$/g, '') || res.status}`);
      return res;
    } catch (err) {
      if (signal?.aborted) throw err;
      // the connection dropped (Ollama restarting or briefly out of memory): try once more
      if (attempt === 0 && /fetch failed|ECONNRESET|socket/i.test(`${err.message} ${err.cause?.message || ''}`)) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      if (/fetch failed/i.test(err.message)) throw new Error(`Couldn't reach Ollama at ${settings.ollamaUrl}. It may have stopped or run out of memory: make sure it's running, then say "continue".`);
      throw err;
    }
  }
}

// When the conversation outgrows the model's memory, the model summarizes the older part.
async function compactIfNeeded(ctx, history, system, numCtx) {
  const size = system.length + history.reduce((n, m) => n + m.content.length, 0);
  if (size < numCtx * 2.4 || history.length < 6) return history;
  const old = history.slice(0, -4);
  const res = await ollamaChat({
    model: ctx.model, stream: false, think: false, options: { num_ctx: numCtx },
    messages: [
      { role: 'system', content: 'Summarize this conversation for your own memory in under 200 words: what the user wants, what was built, file names, the plan and its progress, and open problems.' },
      { role: 'user', content: slimHistory(old).map(m => `${m.role}: ${m.content}`).join('\n\n').slice(-numCtx * 2) },
    ],
  }, ctx.signal);
  const summary = ((await res.json()).message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  ctx.addItem({ type: 'note', text: 'Compressed earlier messages so the local model keeps up' });
  return [{ role: 'user', content: `Summary of our earlier conversation:\n${summary}` }, { role: 'assistant', content: 'Got it.' }, ...history.slice(-4)];
}

// ---------- the turn ----------

// Builds/checks the whole project the way Hatch does: { ok, output } or null when there's nothing to check.
export async function verifyProject(cwd, signal) {
  await toolchain.ready;
  const cmds = [];
  const cpp = sourceFiles(cwd, /\.(cpp|cc|cxx)$/i);
  if (cpp.length) {
    const text = cpp.map(f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
    const exe = fs.readdirSync(cwd).filter(f => /\.exe$/i.test(f))
      .sort((a, b) => fs.statSync(path.join(cwd, b)).mtimeMs - fs.statSync(path.join(cwd, a)).mtimeMs)[0] || 'game.exe';
    const cmd = toolchain.cppBuildCommand(cpp.map(f => path.relative(cwd, f).replace(/\\/g, '/')), exe, toolchain.cppNeeds(text));
    if (cmd) cmds.push(cmd);
  }
  const py = sourceFiles(cwd, /\.py$/i).map(f => `"${path.relative(cwd, f)}"`);
  if (py.length) cmds.push(`python -m py_compile ${py.join(' ')}`);
  const js = sourceFiles(cwd, /\.(js|mjs|cjs)$/i).map(f => `node --check "${path.relative(cwd, f)}"`);
  if (js.length) cmds.push(js.join(' && '));
  if (!cmds.length) return null;
  for (const command of cmds) {
    const r = await runCommand(command, cwd, signal || new AbortController().signal);
    if (r.code !== 0) return { ok: false, output: r.out };
  }
  return { ok: true, output: '' };
}

export async function run(ctx) {
  const { chat } = ctx;
  const overnight = !!ctx.overnight;
  // overnight nobody can answer prompts: work freely inside the project folder
  const permission = overnight && !['full', 'readonly'].includes(ctx.permission) ? 'always' : ctx.permission;
  const full = permission === 'full';
  // helpers get exact tasks from their lead: if they're not done in fewer steps, more rarely helps
  const maxRounds = overnight ? 60 : ctx.helper ? HELPER_ROUNDS : MAX_ROUNDS;
  const maxFailedBuilds = ctx.helper ? HELPER_FAILED_BUILDS : MAX_FAILED_BUILDS;
  const numCtx = settings.localContext || 32768;
  const activity = ctx.activity || (() => {});
  await toolchain.ready;

  const askedFor = [ctx.text, ...chat.items.filter(i => i.type === 'user').slice(-4).map(i => i.text)].join('\n');
  const chosen = guides.pick(askedFor, chat.cwd);
  const special = chosen.filter(g => g.name !== 'general.md').map(g => g.name.replace(/\.md$/, ''));
  if (special.length) ctx.addItem({ type: 'note', text: `Following the ${special.map(s => (s === 'cpp' ? 'C++' : s[0].toUpperCase() + s.slice(1))).join(' + ')} guide` });

  const system = systemPrompt(chat.cwd, ctx.instructions, chosen, { canPropose: !!ctx.proposeSkill });
  const store = ctx.store || chat;   // a team helper keeps its own conversation and plan
  let history = store.localHistory || [];
  history.push({ role: 'user', content: ctx.text });
  ctx.setSession('hatch-local');

  // what this turn has done so far
  const turn = {
    plan: store.localPlan || null, planCard: -1,
    changes: 0, codeChanged: false, verified: true, changedCode: new Set(),
    failed: new Map(),            // command -> change counter when it failed
    failedBuilds: 0, failStreak: 0, nudges: 0, lastSignature: '', repeats: 0, lastBuild: '',
    states: new Map(), lastState: '', cycles: 0,   // versions of the code seen this turn, to spot going in circles
    edits: new Set(),                              // edits already applied (to refuse exact repeats)
    okChecks: 0, planMark: { changes: 0, okChecks: 0 },   // successful builds/tests, and where things stood at the last plan
    idle: 0, doneSteps: 0,                         // rounds in a row without real progress
    seen: new Set(),                               // files and folders already looked at, as they were then
  };

  // A fingerprint of every code file changed this turn.
  const codeState = () => [...turn.changedCode].sort().map(rel => {
    try { return `${rel}:${fs.readFileSync(path.join(chat.cwd, rel), 'utf8')}`; } catch { return `${rel}:-`; }
  }).join('\n');

  const allowed = async (kind, cardIdx, toolName, input) => {
    if (permission === 'readonly' && !['read', 'list'].includes(kind)) return 'Not allowed: this chat is read-only.';
    if (ctx.noEdits && ['file', 'edit', 'template'].includes(kind)) {
      return 'Not allowed: you\'re a reviewer, so you can\'t change files. Describe the problem and the exact fix in your report instead.';
    }
    const runnable = kind === 'open' && RUNNABLE.test(input.file_path || '');
    const ask = (permission === 'ask' && ['file', 'edit', 'open', 'run'].includes(kind))
      || (permission === 'edits' && (kind === 'run' || runnable));
    if (!ask) return null;
    const ok = await ctx.askPermission(toolName, input, ctx.chat.items[cardIdx].id, ctx.signal);
    return ok ? null : 'The user did not allow this.';
  };

  const showPlan = steps => {
    turn.plan = steps;
    store.localPlan = steps;
    const input = { todos: steps };
    if (turn.planCard >= 0) ctx.updateItem(turn.planCard, { input });
    else turn.planCard = ctx.addItem({ type: 'tool', id: `hl-plan-${Date.now()}`, name: 'TodoWrite', input, status: 'done' });
  };

  const noteChange = rel => {
    turn.changes++;
    if (CODE_EXT.test(rel)) { turn.codeChanged = true; turn.verified = false; turn.changedCode.add(rel); }
  };

  const newCard = (name, input) => ctx.addItem({ type: 'tool', id: `hl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, input, status: 'running' });

  // Hatch builds/checks the code itself, the way a careful engineer would before saying it's done.
  const autoCheck = async () => {
    const cmds = [];
    const cpp = sourceFiles(chat.cwd, /\.(cpp|cc|cxx)$/i);
    if (cpp.length && [...turn.changedCode].some(f => /\.(cpp|cc|cxx|h|hpp)$/i.test(f))) {
      const text = cpp.map(f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      const exe = /-Fe:?\s*"?([\w.-]+\.exe)/i.exec(turn.lastBuild)?.[1] || /-o\s+"?([\w.-]+?)(\.exe)?["\s]/.exec(`${turn.lastBuild} `)?.[1]?.replace(/$/, '.exe')
        || (cpp.length === 1 && !/^main\./i.test(path.basename(cpp[0])) ? path.basename(cpp[0]).replace(/\.\w+$/, '.exe') : 'game.exe');
      const cmd = toolchain.cppBuildCommand(cpp.map(f => path.relative(chat.cwd, f).replace(/\\/g, '/')), exe, toolchain.cppNeeds(text));
      if (cmd) cmds.push(cmd);
    }
    const py = [...turn.changedCode].filter(f => /\.py$/i.test(f));
    if (py.length) cmds.push(`python -m py_compile ${py.map(f => `"${f}"`).join(' ')}`);
    const js = [...turn.changedCode].filter(f => /\.(js|mjs|cjs)$/i.test(f) && !f.includes('node_modules'));
    if (js.length) cmds.push(js.map(f => `node --check "${f}"`).join(' && '));
    if (!cmds.length) { turn.verified = true; return null; }
    activity('Checking the build');

    for (const command of cmds) {
      const idx = newCard('Bash', { command, description: 'Hatch check' });
      const r = await runCommand(command, chat.cwd, ctx.signal);
      ctx.updateItem(idx, { status: r.code === 0 ? 'done' : 'error', result: r.out.slice(0, 8000) });
      if (r.code !== 0) {
        turn.failedBuilds++;
        turn.failStreak++;
        const focus = focusErrors(r.out, chat.cwd);
        return { ok: false, message: `Hatch built your code to check it, and it failed:\n<result of="run" exit="${r.code}">\n$ ${command}\n${clipOut(r.out)}\n</result>\n${focus}\n\nFix these errors, then build again.${turn.failStreak >= 2 ? REWRITE_HINT(turn.failStreak) : ''}` };
      }
    }
    turn.failStreak = 0;
    turn.verified = true;
    return { ok: true };
  };

  // When a local model gets stuck: build what it made (so the user knows where things stand),
  // say so plainly, and point to a bigger local model if there is one.
  const finishStuck = async reason => {
    let status = '';
    if (turn.codeChanged && !turn.verified) {
      const check = await autoCheck();
      if (check) status = check.ok ? ' Hatch built the final version and it works.' : ' Hatch built the final version and it doesn\'t build yet.';
    } else if (turn.codeChanged) {
      status = ' The last version builds fine.';
    }
    const plan = turn.plan || [];
    const done = plan.filter(s => s.status === 'completed').length;
    const planNote = plan.length && done < plan.length ? ` ${done} of ${plan.length} plan steps are really done.` : '';
    const bigger = overnight || ctx.helper ? null : await biggerLocalModel(ctx.model);
    const tip = bigger ? ` Tip: ${bigger} is a bigger model that handles builds like this better. Pick it in the model menu and say "continue".` : '';
    turn.stuck = reason;
    ctx.addItem({ type: 'note', text: `${overnight ? 'Session ended' : 'Stopped'}: ${reason}.${status}${planNote}${tip}` });
  };

  // Stopping right after </run> makes the model wait for the real output instead of inventing it.
  // Ollama also applies stop words to a model's hidden thinking, where it often plans the exact tag
  // (leaving an empty reply), so for thinking models Hatch cuts the reply itself (see the stream loop).
  // Thinking makes a slow model much slower; helpers get exact tasks from their lead, so by default
  // only a model working on its own thinks (Settings > Local models).
  const thinks = (await vision.modelCaps(ctx.model)).includes('thinking');
  const mode = settings.localThinking || 'auto';
  const think = thinks ? mode === 'on' || (mode === 'auto' && !ctx.helper) : undefined;
  const stop = think ? [] : ['</run>', '<result'];

  let round;
  for (round = 0; round < maxRounds; round++) {
    history = await compactIfNeeded(ctx, history, system, numCtx);
    store.localHistory = history;

    // a model that isn't loaded yet, or a long conversation, takes a while before the first word
    activity(round === 0 ? 'Loading the model and reading the task' : 'Reading the results');
    const res = await ollamaChat({
      model: ctx.model, stream: true, keep_alive: '30m', ...(think === undefined ? {} : { think }),
      options: { num_ctx: numCtx, temperature: 0.3, num_predict: 8192, stop },
      messages: [{ role: 'system', content: system }, ...slimHistory(history).map((m, i, all) => (
        i === all.length - 1 && m.imagePaths
          ? { role: m.role, content: m.content, images: m.imagePaths.filter(p => fs.existsSync(p)).map(vision.imageBase64) }
          : { role: m.role, content: m.content }))],
    }, ctx.signal);

    const parser = new ActionParser();
    const results = [];        // fed back to the model
    const jobs = [];           // helpers working on tasks this reply handed out
    let freshLooks = 0;        // files or folders this reply looked at that it hadn't seen like this before
    const looked = key => {
      if (turn.seen.has(key)) return true;
      turn.seen.add(key);
      freshLooks++;
      return false;
    };
    const pendingImages = [];  // screenshots for models that can see
    const signature = [];      // what this reply did, to spot loops
    let raw = '';
    let bubble = -1;
    let pendingSpace = '';
    let card = -1;
    let lastBodyUpdate = 0;
    let acted = false;
    let needsReply = false;    // run/read/list or a failure: the model should see the result
    const written = new Set(); // files written this reply (tags or code blocks)
    let replyFails = 0;        // failed actions in this reply; a reply that keeps failing gets cut short

    const act = async (tag, attrs, body, idx, incomplete) => {
      acted = true;
      signature.push(`${tag}:${attrs.path || attrs.url || ''}:${body.trim().slice(0, 300)}`);
      try {
        if (tag === 'plan') {
          let steps = parsePlan(body);
          if (!steps.length) return;
          // a step only counts as done if something real happened since the last plan: code changed or a check passed
          const wasDone = new Set((turn.plan || []).filter(s => s.status === 'completed').map(s => s.content));
          const newlyDone = steps.filter(s => s.status === 'completed' && !wasDone.has(s.content));
          const progress = turn.changes > turn.planMark.changes || turn.okChecks > turn.planMark.okChecks;
          if (turn.plan && newlyDone.length && !progress) {
            steps = steps.map(s => (newlyDone.includes(s) ? { ...s, status: 'pending' } : { ...s, status: s.status === 'in_progress' ? 'pending' : s.status }));
            const next = steps.find(s => s.status === 'pending');
            if (next) next.status = 'in_progress';
            results.push(`You marked "${newlyDone.map(s => s.content).join('", "')}" as done, but nothing changed since your last plan (no code written, no check run). Hatch left ${newlyDone.length === 1 ? 'it' : 'them'} unchecked. Do the work with <file> or <edit>, build it, and only then mark it done.`);
            needsReply = true;
            replyFails++;
          }
          turn.planMark = { changes: turn.changes, okChecks: turn.okChecks };
          showPlan(steps);
          return;
        }
        if (tag === 'file') {
          const content = stripFences(body);
          // no path given: if the project has exactly one file of this kind, that's the one being rewritten
          if (!attrs.path) {
            const kind = /#include\s*[<"]/.test(content) ? /\.(cpp|cc|cxx)$/i : /<!doctype html|<html/i.test(content) ? /\.html?$/i
              : /^\s*(import|from|def)\s/m.test(content) ? /\.py$/i : null;
            const same = kind ? sourceFiles(chat.cwd, kind) : [];
            if (same.length === 1) attrs.path = path.relative(chat.cwd, same[0]).replace(/\\/g, '/');
            else throw new Error('No path given. Write it like <file path="main.cpp">…</file>.');
            ctx.updateItem(idx, { input: { file_path: attrs.path, content } });
          }
          ctx.updateItem(idx, { input: { file_path: attrs.path, content } });
          if (incomplete) throw new Error('The reply ended before the file was finished. Write it again, completely.');
          if (looksUnfinished(attrs.path, content)) throw new Error(`${attrs.path} looks unfinished (empty or placeholder text like "..."). Write the COMPLETE file.`);
          const deny = await allowed('file', idx, 'Write', { file_path: attrs.path, content });
          if (deny) throw new Error(deny);
          const abs = insideProject(chat.cwd, attrs.path, full);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content);
          ctx.updateItem(idx, { input: { file_path: abs, content }, status: 'done' });
          noteChange(attrs.path);
          written.add(attrs.path.replace(/\\/g, '/').replace(/^\.\//, ''));
          results.push(`Wrote ${attrs.path} (${content.split('\n').length - 1} lines).`);
        } else if (tag === 'edit') {
          const find = /<find>([\s\S]*?)<\/find>/.exec(body)?.[1] ?? attrs.find;
          const repl = /<replace>([\s\S]*?)<\/replace>/.exec(body)?.[1] ?? attrs.replace ?? '';
          ctx.updateItem(idx, { input: { file_path: attrs.path, old_string: find, new_string: repl } });
          if (find != null && find.trim() === repl.trim()) {
            throw new Error('That edit changes nothing: <find> and <replace> are the same. To add code, put the found text PLUS your new code in <replace>, or rewrite the whole file with <file>.');
          }
          const editKey = `${attrs.path}\n${find}\n${repl}`;
          if (turn.edits.has(editKey)) throw new Error('You already made this exact edit, so it is in the file. Do the next step instead.');
          const deny = await allowed('edit', idx, 'Edit', { file_path: attrs.path });
          if (deny) throw new Error(deny);
          const abs = insideProject(chat.cwd, attrs.path, full);
          const text = fs.readFileSync(abs, 'utf8');
          let at = find == null ? -1 : text.indexOf(find);
          let len = find?.length || 0;
          if (at < 0 && find?.trim()) {   // tolerate different indentation/line endings
            const esc = find.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
            const m = new RegExp(esc).exec(text);
            if (m) { at = m.index; len = m[0].length; }
          }
          if (at < 0) throw new Error(`Couldn't find that text in ${attrs.path}. <read> the file first, or rewrite it with <file>.`);
          const updated = text.slice(0, at) + repl + text.slice(at + len);
          fs.writeFileSync(abs, updated);
          turn.edits.add(editKey);
          ctx.updateItem(idx, { status: 'done' });
          noteChange(attrs.path);
          // show the model what that part of the file looks like now
          const lines = updated.split('\n');
          const first = updated.slice(0, at).split('\n').length;
          const last = first + repl.split('\n').length - 1;
          const shown = lines.slice(Math.max(0, first - 4), Math.min(lines.length, last + 3))
            .map((l, n) => `${String(Math.max(1, first - 3) + n).padStart(4)} | ${l}`).join('\n');
          results.push(`Edited ${attrs.path}. Lines ${first}-${last} now read (with a little context):\n${shown}`);
        } else if (tag === 'run') {
          let asked = body.trim();
          // every quote written as \" (copied from JSON somewhere): the shell would see literal quotes
          if (asked.includes('\\"') && !/(^|[^\\])"/.test(asked)) asked = asked.replace(/\\"/g, '"');
          const shellOk = fixShellCommand(asked, chat.cwd);
          if (shellOk !== asked) results.push(`(Hatch ran it as: ${shellOk}. Visual C++ is already set up in your commands, and programs in this folder run as ./name.exe.)`);
          const command = fixRaylibBuild(shellOk, chat.cwd);
          if (command !== shellOk) results.push('(Hatch added the build flags raylib needs to your command.)');
          const isProgram = PROGRAM_RUN.test(command) && !CHECK_CMD.test(command.replace(/\b(python|py|node)\s+\S+\.(py|m?js)/gi, ''));
          const timeoutMs = attrs.timeout ? Math.min(180, Math.max(1, Number(attrs.timeout) || 5)) * 1000
            : isProgram ? PROGRAM_TIMEOUT : COMMAND_TIMEOUT;
          ctx.updateItem(idx, { input: { command } });
          if (turn.failed.get(command) === turn.changes) {
            throw new Error('Not run: this exact command already failed and nothing changed since. Fix the cause first, or use a different approach (see "Tools on this PC").');
          }
          const deny = await allowed('run', idx, 'Bash', { command });
          if (deny) throw new Error(deny);
          activity(`Running: ${command.replace(/\s+/g, ' ').slice(0, 70)}`);
          const piped = /\|\s*(\.\/|\S+\.exe|python|py|node)/i.test(command) || /</.test(command);
          const r = await runCommand(command, chat.cwd, ctx.signal, timeoutMs, { keyboard: isProgram && !piped });
          const quickRun = r.timedOut && (attrs.timeout || isProgram);
          const ok = r.code === 0 || quickRun;
          const waiting = quickRun && /[:?>]\s*$/.test(r.out.split('\n').pop() || '');
          const out = quickRun
            ? `${clipOut(r.out)}\n[${waiting ? 'It started fine and is waiting for the player to type' : `Still running after ${timeoutMs / 1000}s, so it started fine`}. Hatch stopped it. Nobody can type into it from here: to test input, pipe answers in (printf '50\\n25\\n' | ./game.exe). The user plays it with <open>.]`
            : r.timedOut ? `${r.out}\n[stopped after ${timeoutMs / 1000}s]` : r.out;
          ctx.updateItem(idx, { status: ok ? 'done' : 'error', result: out.slice(0, 8000) });
          const isBuild = CHECK_CMD.test(command);
          if (isBuild && /\b(cl|g\+\+|clang\+\+)\b/.test(command)) turn.lastBuild = command;
          if (ok) {
            turn.okChecks++;
            looked(`ok:${command}@${turn.changes}`);   // a check that newly passed is progress (it's how reviewers work)
          }
          if (ok && isBuild) { turn.verified = true; turn.failStreak = 0; }
          if (!ok) {
            turn.failed.set(command, turn.changes);
            if (isBuild) { turn.failedBuilds++; turn.failStreak++; }
          }
          const focus = ok ? '' : focusErrors(out, chat.cwd);
          const rewrite = !ok && isBuild && turn.failStreak >= 2 ? REWRITE_HINT(turn.failStreak) : '';
          // running a program that was never built: say how to build it
          let buildHint = '';
          const exe = /([\w.-]+\.exe)/i.exec(command)?.[1];
          if (!ok && exe && /no such file|not found|cannot find|not recognized/i.test(out)) {
            const cpp = sourceFiles(chat.cwd, /\.(cpp|cc|cxx)$/i).map(f => path.relative(chat.cwd, f).replace(/\\/g, '/'));
            const text = cpp.map(f => { try { return fs.readFileSync(path.join(chat.cwd, f), 'utf8'); } catch { return ''; } }).join('\n');
            const build = cpp.length && toolchain.cppBuildCommand(cpp, exe, toolchain.cppNeeds(text));
            buildHint = build ? `\n${exe} hasn't been built yet. Build it first: <run>${build}</run>` : `\n${exe} hasn't been built yet.`;
          }
          results.push(`<result of="run" exit="${quickRun ? 'still running' : r.code}">\n$ ${command}\n${clipOut(out)}\n</result>${focus ? `\n${focus}` : ''}${rewrite}${buildHint}`);
          needsReply = true;
        } else if (tag === 'read') {
          const abs = readable(chat.cwd, attrs.path, full);
          const text = fs.readFileSync(abs, 'utf8');
          ctx.updateItem(idx, { status: 'done', result: text.slice(0, 8000) });
          const numbered = text.split('\n').map((l, n) => `${String(n + 1).padStart(4)} | ${l}`).join('\n');
          // reading the same unchanged file again isn't progress (small models can loop on it)
          const again = looked(`read:${abs}:${text}`);
          results.push(`<result of="read" path="${attrs.path}">\n${clipOut(numbered)}\n</result>${again ? `\n(You already read ${attrs.path} and it hasn't changed since. Don't read it again: do the next step of your task.)` : ''}`);
          needsReply = true;
        } else if (tag === 'list') {
          const abs = readable(chat.cwd, attrs.path || '.', full);
          const list = listFiles(abs).join('\n') || '(empty folder)';
          ctx.updateItem(idx, { status: 'done', result: list });
          const again = looked(`list:${abs}:${list}`);
          results.push(`<result of="list" path="${attrs.path || '.'}">\n${list}\n</result>${again ? '\n(Nothing changed in this folder since you last looked. Do the next step instead.)' : ''}`);
          needsReply = true;
        } else if (tag === 'open') {
          if (overnight || ctx.helper) {
            ctx.updateItem(idx, { status: 'done', result: overnight ? 'Skipped: the user is asleep. They\'ll open it in the morning.' : 'Skipped: helpers don\'t open things; the lead tells the user.' });
            results.push(overnight ? 'Not opened: the user is asleep. Keep working.' : 'Not opened: you\'re a helper, so the lead decides what to show the user. If your task is done, write your short report and stop.');
            return;
          }
          const deny = await allowed('open', idx, 'Open', { file_path: attrs.path });
          if (deny) throw new Error(deny);
          const abs = insideProject(chat.cwd, attrs.path, full);
          if (!fs.existsSync(abs)) throw new Error(`${attrs.path} doesn't exist${RUNNABLE.test(attrs.path) ? ' yet. Build it first' : ''}.`);
          const err = await shell.openPath(abs);
          if (err) throw new Error(err);
          ctx.updateItem(idx, { status: 'done', input: { file_path: abs } });
          results.push(`Opened ${attrs.path} for the user.`);
        } else if (tag === 'preview') {
          // no path: the program it just built, or the project's web page
          const builtExe = /-Fe:?\s*"?([\w.-]+\.exe)/i.exec(turn.lastBuild)?.[1];
          const guess = [builtExe, 'game.exe', 'index.html'].find(f => f && fs.existsSync(path.join(chat.cwd, f)));
          const target = attrs.url || attrs.path || guess;
          if (!target) throw new Error('Say what to preview, like <preview path="game.exe"/> or <preview path="index.html"/>.');
          if (!attrs.path && !attrs.url) ctx.updateItem(idx, { input: { file_path: target } });
          if (/\.exe$/i.test(target)) {   // previewing a program means running it
            const deny = await allowed('run', idx, 'Preview', { file_path: target });
            if (deny) throw new Error(deny);
          }
          const abs = /^https?:\/\//i.test(target) ? target : insideProject(chat.cwd, target, full);
          const shot = await preview.capture(abs, PREVIEW_DIR);
          ctx.updateItem(idx, { input: { file_path: abs, image: shot.image } });
          const notes = [];
          if (shot.colors) notes.push(`Measured by Hatch (reliable): ${shot.size.width}x${shot.size.height} pixels, main colors: ${shot.colors}.`);
          if (shot.blank) notes.push('The screenshot is almost one solid color, so nothing may be drawn.');
          if (shot.errors.length) notes.push(`Errors in the page:\n${shot.errors.join('\n')}`);
          let seen;
          if (await vision.modelHasVision(ctx.model)) {
            pendingImages.push(shot.image);
            seen = 'The screenshot is attached to this message: look at it.';
          } else {
            ctx.updateItem(idx, { result: 'Looking at the screenshot…' });
            const d = await vision.describe(shot.image, { expect: attrs.expect, signal: ctx.signal });
            seen = d ? `What the screenshot shows (described by ${d.model}):\n${d.text}`
              : 'No vision model is installed, so nobody could look at the screenshot. (The user can install one with: ollama pull moondream)';
          }
          ctx.updateItem(idx, { status: 'done', result: [seen, ...notes].join('\n\n') });
          turn.okChecks++;
          results.push(`<result of="preview" path="${target}">\n${[seen, ...notes].join('\n\n')}\n</result>`);
          needsReply = true;
        } else if (tag === 'template') {
          const name = (attrs.name || body || '').trim().replace(/[^\w-]/g, '');
          const dir = path.join(TEMPLATES_DIR, name);
          if (!name || !fs.existsSync(dir)) {
            throw new Error(`No template "${name}". Templates: ${fs.readdirSync(TEMPLATES_DIR).join(', ')}.`);
          }
          if (name.includes('raylib') && !raylib()) throw new Error('raylib isn\'t installed, so use <template name="cpp-3d-opengl"/> instead (or the user can install raylib in Settings > Local models).');
          const deny = await allowed('file', idx, 'Template', { name });
          if (deny) throw new Error(deny);
          const copied = [];
          const skipped = [];
          for (const f of fs.readdirSync(dir)) {
            const to = path.join(chat.cwd, f);
            if (fs.existsSync(to)) { skipped.push(f); continue; }
            fs.copyFileSync(path.join(dir, f), to);
            copied.push(f);
            noteChange(f);
            written.add(f);
          }
          const main = copied.find(f => /\.(cpp|c|py|js|html)$/.test(f));
          const code = main ? fs.readFileSync(path.join(chat.cwd, main), 'utf8') : '';
          ctx.updateItem(idx, { status: 'done', input: { name, files: copied }, result: `${copied.join(', ') || 'nothing new'}${skipped.length ? ` (kept your existing ${skipped.join(', ')})` : ''}` });
          results.push(`<result of="template" name="${name}">\nCopied: ${copied.join(', ') || 'nothing'}${skipped.length ? `. Kept existing: ${skipped.join(', ')}` : ''}.${main ? `\nCurrent ${main}:\n${code.split('\n').map((l, n) => `${String(n + 1).padStart(4)} | ${l}`).join('\n')}` : ''}\n</result>`);
          needsReply = true;
        } else if (tag === 'skill') {
          const s = skills.load((attrs.name || body || '').trim());
          if (!s) throw new Error(`No skill "${attrs.name || body}". Skills: ${skills.catalog().map(k => k.name).join(', ') || 'none installed'}.`);
          ctx.updateItem(idx, { status: 'done', input: { name: s.name }, result: s.description });
          results.push(`<result of="skill" name="${s.name}">\nFollow this skill. Its files are in ${s.dir} (read them with <read path="${fwdSlash(s.dir)}/...">).\nFiles: ${s.files.join(', ')}\n\n${s.text}\n</result>`);
          needsReply = true;
        } else if (tag === 'delegate') {
          const agent = attrs.to || attrs.agent || '';
          const task = body.trim();
          ctx.updateItem(idx, { input: { agent, task } });
          if (!ctx.team) throw new Error('This chat has no team, so there is nobody to delegate to. Do the work yourself.');
          if (incomplete) throw new Error('The reply ended before the task was finished. Write the <delegate> again, completely.');
          // the helper works while the reply goes on, so several <delegate> tags run at the same time
          jobs.push(ctx.team.delegate(agent, task)
            .catch(err => ({ ok: false, text: String(err?.message || err) }))
            .then(r => ({ r, idx, agent })));
          needsReply = true;
        } else if (tag === 'newskill') {
          // shows in the chat as a proposal the user approves or declines
          if (!ctx.proposeSkill) throw new Error('Only the lead AI can propose skills. Mention the idea in your report instead.');
          // models often just forget </newskill> at the end of their reply; the user reviews it anyway
          if (incomplete && body.trim().length < 40) throw new Error('The reply ended before the skill was finished. Write the <newskill> again, completely.');
          const r = ctx.proposeSkill({ name: attrs.name, description: attrs.description, instructions: body.trim() });
          results.push(r.text);
          if (!r.ok) needsReply = true;
        } else if (tag === 'remember') {
          if (permission === 'readonly') throw new Error('Not allowed: this chat is read-only.');
          appendMemory(body.trim());
          ctx.updateItem(idx, { status: 'done', input: { fact: body.trim() } });
          results.push('Saved to memory.');
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        if (idx >= 0) ctx.updateItem(idx, { status: 'error', result: err.message });
        results.push(`<result of="${tag}" error="true">${err.message}</result>`);
        needsReply = true;
        replyFails++;
      }
    };

    const CARD = { file: 'Write', edit: 'Edit', run: 'Bash', read: 'Read', list: 'LS', open: 'Open', remember: 'Remember', preview: 'Preview', template: 'Template', skill: 'Skill', delegate: 'Delegate' };
    const cardInput = (tag, attrs) => (tag === 'run' ? { command: '' } : tag === 'remember' ? { fact: '' }
      : tag === 'delegate' ? { agent: attrs.to || attrs.agent || '', task: '' }
      : tag === 'list' ? { path: attrs.path || '.' } : tag === 'template' || tag === 'skill' ? { name: attrs.name || '' }
        : { file_path: attrs.path || attrs.url, content: '' });

    // Code shown in ``` blocks under a file name is saved for the model, before it runs or opens anything.
    let looseSaved = 0;
    const flushLoose = async () => {
      const text = raw.replace(/<file\b[\s\S]*?(<\/file>|$)/g, '').replace(/<(edit|run|plan|remember|delegate|newskill)\b[\s\S]*?(<\/\1>|$)/g, '');
      for (const f of looseFiles(text)) {
        const key = f.path.replace(/^\.\//, '');
        if (written.has(key)) continue;
        written.add(key);
        looseSaved++;
        const idx = newCard('Write', { file_path: f.path, content: f.content });
        await act('file', { path: f.path }, f.content, idx);
      }
    };

    const handle = async ev => {
      if ((ev.type === 'open' || ev.type === 'self') && ['run', 'preview', 'open'].includes(ev.tag)) await flushLoose();
      if (ev.type === 'open' || ev.type === 'self') activity(tagStatus(ev.tag, ev.attrs));
      else if (ev.type === 'text' && ev.text.trim()) activity('Writing a reply');
      if (ev.type === 'text') {
        if (bubble < 0) {
          pendingSpace += ev.text;
          if (!pendingSpace.trim()) return;
          bubble = ctx.addItem({ type: 'assistant', text: '' });
          ctx.appendText(bubble, pendingSpace.replace(/^\s+/, ''));
          pendingSpace = '';
        } else ctx.appendText(bubble, ev.text);
      } else if (ev.type === 'open') {
        bubble = -1;
        card = NO_CARD.includes(ev.tag) ? -1 : newCard(CARD[ev.tag], cardInput(ev.tag, ev.attrs));
      } else if (ev.type === 'body') {
        if (card >= 0 && Date.now() - lastBodyUpdate > 120) {
          lastBodyUpdate = Date.now();
          const live = ev.tag === 'file' ? { file_path: ctx.chat.items[card].input.file_path, content: stripFences(ev.body) }
            : ev.tag === 'run' ? { command: ev.body.trim() } : ev.tag === 'remember' ? { fact: ev.body.trim() }
              : ev.tag === 'delegate' ? { ...ctx.chat.items[card].input, task: ev.body.trim() } : null;
          if (live) ctx.updateItem(card, { input: live });
        }
      } else if (ev.type === 'close') {
        await act(ev.tag, ev.attrs, ev.body, card, ev.incomplete);
        pendingSpace = '';
      } else if (ev.type === 'self') {
        bubble = -1;
        const idx = NO_CARD.includes(ev.tag) ? -1 : newCard(CARD[ev.tag], cardInput(ev.tag, ev.attrs));
        await act(ev.tag, ev.attrs, '', idx);
        pendingSpace = '';
      }
    };

    // stream the reply
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = '';
    let usage = { input: 0, output: 0 };
    let checkedAt = 0;
    let cutOff = '';
    let waiting = false;   // the reply ended with a command or delegations: it waits for the results
    let delegatedTo = -1;  // where the last </delegate> ends in raw
    for (;;) {
      const { done, value } = await reader.read();
      if (done || waiting) break;
      if (raw.length - checkedAt > 1500) {
        checkedAt = raw.length;
        if (isRunaway(raw)) {
          await reader.cancel().catch(() => {});
          cutOff = 'runaway';
          break;
        }
      }
      lineBuf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        let chunk;
        try { chunk = JSON.parse(line); } catch { continue; }
        if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
        if (chunk.message?.thinking) activity('Thinking');
        const piece = chunk.message?.content || '';
        if (piece) {
          raw += piece;
          for (const ev of parser.push(piece)) {
            // after handing out tasks only more <delegate> tags may follow: anything else would be made up
            if (delegatedTo >= 0 && ev.tag !== 'delegate' && !(ev.type === 'text' && !ev.text.trim())) {
              waiting = true;
              await reader.cancel().catch(() => {});
              raw = raw.slice(0, delegatedTo);
              parser.buf = '';
              parser.mode = 'text';
              break;
            }
            // a finished <run> ends the reply: its output has to come from really running it
            if (ev.type === 'close' && ev.tag === 'run') {
              waiting = true;
              await reader.cancel().catch(() => {});
              raw = raw.slice(0, raw.lastIndexOf('</run>') + '</run>'.length);
              parser.buf = '';
            }
            await handle(ev);
            if (ev.type === 'close' && ev.tag === 'delegate') {
              const at = raw.indexOf('</delegate>', delegatedTo < 0 ? 0 : delegatedTo);
              delegatedTo = at < 0 ? raw.length : at + '</delegate>'.length;
            }
            if (waiting) break;
          }
          if (waiting) break;
        }
        if (replyFails >= 4 && !cutOff) {
          await reader.cancel().catch(() => {});
          cutOff = 'fails';
          break;
        }
        if (chunk.done) {
          usage = { input: chunk.prompt_eval_count || 0, output: chunk.eval_count || 0 };
          if (chunk.done_reason === 'length') cutOff = 'length';
        }
      }
    }
    if (waiting && !usage.output) usage = { input: 0, output: Math.round(raw.length / 4) };   // cut off before Ollama's totals arrived
    // the stop sequence swallows "</run>": close the command ourselves
    if (parser.mode === 'tag' && parser.tag === 'run' && !cutOff) {
      raw += '</run>';
      for (const ev of parser.push('</run>')) await handle(ev);
    }
    for (const ev of parser.push('', true)) await handle(ev);
    // wait for the helpers this reply handed work to (they work at the same time)
    if (jobs.length) activity('Waiting for helpers');
    for (const { r, idx, agent } of await Promise.all(jobs)) {
      ctx.updateItem(idx, { status: r.ok ? 'done' : 'error', result: r.text });
      for (const f of r.changed || []) noteChange(f);
      if (r.builds) turn.verified = true;
      results.push(`<result of="delegate" to="${agent}">\n${r.text}\n</result>`);
    }
    if (cutOff === 'fails') {
      ctx.addItem({ type: 'note', text: 'Stopped a reply after several failed steps' });
      results.push('(Hatch stopped your reply because several steps in a row failed. Read the errors above, then try a different approach, for example rewrite the whole file with <file>.)');
      needsReply = true;
    } else if (cutOff === 'runaway') {
      ctx.addItem({ type: 'note', text: 'Stopped a reply that was repeating itself' });
      raw = raw.slice(0, 3000);
      results.push('(Your last reply started repeating the same lines, so Hatch stopped it. Don\'t copy program output into your reply.)');
      needsReply = true;
    } else if (cutOff === 'length') {
      results.push('(Your reply hit the length limit and was cut off. Keep replies shorter: one or two files at a time.)');
      needsReply = true;
    }
    ctx.reportUsage({ ...usage, cached: 0, cost: 0 });
    history.push({ role: 'assistant', content: raw });

    // safety nets for models that wrote code without tags
    const calls = acted ? [] : jsonToolCalls(raw);
    for (const c of calls) {
      const idx = newCard(CARD[c.tag], cardInput(c.tag, c.attrs));
      const body = c.tag === 'edit' ? `<find>${c.find ?? ''}</find><replace>${c.replace ?? ''}</replace>` : c.body;
      await act(c.tag, c.attrs, body, idx);
    }
    if (!calls.length) await flushLoose();
    if (looseSaved) results.push('(Hatch saved the code from your ``` blocks as files. Next time put files in <file> tags and commands in <run> tags.)');
    store.localHistory = history;

    // ---------- decide what happens next ----------
    const sig = signature.join('|');
    turn.repeats = sig && sig === turn.lastSignature ? turn.repeats + 1 : 0;
    turn.lastSignature = sig;
    // ---------- is it still making real progress? ----------
    let stuck = '';
    if (turn.repeats >= 2) stuck = 'the local model kept repeating the same steps';
    let changed = false;
    if (turn.changedCode.size) {
      const state = codeState();
      if (state !== turn.lastState) {
        changed = true;
        if (turn.states.has(state)) turn.cycles++;   // back to a version it already had = going in circles
        turn.states.set(state, round);
        turn.lastState = state;
      }
      if (turn.cycles >= 2) stuck = 'the local model kept switching between the same versions of the code';
    }
    const doneSteps = turn.plan?.filter(s => s.status === 'completed').length || 0;
    const learned = freshLooks > 0 || signature.some(s => /^(preview|template|skill|delegate):/.test(s));
    turn.idle = changed || doneSteps > turn.doneSteps || learned ? 0 : turn.idle + 1;
    turn.doneSteps = doneSteps;
    if (!stuck && turn.idle >= 3) stuck = 'the local model stopped making progress (its last few steps changed nothing)';
    if (!stuck && turn.failedBuilds >= maxFailedBuilds) stuck = `the local model couldn't get it to build after ${maxFailedBuilds} tries`;
    if (stuck) {
      await finishStuck(stuck);
      break;
    }

    let next = '';
    if (needsReply) {
      next = `Results:\n${results.join('\n')}\n\nContinue with your plan.`;
    } else if (turn.codeChanged && !turn.verified) {
      const check = await autoCheck();
      if (check && !check.ok) next = `${results.length ? `Results:\n${results.join('\n')}\n\n` : ''}${check.message}`;
    }
    // wrote a tutorial instead of doing the work
    if (!next && !acted && /```/.test(raw) && turn.nudges < MAX_NUDGES) {
      turn.nudges++;
      next = `${results.length ? `Results:\n${results.join('\n')}\n\n` : ''}You described the steps instead of doing them. Do them now: put each file in a <file path="..."> tag with its full content, and each command in a <run> tag. No \`\`\` blocks.`;
    }
    // keep going while the plan has open steps: freely while it's making progress, a couple of times if it stalls
    const pending = turn.plan?.filter(s => s.status !== 'completed') || [];
    const stalled = !acted;
    if (!next && pending.length && (!stalled || turn.nudges < MAX_NUDGES)) {
      if (stalled) turn.nudges++;
      next = `${results.length ? `Results:\n${results.join('\n')}\n\n` : ''}Your plan still has unfinished steps:\n${turn.plan.map(s => `- [${s.status === 'completed' ? 'x' : ' '}] ${s.content}`).join('\n')}\n\nDo the next unchecked step now with action tags. If every step is actually done, write the <plan> with all steps marked [x], then give your short final message.`;
    }
    // messages the user sent while it worked go along with the next round
    const steer = ctx.takeMessages?.() || [];
    if (steer.length) next = `${next ? `${next}\n\n` : results.length ? `Results:\n${results.join('\n')}\n\n` : ''}${ctx.steerNote(steer)}`;
    if (!next) break;
    history.push({ role: 'user', content: next, ...(pendingImages.length ? { imagePaths: pendingImages } : {}) });
  }
  if (round >= maxRounds) await finishStuck('it used up its step limit for one message');

  // how it went, for overnight work
  const plan = turn.plan || [];
  return {
    stuck: turn.stuck || null,
    codeChanged: turn.codeChanged,
    verified: turn.codeChanged && turn.verified,
    okChecks: turn.okChecks,
    planDone: plan.filter(s => s.status === 'completed').length,
    planTotal: plan.length,
  };
}

// The biggest installed local model that can use tools, if it's bigger than the current one.
async function biggerLocalModel(current) {
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const models = (await res.json()).models || [];
    const size = m => parseFloat(m?.details?.parameter_size) || 0;
    const mine = size(models.find(m => m.name === current));
    const best = models
      .filter(m => m.name !== current && (m.capabilities || []).includes('tools') && size(m) > mine * 1.5 && size(m) <= 40)
      .sort((a, b) => size(b) - size(a))[0];
    return best ? `${best.name} (${best.details.parameter_size})` : null;
  } catch {
    return null;
  }
}
