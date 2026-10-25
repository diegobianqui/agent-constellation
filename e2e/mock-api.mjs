// A stand-in for the Claude API, for the end-to-end test only: Claude Code talks to it through
// ANTHROPIC_BASE_URL, so a real `claude -p` session runs with no model, no account and no network.
// It acts like a model that follows the plugin's command skills to the letter: when the last user
// message carries a skill that says "Run exactly this command" (or the telemetry skill's list of
// commands), it answers with one call of the shell tool Claude Code offers (Bash, or PowerShell on
// Windows without Git Bash) running that command, copied from the skill's text. When the tool's
// result comes back, it answers with a short text and ends the turn. Anything else gets "ok".
// Every answer carries fixed token numbers, so the test can find them again in the relay's stream
// (read from the session's transcript).
import http from 'node:http';

export const MOCK_USAGE = { input_tokens: 1234, output_tokens: 56, cache_read_input_tokens: 7890, cache_creation_input_tokens: 321 };

const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b && b.type === 'text' ? b.text : '')).join('\n') : '');

/** The command a careful model would run for this request, or null. */
export function commandFor(body) {
  // Claude Code may put messages with other roles (system) between the turns: only user and
  // assistant messages count here.
  const messages = (Array.isArray(body.messages) ? body.messages : []).filter(m => m && (m.role === 'user' || m.role === 'assistant'));
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return null;
  if (Array.isArray(last.content) && last.content.some(b => b && b.type === 'tool_result')) return null;
  // The skill's text is in one of the user messages of this turn (Claude Code may add others).
  let text = '';
  for (let i = messages.length - 1; i >= 0 && messages[i].role === 'user'; i--) text = textOf(messages[i].content) + '\n' + text;
  if (!/Run exactly (this command|one of these commands)/.test(text)) return null;
  const commands = [...text.matchAll(/`(node "[^`\n]+)`/g)].map(m => m[1]);
  if (!commands.length) return null;
  const typed = /The user typed: `\/agent-constellation:telemetry ?([^`]*)`/.exec(text);
  if (typed) {
    const word = typed[1].trim().split(/\s+/)[0];
    const want = word === 'on' ? / setup --no-hooks --plugin$/ : word === 'off' ? / setup --remove --no-hooks --plugin$/ : / status --plugin$/;
    return commands.find(c => want.test(c)) || null;
  }
  return commands[0];
}

function toolName(body) {
  const names = (Array.isArray(body.tools) ? body.tools : []).map(t => t && t.name);
  return names.includes('Bash') ? 'Bash' : names.includes('PowerShell') ? 'PowerShell' : null;
}

export function startMockApi({ port = 0, log = () => {} } = {}) {
  let n = 0;
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = req.url || '';
      if (req.method !== 'POST' || !/^\/v1\/messages(\?|$)/.test(url)) {
        if (/count_tokens/.test(url)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":10}'); return; }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"mock"}}');
        return;
      }
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* empty */ }
      const id = ++n;
      const tool = toolName(body);
      const command = tool ? commandFor(body) : null;
      const turns = (body.messages || []).filter(m => m && (m.role === 'user' || m.role === 'assistant'));
      const lastMsg = turns[turns.length - 1];
      const result = lastMsg && Array.isArray(lastMsg.content) ? lastMsg.content.find(b => b && b.type === 'tool_result') : null;
      const call = { id, model: body.model, tools: (body.tools || []).map(t => t.name), tool, command, toolResult: result ? { isError: !!result.is_error, text: textOf(result.content) || (typeof result.content === 'string' ? result.content : '') } : null };
      calls.push(call);
      log(call);
      const model = body.model || 'claude-sonnet-4-5';
      const content = command
        ? [{ type: 'tool_use', id: `toolu_e2e_${id}`, name: tool, input: tool === 'Bash' ? { command, description: 'Run the plugin command' } : { command, description: 'Run the plugin command' } }]
        : [{ type: 'text', text: result ? 'Done.' : 'ok' }];
      const stop = command ? 'tool_use' : 'end_turn';
      const message = { id: `msg_e2e_${id}`, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage: MOCK_USAGE };
      const headers = { 'request-id': `req_e2e_${id}` };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...MOCK_USAGE, output_tokens: 1 } } });
      content.forEach((block, index) => {
        if (block.type === 'tool_use') {
          ev('content_block_start', { index, content_block: { ...block, input: {} } });
          ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        } else {
          ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
          ev('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
        }
        ev('content_block_stop', { index });
      });
      ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: MOCK_USAGE.output_tokens } });
      ev('message_stop', {});
      res.end();
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, calls, close: () => new Promise(r => server.close(r)) })));
}
