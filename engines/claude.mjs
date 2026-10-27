// Claude Code engine. Besides Claude itself (subscription or API key) it drives any
// Anthropic-compatible endpoint: OpenRouter, a custom provider, or local Ollama models.
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import { CLAUDE_EXE, settings, getKey, cleanEnv } from '../lib/config.mjs';
import { MEMORY_DIR } from '../lib/memory.mjs';
import * as skills from '../lib/skills.mjs';

const MODEL_PIN_VARS = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];

function providerEnv(provider, model) {
  const env = cleanEnv();
  // non-Claude endpoints: background jobs (titles, helpers) must use the chosen model too
  const viaEndpoint = (url, token) => {
    env.ANTHROPIC_BASE_URL = url;
    env.ANTHROPIC_AUTH_TOKEN = token || '';
    env.ANTHROPIC_API_KEY = '';
    for (const k of MODEL_PIN_VARS) env[k] = model;
  };
  if (provider === 'api') env.ANTHROPIC_API_KEY = getKey('anthropic') || '';
  else if (provider === 'openrouter') viaEndpoint('https://openrouter.ai/api', getKey('openrouter'));
  else if (provider === 'custom') viaEndpoint(settings.custom.baseUrl, getKey('custom'));
  else if (provider === 'local') {
    viaEndpoint(settings.ollamaUrl, 'ollama');
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  }
  return env;
}

const SDK_MODE = { ask: 'default', edits: 'acceptEdits', always: 'acceptEdits', full: 'bypassPermissions', readonly: 'default' };
const HATCH_TOOLS = ['mcp__hatch__delegate', 'mcp__hatch__wait_for_helpers', 'mcp__hatch__propose_skill'];
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

// Hatch's own tools for Claude. Team leads hand tasks to helper AIs: in the background (cloud leads)
// delegate returns at once and wait_for_helpers collects the reports; otherwise delegate waits for
// the report. Any lead can propose a new skill, which the user approves in the chat.
function hatchServer({ team, proposeSkill }) {
  const reply = r => ({ content: [{ type: 'text', text: r.text }], isError: !r.ok });
  // Claude Code only runs several calls of a tool at once when it's marked read-only. These change
  // no files themselves; each helper's own file changes go through its own permission checks.
  const together = { annotations: { readOnlyHint: true } };
  const tools = [];
  if (team) {
    tools.push(tool(
      'delegate',
      `Hand a task to a helper AI on your team${team.background ? '. It starts them and returns right away, so you keep working; call wait_for_helpers for their reports' : ' and wait for their report'}. Helpers: ${team.helpers.map(h => `${h.name}${h.role ? ` (${h.role})` : ''}`).join(', ')}. They can't see the chat, so describe the task completely.`,
      { agent: z.enum(team.helpers.map(h => h.name)).describe('Which helper'), task: z.string().describe('The complete task: goal, the files they may change, how to build and test it, and what "done" looks like') },
      async ({ agent, task }) => reply(await (team.background ? team.start : team.delegate)(agent, task)),
      together,
    ));
  }
  if (team?.background) {
    tools.push(tool(
      'wait_for_helpers',
      'Wait until the helpers you gave tasks to have finished, and get their reports.',
      {},
      async () => reply({ ok: true, text: (await team.wait()) || 'No helpers are working, and there are no new reports.' }),
      together,
    ));
  }
  if (proposeSkill) {
    tools.push(tool(
      'propose_skill',
      'Propose a new reusable skill (instructions every AI in Hatch can use in later chats). The user approves or declines it in the chat; this returns right away.',
      {
        name: z.string().describe('Short name in lowercase-with-dashes, like "raylib-fps-game"'),
        description: z.string().describe('One line: when an AI should use this skill'),
        instructions: z.string().describe('The skill itself: clear step-by-step instructions in Markdown'),
      },
      async args => reply(proposeSkill(args)),
      together,
    ));
  }
  return createSdkMcpServer({ name: 'hatch', version: '1.0.0', alwaysLoad: true, timeout: 4 * 3600e3, tools });
}

