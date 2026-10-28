// Phone access: a small web server inside Hatch that serves a phone-sized version of the app to the
// phone's browser, over the home network (or Tailscale, which works from anywhere). It's off until the
// user turns it on, and every request for data or actions needs the pairing key from the QR code.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { APP_DIR, DATA_DIR, settings, saveSettings, getKey, setKey } from './config.mjs';

const WEB = path.join(APP_DIR, 'remote');
const MODULES = path.join(APP_DIR, 'node_modules');
const PREVIEWS = path.join(DATA_DIR, 'previews');
const FILES = {
  '/': [path.join(WEB, 'index.html'), 'text/html; charset=utf-8'],
  '/app.js': [path.join(WEB, 'app.js'), 'text/javascript; charset=utf-8'],
  '/style.css': [path.join(WEB, 'style.css'), 'text/css; charset=utf-8'],
  '/manifest.webmanifest': [path.join(WEB, 'manifest.webmanifest'), 'application/manifest+json'],
  '/logo.svg': [path.join(APP_DIR, 'assets', 'logo.svg'), 'image/svg+xml'],
  '/icon.png': [path.join(APP_DIR, 'assets', 'logo-256.png'), 'image/png'],
  '/vendor/marked.js': [path.join(MODULES, 'marked', 'lib', 'marked.umd.js'), 'text/javascript; charset=utf-8'],
  '/vendor/purify.js': [path.join(MODULES, 'dompurify', 'dist', 'purify.min.js'), 'text/javascript; charset=utf-8'],
};
const MAX_BODY = 1 << 20;
const MAX_FAILS = 10;               // wrong keys from one address before it's shut out for a while
const SHUT_OUT = 10 * 60e3;

let server = null;
let api = null;                     // what the phone can do, given by main.mjs
let lastError = '';
const clients = new Set();          // phones listening for live updates
const fails = new Map();            // address -> { count, until }
let onChange = () => {};

const config = () => ({ enabled: false, port: 7820, ...(settings.remote || {}) });

// ---------- the pairing key ----------

function key() {
  let k = getKey('remote');
  if (!k) {
    k = crypto.randomBytes(24).toString('base64url');
    setKey('remote', k);
  }
  return k;
}

// A new key: every paired phone is disconnected and has to scan the new QR code.
export function resetKey() {
  setKey('remote', crypto.randomBytes(24).toString('base64url'));
  for (const c of clients) c.end();
  clients.clear();
  onChange();
}

function keyOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(key());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- addresses the phone can use ----------

// IPv4 addresses of this PC; Tailscale's (100.64.0.0/10) work from anywhere.
function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      const tailscale = x === 100 && y >= 64 && y <= 127;
      // virtual machines' adapters (VirtualBox, Hyper-V/WSL, VMware, Docker) and link-local addresses can't reach a phone
      const virtual = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|vbox|docker/i.test(name)
        || /^(0a:00:27|08:00:27|00:15:5d|00:50:56|00:0c:29|00:05:69|02:42)/i.test(a.mac) || (x === 169 && y === 254);
      if (!tailscale && virtual) continue;
      out.push({ kind: tailscale ? 'tailscale' : 'home', name, address: a.address });
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'home' ? -1 : 1));
}

export async function status() {
  const c = config();
  const urls = server ? await Promise.all(addresses().map(async a => {
    const url = `http://${a.address}:${c.port}/#key=${key()}`;
    return { ...a, url, qr: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  })) : [];
  return { enabled: c.enabled, running: !!server, port: c.port, phones: clients.size, urls, error: lastError };
}

// ---------- the server ----------

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body ?? null));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('too big')); req.destroy(); return; }
      parts.push(d);
    });
    req.on('end', () => {
      try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (err) { reject(err); }
    });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://phone');
  const who = req.socket.remoteAddress || '';

  // the app's own files need no key: the key stays in the page's address (#key=...) and never comes here
  const file = req.method === 'GET' && FILES[url.pathname];
  if (file) {
    fs.readFile(file[0], (err, data) => {
      if (err) return json(res, 404, { error: 'missing' });
      res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

  const f = fails.get(who);
  if (f && f.until > Date.now()) return json(res, 429, { error: 'Too many wrong keys. Try again later.' });
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key');
  if (!keyOk(given)) {
    const now = Date.now();
    const prev = f && now - f.since < SHUT_OUT ? f : { count: 0, since: now };
    const n = prev.count + 1;
    fails.set(who, { count: n, since: prev.since, until: n >= MAX_FAILS ? now + SHUT_OUT : 0 });
    return json(res, 401, { error: 'This phone isn\'t paired with Hatch. Scan the QR code in Hatch: Settings > Phone.' });
  }
  fails.delete(who);

  try {
    // live updates (server-sent events)
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      onChange();
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); onChange(); });
      return;
    }
    // screenshots the AIs took (only from Hatch's own previews folder)
    if (url.pathname === '/api/image') {
      const p = path.resolve(url.searchParams.get('path') || '');
      if (!p.startsWith(PREVIEWS + path.sep) || !/\.(png|jpe?g)$/i.test(p)) return json(res, 403, { error: 'not allowed' });
      return fs.readFile(p, (err, data) => {
        if (err) return json(res, 404, { error: 'missing' });
        res.writeHead(200, { 'content-type': /\.png$/i.test(p) ? 'image/png' : 'image/jpeg', 'cache-control': 'private, max-age=3600' });
        res.end(data);
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await api.state());
    if (req.method === 'GET' && url.pathname === '/api/chat') return json(res, 200, await api.chat(url.searchParams.get('id')));
    const action = req.method === 'POST' && api.actions[url.pathname.slice(5)];
    if (action) return json(res, 200, (await action(await readBody(req))) ?? { ok: true });
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: String(err?.message || err) });
  }
}

function startServer() {
  const c = config();
  lastError = '';
  server = http.createServer((req, res) => { handle(req, res).catch(err => json(res, 500, { error: String(err?.message || err) })); });
  server.on('error', err => {
    lastError = err.code === 'EADDRINUSE' ? `Port ${c.port} is in use by another program. Pick another port.` : err.message;
    server = null;
    onChange();
  });
  // HATCH_PHONE_HOST=127.0.0.1 keeps it on this PC only (for testing)
  server.listen(c.port, process.env.HATCH_PHONE_HOST || '0.0.0.0', () => onChange());
}

function stopServer() {
  for (const c of clients) c.end();
  clients.clear();
  server?.close();
  server = null;
}

// handlers: { state(), chat(id), actions: { name: async body => result } }
export function init(handlers, changed) {
  api = handlers;
  onChange = changed;
  if (config().enabled) startServer();
}

export function configure({ enabled, port }) {
  const c = config();
  const next = { enabled: enabled ?? c.enabled, port: Math.min(65535, Math.max(1024, Number(port) || c.port)) };
  settings.remote = next;
  saveSettings();
  if (server && (!next.enabled || next.port !== c.port)) stopServer();
  if (next.enabled && !server) startServer();
  onChange();
}

// Live updates for every connected phone.
export function broadcast(channel, payload) {
  if (!clients.size) return;
  const data = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) c.write(data);
}
