// Optional libraries Hatch can install for building games. Right now: raylib, an easy
// 3D/2D game library, downloaded from its official GitHub releases (Visual C++ build).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

export const LIBS_DIR = path.join(DATA_DIR, 'libs');
const RAYLIB_DIR = path.join(LIBS_DIR, 'raylib');

const fwd = p => p.replace(/\\/g, '/');

export function raylib() {
  const inc = path.join(RAYLIB_DIR, 'include');
  const lib = path.join(RAYLIB_DIR, 'lib', 'raylib.lib');
  if (!fs.existsSync(path.join(inc, 'raylib.h')) || !fs.existsSync(lib)) return null;
  let version = '';
  try { version = fs.readFileSync(path.join(RAYLIB_DIR, 'VERSION'), 'utf8').trim(); } catch {}
  return { version, include: fwd(inc), lib: fwd(lib) };
}

// Extra cl options for a program that uses raylib.
export function raylibBuildFlags() {
  const r = raylib();
  if (!r) return null;
  return { compile: `-MD -I"${r.include}"`, link: `"${r.lib}" opengl32.lib gdi32.lib winmm.lib user32.lib shell32.lib`, entry: '-entry:mainCRTStartup' };
}

const run = (exe, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(exe, args, { windowsHide: true, timeout: 120000, ...opts }, (err, out, errOut) => (err ? reject(new Error((errOut || err.message).trim())) : resolve(out)));
});

export async function installRaylib(onProgress = () => {}) {
  onProgress('Finding the latest raylib release…');
  const rel = await (await fetch('https://api.github.com/repos/raysan5/raylib/releases/latest', { headers: { 'User-Agent': 'Hatch' } })).json();
  const asset = (rel.assets || []).find(a => /win64_msvc\d+\.zip$/i.test(a.name));
  if (!asset) throw new Error("Couldn't find a Visual C++ build in raylib's latest release.");

  onProgress(`Downloading ${asset.name} (${Math.round(asset.size / 1024)} KB)…`);
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'Hatch' } });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-raylib-'));
  const zip = path.join(tmp, asset.name);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

  onProgress('Unpacking…');
  const out = path.join(tmp, 'x');
  fs.mkdirSync(out);
  await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', out]);
  // the zip holds one top folder (raylib-x.y_win64_msvc16) with include/ and lib/
  const top = fs.readdirSync(out).map(n => path.join(out, n)).find(p => fs.existsSync(path.join(p, 'include', 'raylib.h'))) || out;
  if (!fs.existsSync(path.join(top, 'lib', 'raylib.lib'))) throw new Error('The download looks incomplete (no raylib.lib).');

  fs.rmSync(RAYLIB_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIBS_DIR, { recursive: true });
  fs.cpSync(top, RAYLIB_DIR, { recursive: true });
  fs.writeFileSync(path.join(RAYLIB_DIR, 'VERSION'), rel.tag_name || '');
  fs.rmSync(tmp, { recursive: true, force: true });
  onProgress('');
  return raylib();
}
