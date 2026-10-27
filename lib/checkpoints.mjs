// Undo: before every message Hatch saves the chat's project folder in a hidden git history of its
// own (never the project's own .git), so one click can put every file back the way it was.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const ROOT = path.join(DATA_DIR, 'checkpoints');
const EXCLUDE = ['.git/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '.vs/',
  '*.obj', '*.pdb', '*.ilk', '*.exp', '*.idb', '*.iobj', '*.ipdb', '*.pch', '*.tmp'];
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.vs']);
const MAX_FILES = 20000;          // a folder bigger than this gets no undo (saving it would be slow)
const MAX_FILE_SIZE = 50 << 20;   // files over 50 MB are left out

const gitDir = chatId => path.join(ROOT, `${chatId}.git`);

function git(chatId, cwd, args) {
  return new Promise(resolve => {
    execFile('git', ['--git-dir', gitDir(chatId), '--work-tree', cwd,
      '-c', 'user.name=Hatch', '-c', 'user.email=hatch@localhost', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args],
    { cwd, windowsHide: true, timeout: 120000, maxBuffer: 1 << 26 }, (err, out, errOut) => {
      resolve({ ok: !err, out: (out || '').trim(), err: (errOut || err?.message || '').trim() });
    });
  });
}

// The project's files, or null when there are too many; big files are listed to leave out.
function scan(cwd) {
  const big = [];
  let count = 0;
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !walk(abs)) return false;
      } else if (++count > MAX_FILES) {
        return false;
      } else {
        try { if (fs.statSync(abs).size > MAX_FILE_SIZE) big.push(`/${path.relative(cwd, abs).replace(/\\/g, '/')}`); } catch {}
      }
    }
    return true;
  };
  return walk(cwd) ? { big } : null;
}

// Saves the folder as it is now. Returns the checkpoint id, or null when undo isn't possible here.
export async function save(chatId, cwd, label) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const files = scan(cwd);
  if (!files) return null;
  if (!fs.existsSync(gitDir(chatId))) {
    fs.mkdirSync(ROOT, { recursive: true });
    if (!(await git(chatId, cwd, ['init', '-q'])).ok) return null;
  }
  fs.mkdirSync(path.join(gitDir(chatId), 'info'), { recursive: true });
  fs.writeFileSync(path.join(gitDir(chatId), 'info', 'exclude'), [...EXCLUDE, ...files.big].join('\n') + '\n');
  await git(chatId, cwd, ['add', '-A']);
  const c = await git(chatId, cwd, ['commit', '-q', '--allow-empty', '--no-verify', '-m', label.slice(0, 200)]);
  if (!c.ok) return null;
  return (await git(chatId, cwd, ['rev-parse', 'HEAD'])).out || null;
}

// Puts the folder back to a checkpoint. Saves the current state first, so it can be brought back (redo).
export async function restore(chatId, cwd, id) {
  const now = await save(chatId, cwd, 'Before undo');
  if (!now) throw new Error('Hatch couldn\'t save the current files first, so it didn\'t change anything.');
  // files made after the checkpoint go away (they're kept in the saved state above)
  const added = await git(chatId, cwd, ['diff', '--name-only', '--no-renames', '--diff-filter=A', id, now]);
  if (!added.ok) throw new Error(`Undo failed: ${added.err}`);
  const locked = [];
  for (const rel of added.out.split('\n').filter(Boolean)) {
    const abs = path.join(cwd, rel);
    try { fs.rmSync(abs, { force: true }); } catch { locked.push(rel); continue; }
    // and the folders they leave empty
    for (let dir = path.dirname(abs); dir.startsWith(cwd) && dir !== cwd; dir = path.dirname(dir)) {
      try { if (fs.readdirSync(dir).length) break; fs.rmdirSync(dir); } catch { break; }
    }
  }
  const back = await git(chatId, cwd, ['checkout', id, '--', '.']);
  if (!back.ok && !/did not match any/i.test(back.err)) locked.push(back.err.split('\n')[0]);   // (an empty checkpoint has nothing to bring back)
  await save(chatId, cwd, 'Undo');
  return { redo: now, problems: locked };
}

// Removes a chat's saved versions. Git marks its stored files read-only, which Windows won't delete as they are.
export function forget(chatId) {
  const dir = gitDir(chatId);
  if (!fs.existsSync(dir)) return;
  const writable = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) writable(p);
      else fs.chmodSync(p, 0o666);
    }
  };
  try {
    writable(dir);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    console.error('[checkpoints] could not remove', dir, err.message);
  }
}
