// Screenshots of what an AI built (web pages, images, program windows), so any model can
// check its work. Web pages render off-screen and also report their JavaScript errors;
// programs are started for a few seconds, their window is captured, then they're closed.
import { BrowserWindow, nativeImage } from 'electron';
import { spawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools');
export const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp)$/i;
const PAGE_EXT = /\.(html?|svg)$/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A plain color name from hue and brightness ("dark blue", "light gray", "orange").
function colorName(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  if (l < 0.07) return 'black';
  if (l > 0.94) return 'white';
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  const shade = l < 0.3 ? 'dark ' : l > 0.72 ? 'light ' : '';
  if (s < 0.15) return `${shade}gray`;
  let h;
  const [R, G, B] = [r / 255, g / 255, b / 255];
  if (max === R) h = 60 * (((G - B) / (max - min)) % 6);
  else if (max === G) h = 60 * ((B - R) / (max - min) + 2);
  else h = 60 * ((R - G) / (max - min) + 4);
  if (h < 0) h += 360;
  const hue = h < 15 || h >= 345 ? 'red' : h < 40 ? (l < 0.35 ? 'brown' : 'orange') : h < 65 ? 'yellow' : h < 160 ? 'green'
    : h < 195 ? 'cyan' : h < 255 ? 'blue' : h < 290 ? 'purple' : 'pink';
  return hue === 'brown' ? 'brown' : `${shade}${hue}`;
}

// Facts measured from the pixels, which small vision models often get wrong: main colors and their share.
export function colorSummary(img) {
  const { width, height } = img.getSize();
  if (!width || !height) return '';
  const bmp = img.toBitmap();   // BGRA on Windows
  const counts = new Map();
  let total = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 20000)));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const name = colorName(bmp[i + 2], bmp[i + 1], bmp[i]);
      counts.set(name, (counts.get(name) || 0) + 1);
      total++;
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).filter(([, c]) => c / total >= 0.005).slice(0, 6)
    .map(([name, c]) => `${name} ${Math.max(1, Math.round((c / total) * 100))}%`).join(', ');
}

// Almost a single color = probably nothing was drawn.
function looksBlank(img) {
  const { width, height } = img.getSize();
  if (!width || !height) return true;
  const bmp = img.toBitmap();
  const colors = new Set();
  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 40))) {
    for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 40))) {
      const i = (y * width + x) * 4;
      colors.add(`${bmp[i] >> 4},${bmp[i + 1] >> 4},${bmp[i + 2] >> 4}`);
      if (colors.size > 3) return false;
    }
  }
  return true;
}

async function capturePage(target, out, waitMs, width, height) {
  const win = new BrowserWindow({
    show: false, width, height, useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const errors = [];
  win.webContents.on('console-message', e => {
    if (e.level === 'error') errors.push(`${e.message}${e.lineNumber ? ` (${path.basename(e.sourceId || '')}:${e.lineNumber})` : ''}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`Page failed to load: ${desc} (${code})`));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    const load = /^https?:\/\//i.test(target) ? win.loadURL(target) : win.loadFile(target);
    await Promise.race([load.catch(() => {}), sleep(10000)]);
    await sleep(waitMs);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    return { image: out, errors: errors.slice(0, 10), blank: looksBlank(img), colors: colorSummary(img), size: img.getSize() };
  } finally {
    win.destroy();
  }
}

function captureProgram(exe, out, waitMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    let exited = false;
    proc.on('exit', () => { exited = true; });
    proc.on('error', err => reject(new Error(`Couldn't start ${path.basename(exe)}: ${err.message}`)));
    setTimeout(() => {
      if (exited) return reject(new Error(`${path.basename(exe)} closed by itself within ${waitMs / 1000}s, so there was no window to capture.`));
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS_DIR, 'capture-window.ps1'), '-ProcessId', String(proc.pid), '-Out', out],
        { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
          // close it right away (and anything it started), before anything else can exit
          try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
          try { proc.kill(); } catch {}
          if (err || !fs.existsSync(out)) return reject(new Error(`Couldn't capture the window: ${(stderr || err?.message || '').trim().split('\n')[0]}`));
          const img = nativeImage.createFromPath(out);
          resolve({ image: out, errors: [], blank: looksBlank(img), colors: colorSummary(img), size: img.getSize() });
        });
    }, waitMs);
  });
}

// target: absolute file path or http(s) URL
export async function capture(target, outDir, { waitMs, width = 1280, height = 800 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `preview-${Date.now()}.png`);
  const isUrl = /^https?:\/\//i.test(target);
  if (!isUrl && !fs.existsSync(target)) throw new Error(`${path.basename(target)} doesn't exist yet.`);
  if (isUrl || PAGE_EXT.test(target)) return capturePage(target, out, waitMs ?? 1500, width, height);
  if (/\.(png|jpe?g)$/i.test(target)) {
    const img = nativeImage.createFromPath(target);
    return { image: target, errors: [], blank: looksBlank(img), colors: colorSummary(img), size: img.getSize() };
  }
  if (IMAGE_EXT.test(target)) return capturePage(target, out, 300, width, height);
  if (/\.exe$/i.test(target)) return captureProgram(target, out, waitMs ?? 3000);
  throw new Error('Previews work for web pages (.html), images and programs (.exe).');
}
