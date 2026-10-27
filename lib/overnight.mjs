// Overnight work: a local model keeps working on a goal for hours with nobody watching.
// It runs in sessions (plan, build, test, fix, improve), keeps a PROGRESS.md notebook in the
// project, saves a git checkpoint after every working build, and in the morning makes sure the
// project is at its last working version and writes a report.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { settings } from './config.mjs';

const MAX_IDLE_SESSIONS = 3;       // sessions in a row with no real progress before giving up early
const MAX_OLLAMA_FAILURES = 5;     // connection problems in a row before giving up
const RETRY_WAIT = 60000;

const GIT_ID = ['-c', 'user.name=Hatch overnight', '-c', 'user.email=hatch@localhost'];
const GITIGNORE = '# build output (Hatch)\n*.obj\n*.pdb\n*.ilk\n*.exp\n*.lib\n*.idb\n__pycache__/\nnode_modules/\n';

const sleep = (ms, signal) => new Promise(resolve => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); });
});

function git(cwd, args) {
  return new Promise(resolve => {
    execFile('git', [...GIT_ID, ...args], { cwd, windowsHide: true, timeout: 60000, maxBuffer: 1 << 24 }, (err, out, errOut) => {
      resolve({ ok: !err, out: (out || '').trim(), err: (errOut || err?.message || '').trim() });
    });
  });
}

// ---------- checkpoints ----------

async function ensureRepo(cwd) {
  if (fs.existsSync(path.join(cwd, '.git'))) return true;
  const init = await git(cwd, ['init', '-q']);
  if (!init.ok) return false;
  if (!fs.existsSync(path.join(cwd, '.gitignore'))) fs.writeFileSync(path.join(cwd, '.gitignore'), GITIGNORE);
  return true;
}

async function checkpoint(cwd, message) {
  await git(cwd, ['add', '-A']);
  const c = await git(cwd, ['commit', '-q', '-m', message]);
  if (!c.ok && !/nothing to commit/i.test(c.out + c.err)) return null;
  return (await git(cwd, ['rev-parse', '--short', 'HEAD'])).out || null;
}

// Puts the project back at the last working checkpoint; the unfinished work is kept in git's stash.
async function restoreLastGood(cwd) {
  await git(cwd, ['add', '-A']);
  const stash = await git(cwd, ['stash', 'push', '-u', '-m', 'Hatch overnight: unfinished work that did not build']);
  return stash.ok && !/No local changes/i.test(stash.out);
}

// ---------- the night ----------

function fmtLeft(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function sessionPrompt({ goal, n, until, progress, last, phase }) {
  const lines = [
    `OVERNIGHT WORK, session ${n}. About ${fmtLeft(until - Date.now())} left. The user is asleep: nobody can answer questions, so decide things yourself.`,
    `Goal: ${goal}`,
    '',
    'Work on your own like an expert: plan, build, test, fix, and keep improving until the goal is done well.',
    'Keep a PROGRESS.md file in the project with four short sections: Goal, Done, Next, Problems. Update it whenever something changes.',
    'Hatch saves a checkpoint after every working build, so trying things is safe. Don\'t <open> anything: the user is asleep.',
  ];
  if (progress) lines.push('', 'Current PROGRESS.md:', progress.slice(0, 4000));
  else lines.push('', 'There is no PROGRESS.md yet: create it first, with your plan.');
  if (last?.stuck) {
    lines.push('', `The last session ended because ${last.stuck}. Try a different approach this time: rewrite the file that keeps failing, simplify the feature, or work on another part of the goal.`);
  }
  if (phase === 'improve') {
    lines.push('', 'The goal works and it builds. Now make it better: pick the most valuable improvement (from Next in PROGRESS.md, or think of one), do it, and keep it building. Never start over or remove working features.');
  }
  return lines.join('\n');
}

async function morningSummary(model, goal, progress) {
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(180000),
      body: JSON.stringify({
        model, stream: false, think: false, options: { num_ctx: 8192, temperature: 0.3 },
        messages: [
          { role: 'system', content: 'Write a short, friendly morning report for the user about the work done overnight: what was built and what is left. 3 to 5 sentences, plain words, no headings. Don\'t explain how to compile or run it (Hatch adds that).' },
          { role: 'user', content: `Goal: ${goal}\n\nPROGRESS.md:\n${(progress || '(none)').slice(0, 6000)}` },
        ],
      }),
    });
    return ((await res.json()).message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  } catch {
    return '';
  }
}

