// Local model manager: which Ollama models are installed, how well each fits this PC's graphics card,
// and downloading or deleting them.
import { execFile } from 'node:child_process';
import { settings } from './config.mjs';

// Good picks for building things in Hatch, with their approximate download size (GB).
export const RECOMMENDED = [
  { name: 'qwen2.5-coder:14b', size: 9.0, what: 'Strong at code, uses tools. The best coder that fits a 12 GB card.' },
  { name: 'qwen3:14b', size: 9.3, what: 'Good all-rounder that can think before it acts. Uses tools.' },
  { name: 'gpt-oss:20b', size: 14, what: 'OpenAI\'s open model. Smart, thinks, uses tools. Needs 16 GB to run fully on the card.' },
  { name: 'devstral:24b', size: 14, what: 'Mistral\'s model made for coding agents. Needs 16 GB to run fully on the card.' },
  { name: 'qwen3:8b', size: 5.2, what: 'Small and quick. Fine for simple tasks and as a team helper.' },
  { name: 'qwen2.5-coder:7b', size: 4.7, what: 'Small and fast coder. Weak at bigger programs.' },
  { name: 'gemma3:12b', size: 8.1, what: 'Can see images: describes screenshots well (Hatch\'s preview tool).' },
  { name: 'moondream', size: 1.7, what: 'Tiny model that sees images. Rough, but very light.' },
];

let gpuInfo;   // undefined = not checked yet, null = no NVIDIA card found

// The graphics card and its memory in GB (NVIDIA only).
export function gpu() {
  if (gpuInfo !== undefined) return Promise.resolve(gpuInfo);
  return new Promise(resolve => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 8000 }, (err, out) => {
      const [name, mb] = (out || '').split('\n')[0].split(',').map(s => s?.trim());
      gpuInfo = !err && Number(mb) ? { name, vram: Number(mb) / 1024 } : null;
      resolve(gpuInfo);
    });
  });
}

// 'fast': fits on the card with room for its working memory; 'slower': partly runs on the CPU; 'slow': mostly CPU.
export function fit(sizeGB, card) {
  if (!card) return null;
  if (sizeGB + 1.5 <= card.vram) return 'fast';
  return sizeGB <= card.vram * 1.8 ? 'slower' : 'slow';
}

export async function list() {
  const card = await gpu();
  let models = [];
  let ok = true;
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    models = (await res.json()).models || [];
  } catch {
    ok = false;
  }
  const installed = models.map(m => {
    const size = (m.size || 0) / 1e9;
    return {
      name: m.name, size, params: m.details?.parameter_size || '', quant: m.details?.quantization_level || '',
      caps: m.capabilities || [], fit: fit(size, card),
    };
  }).sort((a, b) => b.size - a.size);
  const have = new Set(installed.map(m => m.name.replace(/:latest$/, '')));
  return {
    ok, gpu: card, installed,
    recommended: RECOMMENDED.map(r => ({ ...r, installed: have.has(r.name.replace(/:latest$/, '')), fit: fit(r.size, card) })),
  };
}

const pulls = new Map();   // model name -> AbortController

// Downloads a model, reporting { status, pct } as it goes.
export async function pull(name, onProgress) {
  if (pulls.has(name)) throw new Error(`${name} is already downloading.`);
  const abort = new AbortController();
  pulls.set(name, abort);
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/pull`, { method: 'POST', body: JSON.stringify({ model: name, stream: true }), signal: abort.signal });
    if (!res.ok) throw new Error((await res.text()).replace(/^\{"error":"|"\}$/g, '') || `Ollama said ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let p;
        try { p = JSON.parse(line); } catch { continue; }
        if (p.error) throw new Error(p.error);
        const pct = p.total ? Math.floor((p.completed || 0) / p.total * 100) : null;
        if (Date.now() - last > 250 || p.status === 'success') {
          last = Date.now();
          onProgress({ status: p.status, pct, total: p.total || 0 });
        }
      }
    }
  } catch (err) {
    if (abort.signal.aborted) throw new Error('Download canceled.');
    if (/fetch failed/i.test(err.message)) throw new Error(`Can't reach Ollama at ${settings.ollamaUrl}. Is it running?`);
    throw err;
  } finally {
    pulls.delete(name);
  }
}

export const cancelPull = name => pulls.get(name)?.abort();

export async function remove(name) {
  const res = await fetch(`${settings.ollamaUrl}/api/delete`, { method: 'DELETE', body: JSON.stringify({ model: name }) });
  if (!res.ok) throw new Error((await res.text()).replace(/^\{"error":"|"\}$/g, '') || `Ollama said ${res.status}`);
}
