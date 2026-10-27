// Account sign-in for the subscription engines, shown in Hatch's own window.
//   Claude  -> official `claude auth login` (Claude Pro/Max)
//   ChatGPT -> official `codex login` (ChatGPT Plus/Pro)
// Each CLI prints its sign-in link; we open it in a window of our own. Claude hands back a
// code on its callback page (we pass it to the CLI); Codex finishes on its own localhost callback.
import { app, BrowserWindow, shell } from 'electron';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import { CLAUDE_EXE, CODEX_EXE, ICON, cleanEnv } from './config.mjs';

const FLOWS = {
  sub: {
    exe: CLAUDE_EXE,
    args: ['auth', 'login', '--claudeai'],
    urlRe: /https:\/\/\S+\/oauth\/authorize\?\S+/,
    env: () => ({ ...cleanEnv(), BROWSER: 'hatch-in-app-browser' }),   // no such program: the CLI prints the link instead
    codeFromUrl(u) {
      if (!u.pathname.startsWith('/oauth/code/callback')) return null;
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      return code && state ? `${code}#${state}\n` : null;
    },
  },
  chatgpt: {
    exe: CODEX_EXE,
    args: ['login'],
    urlRe: /https:\/\/\S+\/oauth\/authorize\?\S+/,
    env: () => ({ ...cleanEnv(), BROWSER: 'hatch-in-app-browser' }),
    codeFromUrl: () => null,
  },
};

let active = null;   // { provider, proc, win, url, cancelled }

export function status(provider) {
  return new Promise(resolve => {
    if (provider === 'sub') {
      if (!fs.existsSync(CLAUDE_EXE)) return resolve({ signedIn: false, missing: 'Claude Code is not installed' });
      execFile(CLAUDE_EXE, ['auth', 'status'], { windowsHide: true, timeout: 20000, env: cleanEnv() }, (_e, out) => {
        try {
          const s = JSON.parse(out);
          resolve({ signedIn: !!s.loggedIn, plan: s.subscriptionType || null });
        } catch { resolve({ signedIn: false }); }
      });
    } else if (provider === 'chatgpt') {
      execFile(CODEX_EXE, ['login', 'status'], { windowsHide: true, timeout: 20000, env: cleanEnv() }, (err, out, errOut) => {
        const text = `${out}\n${errOut}`;
        resolve({ signedIn: !err && /logged in/i.test(text) && /chatgpt/i.test(text), detail: text.trim() });
      });
    } else resolve({ signedIn: false });
  });
}

export function signOut(provider) {
  const [exe, args] = provider === 'sub' ? [CLAUDE_EXE, ['auth', 'logout']] : [CODEX_EXE, ['logout']];
  return new Promise(resolve => execFile(exe, args, { windowsHide: true, timeout: 20000, env: cleanEnv() }, () => resolve()));
}

// Moves the sign-in to the user's normal browser; the CLI keeps waiting for it.
export function openInBrowser() {
  if (!active?.url) return;
  active.external = true;
  shell.openExternal(active.url);
  if (active.win && !active.win.isDestroyed()) active.win.close();
}

export function cancel() {
  if (!active) return;
  active.cancelled = true;
  active.proc.kill();
}

// onDone({ provider, ok, message })
export function signIn(provider, parent, onDone) {
  if (active) { active.win?.focus(); return; }
  const flow = FLOWS[provider];
  if (!flow || !fs.existsSync(flow.exe)) {
    onDone({ provider, ok: false, message: 'This sign-in is not available on this PC.' });
    return;
  }
  const proc = spawn(flow.exe, flow.args, { env: flow.env(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const cur = active = { provider, proc, win: null, url: null, cancelled: false };

  let out = '';
  const onData = d => {
    out += d;
    const m = !cur.win && out.match(flow.urlRe);
    if (m) {
      cur.url = m[0];
      cur.win = openWindow(cur, flow, parent);
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', code => {
    active = null;
    if (cur.win && !cur.win.isDestroyed()) cur.win.close();
    const ok = code === 0;
    const message = ok ? '' : cur.cancelled ? 'Sign-in was cancelled.'
      : out.split('\n').map(s => s.trim()).filter(s => s && !/^https?:/.test(s) && !/paste code|browser/i.test(s)).slice(-2).join(' ') || 'Sign-in failed.';
    onDone({ provider, ok, message });
  });
}

function openWindow(cur, flow, parent) {
  const w = new BrowserWindow({
    parent,
    width: 520,
    height: 780,
    title: cur.provider === 'sub' ? 'Sign in to Claude' : 'Sign in to ChatGPT',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { partition: 'persist:hatch-signin', sandbox: true, contextIsolation: true },
  });
  w.setMenu(null);
  // a plain Chrome user agent, so sign-in pages treat it like a normal browser
  w.webContents.setUserAgent(app.userAgentFallback.replace(/\s(Electron|hatch)\/\S+/gi, ''));

  let sent = false;
  const check = target => {
    if (sent) return;
    let u;
    try { u = new URL(target); } catch { return; }
    const code = flow.codeFromUrl(u);
    if (code) { sent = true; cur.proc.stdin.write(code); }
  };
  w.webContents.on('will-redirect', (_e, u) => check(u));
  w.webContents.on('will-navigate', (_e, u) => check(u));
  w.webContents.on('did-navigate', (_e, u) => check(u));
  w.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { parent: w, autoHideMenuBar: true, webPreferences: { partition: 'persist:hatch-signin' } },
  }));
  w.on('closed', () => {
    if (active === cur && !cur.external) { cur.cancelled = true; cur.proc.kill(); }
  });
  w.loadURL(cur.url);
  return w;
}
