// A tiny MCP server (stdio) that gives Codex Hatch's own tools: delegate and wait_for_helpers in team
// chats, and propose_skill for any lead. Hatch starts it with HATCH_BRIDGE/HATCH_TOKEN (and
// HATCH_HELPERS, HATCH_BACKGROUND, HATCH_SKILLS); each call goes back to Hatch, which answers it.
import http from 'node:http';
import readline from 'node:readline';

const { HATCH_BRIDGE, HATCH_TOKEN } = process.env;
const helpers = JSON.parse(process.env.HATCH_HELPERS || '[]');
const background = process.env.HATCH_BACKGROUND === '1';
// these change no files themselves, so the AI may run several at once
const together = { readOnlyHint: true };

const TOOLS = [];
if (helpers.length) {
  TOOLS.push({
    name: 'delegate',
    description: `Hand a task to a helper AI on your team${background ? '. It starts them and returns right away, so you can keep working; call wait_for_helpers for their reports' : ' and wait for their report'}. Helpers: ${helpers.map(h => `${h.name} (${h.model})${h.role ? `: ${h.role}` : ''}`).join('; ')}. They can't see the chat, so describe the task completely: the goal, the files, how to build and test it, and what "done" looks like.`,
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: helpers.map(h => h.name), description: 'Which helper' },
        task: { type: 'string', description: 'The complete task for the helper' },
      },
      required: ['agent', 'task'],
    },
    annotations: together,
  });
}
if (helpers.length && background) {
  TOOLS.push({
    name: 'wait_for_helpers',
    description: 'Wait until the helpers you gave tasks to have finished, and get their reports.',
    inputSchema: { type: 'object', properties: {} },
    annotations: together,
  });
}
if (process.env.HATCH_SKILLS === '1') {
  TOOLS.push({
    name: 'propose_skill',
    description: 'Propose a new reusable skill (instructions every AI in Hatch can use in later chats). The user approves or declines it in the chat; this returns right away.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name in lowercase-with-dashes, like "raylib-fps-game"' },
        description: { type: 'string', description: 'One line: when an AI should use this skill' },
        instructions: { type: 'string', description: 'The skill itself: clear step-by-step instructions in Markdown' },
      },
      required: ['name', 'description', 'instructions'],
    },
    annotations: together,
  });
}

const send = msg => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

// node's own http client: no time limit, since a helper can work for a long time
function call(tool, args) {
  return new Promise(resolve => {
    const body = JSON.stringify({ token: HATCH_TOKEN, tool, args });
    const req = http.request(`${HATCH_BRIDGE}/delegate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, text: `Hatch couldn't do that (${res.statusCode}).` }); }
      });
    });
    req.on('error', err => resolve({ ok: false, text: `Couldn't reach Hatch: ${err.message}` }));
    req.end(body);
  });
}

readline.createInterface({ input: process.stdin }).on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;   // notifications need no answer
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hatch', version: '1.0.0' } } });
    case 'tools/list':
      return send({ id: msg.id, result: { tools: TOOLS } });
    case 'tools/call': {
      if (!TOOLS.some(t => t.name === msg.params?.name)) return send({ id: msg.id, error: { code: -32602, message: `Unknown tool ${msg.params?.name}` } });
      const r = await call(msg.params.name, msg.params.arguments || {});
      return send({ id: msg.id, result: { content: [{ type: 'text', text: r.text }], isError: !r.ok } });
    }
    case 'ping':
      return send({ id: msg.id, result: {} });
    default:
      return send({ id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } });
  }
});