// runSession(text) -> the local engine's result ({ stuck, codeChanged, verified, okChecks, planDone, planTotal })
// verify() -> { ok } by building the project the way Hatch checks it, or null when there's nothing to build
export async function run({ chat, goal, until, model, signal, runSession, verify, note, report, onState }) {
  const cwd = chat.cwd;
  const state = { status: 'running', goal, until, startedAt: Date.now(), session: 0, checkpoints: 0, lastBuild: null, phase: 'build' };
  const publish = () => onState({ ...state });
  publish();

  const useGit = await ensureRepo(cwd);
  if (useGit) await checkpoint(cwd, 'Hatch overnight: starting point');
  else note('Git isn\'t available, so there are no checkpoints tonight.');

  let last = null;
  let idle = 0;
  let failures = 0;
  let endReason = 'time';

  while (!signal.aborted && Date.now() < until) {
    state.session++;
    publish();
    const progressFile = path.join(cwd, 'PROGRESS.md');
    const progress = fs.existsSync(progressFile) ? fs.readFileSync(progressFile, 'utf8') : '';
    note(`Overnight · session ${state.session} · ${fmtLeft(until - Date.now())} left`);

    let result;
    try {
      result = await runSession(sessionPrompt({ goal, n: state.session, until, progress, last, phase: state.phase }));
      failures = 0;
    } catch (err) {
      if (signal.aborted) break;
      failures++;
      note(`Session ${state.session} hit a problem: ${err.message}${failures < MAX_OLLAMA_FAILURES ? ' Trying again in a minute.' : ''}`);
      if (failures >= MAX_OLLAMA_FAILURES) { endReason = 'errors'; break; }
      await sleep(RETRY_WAIT, signal);
      continue;
    }

    // checkpoint whatever builds
    const progressed = result.codeChanged || result.okChecks > 0;
    if (result.codeChanged) {
      const check = result.verified ? { ok: true } : await verify();
      state.lastBuild = check ? (check.ok ? 'ok' : 'failed') : state.lastBuild;
      if (useGit && (!check || check.ok)) {
        const id = await checkpoint(cwd, `Hatch overnight: session ${state.session} (builds)`);
        if (id) state.checkpoints++;
      }
    }
    if (result.planTotal && result.planDone >= result.planTotal && state.lastBuild !== 'failed') state.phase = 'improve';
    idle = progressed ? 0 : idle + 1;
    last = result;
    publish();
    if (idle >= MAX_IDLE_SESSIONS) { endReason = 'stuck'; break; }
  }
  if (signal.aborted) endReason = 'stopped';

  // ---------- morning ----------
  state.status = 'finishing';
  publish();
  let restored = false;
  const final = await verify();
  if (final && !final.ok && useGit) restored = await restoreLastGood(cwd);
  if (final) state.lastBuild = final.ok || restored ? 'ok' : 'failed';

  const progress = fs.existsSync(path.join(cwd, 'PROGRESS.md')) ? fs.readFileSync(path.join(cwd, 'PROGRESS.md'), 'utf8') : '';
  const summary = await morningSummary(model, goal, progress);
  // how to try it: the newest program it built, or its web page
  const exe = fs.readdirSync(cwd).filter(f => /\.exe$/i.test(f))
    .sort((a, b) => fs.statSync(path.join(cwd, b)).mtimeMs - fs.statSync(path.join(cwd, a)).mtimeMs)[0];
  const tryIt = exe ? `To try it, open ${exe} in the project folder (the folder button at the top).`
    : fs.existsSync(path.join(cwd, 'index.html')) ? 'To try it, open index.html in the project folder (the folder button at the top).' : '';
  const hours = ((Date.now() - state.startedAt) / 3600000).toFixed(1);
  const why = { time: 'Time\'s up.', stopped: 'You stopped it.', stuck: 'It stopped early because the last few sessions made no progress.', errors: 'It stopped because Ollama kept failing.' }[endReason];
  const facts = [
    `${why} Worked ${hours} h over ${state.session} session${state.session === 1 ? '' : 's'}, ${state.checkpoints} working checkpoint${state.checkpoints === 1 ? '' : 's'}.`,
    restored ? 'The very last changes didn\'t build, so Hatch put the project back to its last working version (the unfinished work is saved in git stash).'
      : state.lastBuild === 'ok' ? 'The project builds.' : state.lastBuild === 'failed' ? 'The project doesn\'t build right now.' : '',
    tryIt,
    progress ? 'Details are in PROGRESS.md in the project folder.' : '',
  ].filter(Boolean).join(' ');
  report(`${summary ? `${summary}\n\n` : ''}${facts}`);

  state.status = endReason === 'stopped' ? 'stopped' : 'done';
  state.endedAt = Date.now();
  publish();
  return state;
}
