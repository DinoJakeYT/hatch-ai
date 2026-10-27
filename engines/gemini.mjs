// Google Gemini CLI engine (Gemini API key). Runs headless with streaming JSON events.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { GEMINI_JS, NODE_EXE, getKey, cleanEnv } from '../lib/config.mjs';
import { MEMORY_DIR } from '../lib/memory.mjs';

// headless Gemini can't stop to ask, so "ask" works like "edits"
const APPROVAL = { readonly: 'plan', ask: 'auto_edit', edits: 'auto_edit', always: 'yolo', full: 'yolo' };

// Gemini tool names -> the card names Hatch already knows how to draw
function toCard(name, p = {}) {
  const file = p.file_path || p.absolute_path || p.path;
  switch (name) {
    case 'run_shell_command': return { name: 'Bash', input: { command: p.command, description: p.description } };
    case 'write_file': return { name: 'Write', input: { file_path: file, content: p.content } };
    case 'replace': return { name: 'Edit', input: { file_path: file, old_string: p.old_string, new_string: p.new_string } };
    case 'read_file': return { name: 'Read', input: { file_path: file } };
    case 'read_many_files': return { name: 'Read', input: { file_path: (p.paths || p.include || []).join(', ') } };
    case 'list_directory': return { name: 'LS', input: { path: p.dir_path || p.path } };
    case 'glob': return { name: 'Glob', input: { pattern: p.pattern } };
    case 'search_file_content':
    case 'grep_search': return { name: 'Grep', input: { pattern: p.pattern } };
    case 'google_web_search': return { name: 'WebSearch', input: { query: p.query } };
    case 'web_fetch': return { name: 'WebFetch', input: { url: p.url || p.prompt } };
    case 'write_todos': return { name: 'TodoWrite', input: { todos: (p.todos || []).map(t => ({ content: t.description, status: t.status })) } };
    default: return { name, input: p };
  }
}

export async function run(ctx) {
  const { chat, model, permission } = ctx;
  if (!NODE_EXE) throw new Error('Gemini needs Node.js installed (nodejs.org).');

  const resuming = !!ctx.sessionId;
  const sessionId = ctx.sessionId || crypto.randomUUID();
  // Gemini has no separate system-prompt option, so the shared instructions lead the first message
  const prompt = resuming ? ctx.text : `<instructions>\n${ctx.instructions}\n</instructions>\n\n${ctx.text}`;
  const args = [GEMINI_JS, '-p', prompt, '-o', 'stream-json', '--skip-trust',
    '--approval-mode', ctx.noEdits ? 'plan' : APPROVAL[permission] || 'auto_edit', '--include-directories', MEMORY_DIR,
    ...(resuming ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ...(model ? ['-m', model] : [])];

  const env = { ...cleanEnv(), GEMINI_API_KEY: getKey('gemini') || '', GEMINI_CLI_NO_RELAUNCH: 'true', NO_COLOR: '1' };
  const proc = spawn(NODE_EXE, args, { cwd: chat.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  ctx.signal.addEventListener('abort', () => proc.kill());
  ctx.setSession(sessionId);
  ctx.activity?.('Thinking');

  let reply = -1;     // item index of the reply currently streaming
  let stderr = '';
  let failed = false;
  proc.stderr.on('data', d => { stderr += d; });

  let buf = '';
  proc.stdout.on('data', d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'init' && e.session_id) ctx.setSession(e.session_id);
      else if (e.type === 'message' && e.role === 'assistant') {
        ctx.activity?.('Writing a reply');
        if (reply < 0) reply = ctx.addItem({ type: 'assistant', text: '' });
        ctx.appendText(reply, e.content || '');
      } else if (e.type === 'tool_use') {
        reply = -1;
        const card = toCard(e.tool_name, e.parameters);
        ctx.addItem({ type: 'tool', id: e.tool_id, status: 'running', ...card });
        ctx.activity?.(card.input?.command ? `Running: ${String(card.input.command).slice(0, 70)}` : card.input?.file_path ? `${card.name === 'Read' ? 'Reading' : 'Writing'} ${String(card.input.file_path).split(/[\\/]/).pop()}` : `Using ${card.name}`);
      } else if (e.type === 'tool_result') {
        ctx.activity?.('Thinking');
        ctx.toolResult(e.tool_id, e.output || e.error?.message || '', e.status === 'error');
      } else if (e.type === 'error') {
        if (e.severity === 'error') { failed = true; ctx.fail(e.message); }
      } else if (e.type === 'result') {
        const s = e.stats || {};
        ctx.reportUsage({ input: s.input_tokens || 0, output: s.output_tokens || 0, cached: s.cached || 0, cost: 0 });
        if (e.status === 'error' && !failed) { failed = true; ctx.fail(e.error?.message || 'Gemini stopped.'); }
      }
    }
  });

  const code = await new Promise(resolve => proc.on('close', resolve));
  if (ctx.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  if (code !== 0 && !failed) {
    const msg = stderr.split('\n').map(s => s.trim()).filter(s => s && !/^Warning:|Ripgrep/.test(s)).slice(-3).join('\n');
    ctx.fail(msg || `Gemini exited with code ${code}.`);
  }
}
