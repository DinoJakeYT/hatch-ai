// Shared instructions + long-term memory given to every AI, and compressing them with a local model.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, APP_DIR, settings } from './config.mjs';
import * as skills from './skills.mjs';
import * as toolchain from './toolchain.mjs';

export const FILES = {
  instructions: path.join(DATA_DIR, 'instructions.md'),
  memory: path.join(DATA_DIR, 'memory.md'),
};
export const MEMORY_DIR = DATA_DIR;

const DEFAULTS = {
  instructions: `# Hatch instructions
These are given to every AI in Hatch: Claude, ChatGPT, Gemini, OpenRouter and local models.

- Be friendly and explain what you're doing in simple words.
- Build things inside this chat's project folder.
- When you finish building something, say how to open or run it.
`,
  memory: `# Memory
Facts worth remembering between chats, one short line each.
`,
};

for (const [k, f] of Object.entries(FILES)) {
  if (!fs.existsSync(f)) fs.writeFileSync(f, DEFAULTS[k]);
}

export function readFile(kind) {
  try { return fs.readFileSync(FILES[kind], 'utf8'); } catch { return ''; }
}

export function writeFile(kind, text) {
  fs.writeFileSync(FILES[kind], text);
}

export function appendMemory(fact) {
  const line = fact.replace(/\s+/g, ' ').trim();
  if (!line) return;
  const cur = readFile('memory');
  fs.writeFileSync(FILES.memory, `${cur}${cur.endsWith('\n') || !cur ? '' : '\n'}- ${line}\n`);
}

const APP_NOTE = [
  'You are running inside Hatch, a desktop chat app that shows your replies as chat bubbles',
  'and your tool use (files you create or edit, commands you run) as cards in the conversation.',
  "The working directory is this chat's own project folder: build things there.",
].join(' ');

// The text added to the system prompt / developer instructions for one turn.
// engine: 'claude' | 'codex' | 'gemini' | 'local' (Hatch's own tools for local models)
export function buildInstructions({ local = false, engine = 'claude' } = {}) {
  const instructions = readFile('instructions').trim();
  const memory = readFile('memory').trim();
  const limit = local ? Math.min(settings.memory.inlineLimit, 3000) : settings.memory.inlineLimit;
  const memoryLines = [
    `Long-term memory file: ${FILES.memory}`,
    'It holds facts about the user and their projects from earlier chats.',
    memory.length <= limit
      ? `Its current contents:\n<memory>\n${memory}\n</memory>`
      : 'It is too long to include here: read it with your file tools whenever earlier chats, preferences or past projects might matter.',
    'When you learn something worth keeping (a preference, an ongoing project, a decision), append one short bullet line to that file.',
    'Never store passwords, keys or other secrets in it.',
  ];
  if (local) memoryLines.push('If you are unsure what the user means, read the memory file first.');
  // Hatch's own local agent has <preview>, <template> and <skill> tags; the other engines get the same abilities as notes
  const previewNote = engine === 'local' ? '' : [
    toolchain.leadSummary(),
    '',
    'To see what something you built looks like (a web page, an image, or a program window), run:',
    `"${process.execPath}" "${path.join(APP_DIR, 'tools', 'preview.mjs')}" <file or http URL>`,
    'It saves a screenshot, prints its path and any page errors. Then open that PNG with your image or file viewing tool, check it looks right, and fix what doesn\'t. Hatch shows the screenshot to the user too.',
    `Starter C++ game projects that already build (2D Win32, 3D OpenGL, 3D raylib) are in ${path.join(APP_DIR, 'templates')} if one would help.`,
  ].join('\n');
  // Claude loads skills natively (as a plugin); Codex and Gemini get the list and read SKILL.md themselves
  const list = engine === 'codex' || engine === 'gemini' ? skills.catalog() : [];
  const skillNote = list.length ? [
    'Skills you can use. When one fits the task, read its SKILL.md first and follow it:',
    ...list.map(s => `- ${s.name}: ${s.description} (${s.path})`),
  ].join('\n') : '';
  return [APP_NOTE, instructions && `User instructions:\n${instructions}`, memoryLines.join('\n'), previewNote, skillNote].filter(Boolean).join('\n\n');
}

// ---------- compression with a local Ollama model ----------

const COMPRESS_PROMPT = {
  memory: 'You compress a long-term memory file for an AI assistant. Rewrite it much shorter: merge duplicates, drop stale or trivial lines, keep every distinct useful fact, keep the "# Memory" heading, one short bullet per fact. Output only the new file.',
  instructions: 'You compress an instructions file for an AI assistant. Rewrite it shorter and clearer without dropping any rule or preference. Keep Markdown. Output only the new file.',
};

export async function compress(kind, model) {
  const text = readFile(kind);
  const res = await fetch(`${settings.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      options: { num_ctx: 16384, temperature: 0.2 },
      messages: [{ role: 'system', content: COMPRESS_PROMPT[kind] }, { role: 'user', content: text }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama: ${res.status} ${await res.text()}`);
  const out = ((await res.json()).message?.content || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/m, '$1')
    .trim();
  if (!out) throw new Error('The local model returned nothing.');
  return { before: text.length, after: out.length, text: out + '\n' };
}

// Keeps one backup next to the file, then saves.
export function saveWithBackup(kind, text) {
  fs.copyFileSync(FILES[kind], FILES[kind].replace(/\.md$/, '.backup.md'));
  writeFile(kind, text);
}

export async function autoCompressMemory() {
  const m = settings.memory;
  if (!m.autoCompress || !m.compressModel || readFile('memory').length < m.compressAt) return null;
  const r = await compress('memory', m.compressModel);
  if (r.after < r.before) saveWithBackup('memory', r.text);
  return r;
}
