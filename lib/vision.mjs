// Lets models without vision "see" a screenshot: a local vision model describes it in words.
import fs from 'node:fs';
import { settings } from './config.mjs';

const capsCache = new Map();

// What an Ollama model can do: 'vision', 'tools', 'thinking', ...
export async function modelCaps(model) {
  if (!capsCache.has(model)) {
    let caps = [];
    try {
      const res = await fetch(`${settings.ollamaUrl}/api/show`, { method: 'POST', body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) });
      caps = (await res.json()).capabilities || [];
    } catch {}
    capsCache.set(model, caps);
  }
  return capsCache.get(model);
}

export async function modelHasVision(model) {
  return (await modelCaps(model)).includes('vision');
}

export async function visionModel() {
  if (settings.visionModel) return settings.visionModel;
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    return ((await res.json()).models || []).find(m => (m.capabilities || []).includes('vision'))?.name || null;
  } catch {
    return null;
  }
}

export function imageBase64(file) {
  return fs.readFileSync(file).toString('base64');
}

async function ask(model, prompt, image, signal) {
  const res = await fetch(`${settings.ollamaUrl}/api/chat`, {
    method: 'POST',
    signal,
    body: JSON.stringify({
      model, stream: false, keep_alive: '10m', options: { num_ctx: 4096, temperature: 0.2 },
      messages: [{ role: 'user', content: prompt, images: [image] }],
    }),
  });
  if (!res.ok) throw new Error(`Vision model: ${await res.text()}`);
  return ((await res.json()).message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// { model, text } or null when no vision model is installed.
// Small vision models (like moondream) only answer short, plain questions.
export async function describe(imagePath, { expect = '', signal } = {}) {
  const model = await visionModel();
  if (!model) return null;
  const image = imageBase64(imagePath);
  let text = await ask(model, 'Describe this image in detail. What text and shapes are visible, and where?', image, signal);
  if (!text) text = await ask(model, 'Describe this image.', image, signal);
  if (expect) {
    const check = await ask(model, `Does this image show ${expect}? Answer yes or no, then explain briefly.`, image, signal);
    if (check) text += `\nAsked whether it shows "${expect}": ${check}`;
  }
  return { model, text: text || '(the vision model gave no answer)' };
}