// ---------- what Claude is doing, for the activity bar and live cards ----------

const fileName = p => String(p || '').split(/[\\/]/).pop();

function toolStatus(name, input) {
  if (/delegate$/.test(name)) return input?.agent ? `Handing a task to ${input.agent}` : 'Handing out a task';
  if (/wait_for_helpers$/.test(name)) return 'Waiting for helpers';
  if (/propose_skill$/.test(name)) return 'Proposing a skill';
  switch (name) {
    case 'Write': return input?.file_path ? `Writing ${fileName(input.file_path)}` : 'Writing a file';
    case 'Edit': case 'MultiEdit': return input?.file_path ? `Editing ${fileName(input.file_path)}` : 'Editing a file';
    case 'Read': return input?.file_path ? `Reading ${fileName(input.file_path)}` : 'Reading a file';
    case 'Bash': case 'PowerShell': return input?.command ? `Running: ${input.command.replace(/\s+/g, ' ').slice(0, 70)}` : 'Running a command';
    case 'Grep': case 'Glob': case 'LS': return 'Looking through the project';
    case 'WebSearch': case 'WebFetch': return 'Looking on the web';
    case 'TodoWrite': return 'Planning';
    default: return `Using ${name}`;
  }
}

// A string field from tool input JSON that is still streaming in (undefined until its key arrives).
function partialString(json, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!m) return undefined;
  let out = '';
  for (let i = m.index + m[0].length; i < json.length;) {
    const c = json[i];
    if (c === '"') return out;
    if (c !== '\\') { out += c; i++; continue; }
    const n = json[i + 1];
    if (n === undefined) break;
    if (n === 'u') {
      const hex = json.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
    } else {
      out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[n] ?? n;
      i += 2;
    }
  }
  return out;
}

// What a card shows while Claude is still writing the tool call (big files take a while).
function liveInput(name, json) {
  const f = k => partialString(json, k);
  if (name === 'Write') return { file_path: f('file_path'), content: f('content') ?? '' };
  if (name === 'Edit') return { file_path: f('file_path'), old_string: f('old_string'), new_string: f('new_string') };
  if (name === 'Bash' || name === 'PowerShell') return { command: f('command') ?? '' };
  if (/delegate$/.test(name)) return { agent: f('agent'), task: f('task') ?? '' };
  return null;
}

