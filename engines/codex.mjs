// OpenAI Codex engine: ChatGPT sign-in or an OpenAI API key.
// Codex can't pause to ask, so permissions map to its sandbox levels up front.
import { Codex } from '@openai/codex-sdk';
import { CODEX_EXE, getKey, cleanEnv } from '../lib/config.mjs';
import { MEMORY_DIR } from '../lib/memory.mjs';
import { refreshCodexLimits } from '../lib/usage.mjs';
import { codexServer } from '../lib/teams.mjs';

const SANDBOX = {
  readonly: { sandboxMode: 'read-only' },
  ask: { sandboxMode: 'workspace-write', networkAccessEnabled: false },
  edits: { sandboxMode: 'workspace-write', networkAccessEnabled: false },
  always: { sandboxMode: 'workspace-write', networkAccessEnabled: true },
  full: { sandboxMode: 'danger-full-access', networkAccessEnabled: true },
};

const STATUS = { in_progress: 'running', completed: 'done', failed: 'error' };

export async function run(ctx) {
  const { chat, provider, model, permission } = ctx;
  // leads get Hatch's own tools (delegate, propose_skill) from a small MCP server
  const hatch = ctx.team || ctx.proposeSkill ? await codexServer(ctx) : null;
  const codex = new Codex({
    codexPathOverride: CODEX_EXE,
    apiKey: provider === 'openai' ? getKey('openai') || undefined : undefined,
    env: cleanEnv(),
    config: { developer_instructions: ctx.instructions, ...(hatch ? { mcp_servers: { hatch: hatch.config } } : {}) },
  });
  const threadOptions = {
    workingDirectory: chat.cwd,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    additionalDirectories: [MEMORY_DIR],
    model: model || undefined,
    // a reviewer helper can look and run things, but not change files
    ...(ctx.noEdits ? SANDBOX.readonly : SANDBOX[permission] || SANDBOX.edits),
  };
  const thread = ctx.sessionId ? codex.resumeThread(ctx.sessionId, threadOptions) : codex.startThread(threadOptions);

  const replies = new Map();   // codex item id -> our item index
  try {
    const { events } = await thread.runStreamed(ctx.text, { signal: ctx.signal });
    ctx.activity?.('Thinking');
    for await (const e of events) {
      if (e.type === 'thread.started') ctx.setSession(e.thread_id);
      if (e.type === 'item.started') ctx.activity?.(itemStatus(e.item));
      if (e.type === 'item.completed') ctx.activity?.('Thinking');
      if (e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') onItem(ctx, e.item, replies);
      if (e.type === 'turn.completed') {
        const u = e.usage || {};
        ctx.reportUsage({ input: u.input_tokens || 0, output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0), cached: u.cached_input_tokens || 0, cost: 0 });
      } else if (e.type === 'turn.failed') ctx.fail(e.error?.message || 'Codex stopped.');
      else if (e.type === 'error') ctx.fail(e.message);
    }
  } finally {
    hatch?.close();
    if (provider === 'chatgpt') refreshCodexLimits();
  }
}

// What Codex is doing, for the activity bar.
function itemStatus(it) {
  switch (it.type) {
    case 'command_execution': return `Running: ${String(it.command || '').replace(/\s+/g, ' ').slice(0, 70)}`;
    case 'file_change': return 'Changing files';
    case 'agent_message': return 'Writing a reply';
    case 'web_search': return 'Looking on the web';
    case 'mcp_tool_call': return it.tool === 'delegate' ? `Handing a task to ${it.arguments?.agent || 'a helper'}` : it.tool === 'wait_for_helpers' ? 'Waiting for helpers' : it.tool === 'propose_skill' ? 'Proposing a skill' : `Using ${it.tool}`;
    case 'todo_list': return 'Planning';
    default: return 'Thinking';
  }
}

function onItem(ctx, it, replies) {
  const status = STATUS[it.status] || 'done';
  let tool = null;
  switch (it.type) {
    case 'agent_message': {
      if (replies.has(it.id)) ctx.updateItem(replies.get(it.id), { text: it.text || '' });
      else if (it.text) replies.set(it.id, ctx.addItem({ type: 'assistant', text: it.text }));
      return;
    }
    case 'command_execution':
      tool = { name: 'Bash', input: { command: it.command }, result: it.aggregated_output, status, isError: it.exit_code ? it.exit_code !== 0 : false };
      break;
    case 'file_change':
      tool = { name: 'Patch', input: { changes: it.changes }, status };
      break;
    case 'todo_list':
      tool = { name: 'TodoWrite', input: { todos: (it.items || []).map(t => ({ content: t.text, status: t.completed ? 'completed' : 'pending' })) }, status: 'done' };
      break;
    case 'web_search':
      tool = { name: 'WebSearch', input: { query: it.query }, status: it.status ? status : 'done' };
      break;
    case 'mcp_tool_call':
      tool = {
        name: `${it.server}: ${it.tool}`,
        input: it.arguments,
        result: it.error?.message || (it.result?.content || []).map(c => c.text || '').join('\n'),
        status,
      };
      break;
    case 'error':
      ctx.addItem({ type: 'note', text: it.message });
      return;
    default:
      return;   // reasoning is not shown
  }
  if (tool.isError && status === 'done') tool.status = 'error';
  delete tool.isError;
  const idx = ctx.findTool(it.id);
  if (idx >= 0) ctx.updateItem(idx, tool);
  else ctx.addItem({ type: 'tool', id: it.id, ...tool });
}