export async function run(ctx) {
  const { chat, provider, model, permission } = ctx;
  const streamedText = new Set();   // assistant message ids whose text arrived as deltas
  const blockItem = new Map();      // `${msgId}:${blockIndex}` -> item index
  const toolBlocks = new Map();     // `${msgId}:${blockIndex}` -> tool call still streaming in
  const runningTools = new Map();   // tool use id -> its status line, while it runs
  let msgId = null;
  const activity = ctx.activity || (() => {});

  const options = {
    cwd: chat.cwd,
    model: model || undefined,
    resume: ctx.sessionId || undefined,
    includePartialMessages: true,
    permissionMode: SDK_MODE[permission] || 'acceptEdits',
    allowDangerouslySkipPermissions: permission === 'full',
    additionalDirectories: [MEMORY_DIR],
    // a reviewer helper can look, build and run, but not change files
    disallowedTools: ['AskUserQuestion', ...(ctx.noEdits ? EDIT_TOOLS : [])],
    // skills imported into Hatch load as a plugin, next to the user's own Claude Code skills
    plugins: skills.catalog().length ? [{ type: 'local', path: skills.PLUGIN_DIR }] : [],
    skills: 'all',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: ctx.instructions },
    abortController: ctx.abort,
    env: providerEnv(provider, model),
    stderr: data => console.error('[claude]', data),
    canUseTool: async (toolName, input, opts) => {
      if (permission === 'always' || HATCH_TOOLS.includes(toolName)) return { behavior: 'allow', updatedInput: input };
      if (permission === 'readonly') {
        return { behavior: 'deny', message: 'This chat is in read-only mode. Describe the change instead of making it.' };
      }
      const ok = await ctx.askPermission(toolName, input, opts.toolUseID, opts.signal);
      return ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user chose not to allow this.' };
    },
  };
  if (fs.existsSync(CLAUDE_EXE)) options.pathToClaudeCodeExecutable = CLAUDE_EXE;
  if (ctx.team || ctx.proposeSkill) options.mcpServers = { hatch: hatchServer(ctx) };   // canUseTool always allows these
  // messages the user sends while Claude works reach it right after its next step, without stopping it
  if (ctx.takeMessages) {
    options.hooks = {
      PostToolUse: [{
        hooks: [async () => {
          const texts = ctx.takeMessages();
          return texts.length ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx.steerNote(texts) } } : {};
        }],
      }],
    };
  }

  for await (const m of query({ prompt: ctx.text, options })) {
    if (m.parent_tool_use_id) continue;   // skip helper-agent internals

    if (m.type === 'system' && m.subtype === 'init') {
      ctx.setSession(m.session_id);
    } else if (m.type === 'rate_limit_event') {
      if (provider === 'sub') ctx.noteRateLimit(m.rate_limit_info);
    } else if (m.type === 'stream_event') {
      const ev = m.event;
      const key = `${msgId}:${ev.index}`;
      if (ev.type === 'message_start') {
        msgId = ev.message.id;
        activity('Thinking');
      } else if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        if (b.type === 'text') {
          streamedText.add(msgId);
          blockItem.set(key, ctx.addItem({ type: 'assistant', text: b.text || '' }));
          activity('Writing a reply');
        } else if (b.type === 'thinking') {
          activity('Thinking');
        } else if (b.type === 'tool_use') {
          if (ctx.findTool(b.id) < 0) ctx.addItem({ type: 'tool', id: b.id, name: b.name, input: null, status: 'running' });
          toolBlocks.set(key, { id: b.id, name: b.name, json: '', at: 0 });
          activity(toolStatus(b.name));
        }
      } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        const idx = blockItem.get(key);
        if (idx !== undefined) ctx.appendText(idx, ev.delta.text);
      } else if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta') {
        // show a file (or command, or task) as Claude writes it, not only once it's finished
        const t = toolBlocks.get(key);
        if (t) {
          t.json += ev.delta.partial_json || '';
          if (Date.now() - t.at > 150) {
            t.at = Date.now();
            const live = liveInput(t.name, t.json);
            const idx = ctx.findTool(t.id);
            if (live && idx >= 0) {
              ctx.updateItem(idx, { input: live });
              activity(toolStatus(t.name, live));
            }
          }
        }
      }
    } else if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'text' && !streamedText.has(m.message.id) && b.text.trim()) {
          ctx.addItem({ type: 'assistant', text: b.text });
        } else if (b.type === 'tool_use') {
          const idx = ctx.findTool(b.id);
          if (idx >= 0) ctx.updateItem(idx, { input: b.input });
          else ctx.addItem({ type: 'tool', id: b.id, name: b.name, input: b.input, status: 'running' });
          runningTools.set(b.id, toolStatus(b.name, b.input));
          activity(runningTools.get(b.id));
        }
      }
    } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b.type !== 'tool_result') continue;
        ctx.toolResult(b.tool_use_id, b.content, b.is_error);
        runningTools.delete(b.tool_use_id);
      }
      // several tools can run at once: show one that's still going, else Claude is thinking again
      activity([...runningTools.values()].pop() || 'Thinking');
    } else if (m.type === 'result') {
      ctx.setSession(m.session_id);
      const u = m.usage || {};
      ctx.reportUsage({
        input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
        cached: u.cache_read_input_tokens || 0,
        cost: provider === 'api' ? m.total_cost_usd || 0 : 0,
      });
      if (m.subtype !== 'success') {
        ctx.fail((m.errors && m.errors.join('\n')) || `Stopped (${m.subtype}).`);
      } else if (m.is_error && m.result) {
        ctx.fail(m.result, { replacesLastReply: true });
      }
    }
  }
}
