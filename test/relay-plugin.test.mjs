// Tests for what the plugin adds to the relay: plugin mode, who may read the relay (no pairing code,
// in either mode), starting it from a
// hook, idle exit, and token numbers read from transcripts.
//   node --test test/
// Never touches your real Claude Code configuration: HOME and CLAUDE_CONFIG_DIR point at a temp
// folder in every child process, and every relay runs on a free port other than 4318.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { relayPids } from './processes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(HERE, '..', 'plugins', 'agent-constellation', 'relay', 'constellation-relay.mjs');
const HOOKS = path.join(HERE, '..', 'plugins', 'agent-constellation', 'hooks', 'hooks.json');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-plugin-test-')));
const CONFIG = path.join(TMP, 'claude-config');
// CONSTELLATION_RELAY_PORT: a port nothing listens on, so a command that defaults to the relay's
// port never reaches a real relay on 4318.
const DEAD_PORT = 4397;
const ENV = { PATH: process.env.PATH, HOME: TMP, CLAUDE_CONFIG_DIR: CONFIG, CONSTELLATION_RELAY_PORT: String(DEAD_PORT) };
const PAGE = 'http://localhost:3314';
const SITE = 'https://diegobianqui.com';

const children = new Set();
after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// A relay in plugin mode, waiting until it listens.
async function startPluginRelay(extra = [], env = ENV) {
  const port = await freePort();
  const child = spawn(process.execPath, [RELAY, '--plugin', '--port', String(port), '--origin', PAGE, ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let out = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { out += d; if (out.includes('plugin mode')) resolve(); });
    child.on('exit', c => reject(new Error(`relay exited ${c}: ${out}`)));
  });
  const exited = new Promise(r => child.on('exit', code => r(code)));
  return { port, child, out, exited, stop: () => child.kill('SIGTERM') };
}

// The hook forwarder, as Claude Code runs it: one payload on stdin.
function hook(args, payload, env = ENV) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [RELAY, 'hook', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

// Reads a relay's event stream; .items() parses what arrived so far.
function openStream(port, origin = PAGE) {
  return new Promise((resolve, reject) => {
    let text = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}`, origin } }, res => {
      if (res.statusCode !== 200) { reject(new Error(`stream ${res.statusCode}`)); return; }
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      const wait = setInterval(() => {
        if (!text.includes('event: ready')) return;
        clearInterval(wait);
        resolve({
          res,
          text: () => text,
          items: () => text.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6))),
          close: () => res.destroy(),
        });
      }, 20);
    });
    req.on('error', reject);
  });
}

// ------------------------------------------------------------ the plugin's hooks

test('hooks.json: the 16 events, async, through the forwarder; --start where a session begins', () => {
  const { hooks } = JSON.parse(fs.readFileSync(HOOKS, 'utf8'));
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
    'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact',
    'TaskCreated', 'TaskCompleted', 'SessionEnd'];
  assert.deepEqual(Object.keys(hooks).sort(), [...events].sort());
  for (const e of events) {
    const [h] = hooks[e][0].hooks;
    assert.equal(h.type, 'command');
    assert.equal(h.async, true);
    assert.ok(h.timeout <= 10);
    const start = e === 'SessionStart' || e === 'UserPromptSubmit';
    assert.equal(h.command, `node "\${CLAUDE_PLUGIN_ROOT}/relay/constellation-relay.mjs" hook${start ? ' --start' : ''} --via plugin`);
  }
});

// ------------------------------------------------------------ no pairing code, exact CORS

test('plugin mode: the lab origins read it without a code; nothing else reads it', async () => {
  const r = await startPluginRelay();
  try {
    assert.doesNotMatch(r.out.replace(/Claude Code/g, ''), /pairing|code\b/i);
    for (const origin of [PAGE, SITE, 'https://www.diegobianqui.com']) {
      for (const p of ['/health', '/sessions']) {
        const ok = await request(r.port, { path: p, headers: { origin } });
        assert.equal(ok.status, 200, `${origin} ${p}`);
        assert.equal(ok.headers['access-control-allow-origin'], origin);
        assert.match(ok.headers.vary, /Origin/);
      }
      // A stale code from a manual relay changes nothing.
      assert.equal((await request(r.port, { path: '/health', headers: { origin, authorization: 'Bearer WRONGCODE' } })).status, 200);
      const pre = await request(r.port, { method: 'OPTIONS', path: '/events', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-private-network': 'true' } });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers['access-control-allow-origin'], origin);
      assert.equal(pre.headers['access-control-allow-private-network'], 'true');
    }
    const h = JSON.parse((await request(r.port, { path: '/health', headers: { origin: SITE } })).body);
    assert.equal(h.ok, true);
    assert.equal(h.mode, 'plugin');
    assert.equal('pairing' in h, false);

    // Other pages, look-alike origins, and requests that don't say where they come from: nothing.
    for (const origin of ['https://evil.example', 'http://diegobianqui.com', 'https://diegobianqui.com.evil.example', 'https://evil.diegobianqui.com', 'null', 'http://localhost:3311', undefined]) {
      for (const p of ['/health', '/events', '/sessions']) {
        const res = await request(r.port, { path: p, headers: origin === undefined ? {} : { origin } });
        assert.equal(res.status, 403, `${origin} ${p}`);
        assert.equal(res.headers['access-control-allow-origin'], undefined, `${origin} ${p}`);
        assert.ok(!res.body.includes('"ok"') && !res.body.includes('event:'), `${origin} ${p} body ${res.body}`);
      }
      if (origin !== undefined) {
        const pre = await request(r.port, { method: 'OPTIONS', path: '/events', headers: { origin, 'access-control-request-method': 'GET' } });
        assert.equal(pre.headers['access-control-allow-origin'], undefined);
        assert.equal(pre.headers['access-control-allow-private-network'], undefined);
      }
    }
    // The existing protections hold: no ingest from web pages, Host checked.
    const body = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' });
    assert.equal((await request(r.port, { method: 'POST', path: '/hook', headers: { origin: SITE, 'content-type': 'application/json' }, body })).status, 403);
    assert.equal((await request(r.port, { method: 'POST', path: '/v1/logs', headers: { origin: SITE, 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await request(r.port, { path: '/health', headers: { origin: SITE, host: `rebind.attacker.test:${r.port}` } })).status, 421);
    assert.equal((await request(r.port, { method: 'POST', path: '/hook', headers: { host: 'evil.example', 'content-type': 'application/json' }, body })).status, 421);

    // The stream works for the page, with stripping as before.
    const s = await openStream(r.port);
    assert.equal((await hook([`http://127.0.0.1:${r.port}/hook`], { hook_event_name: 'UserPromptSubmit', session_id: 'sess-cors', prompt: 'PROMPT-SECRET', cwd: '/Users/someone/acme' })).code, 0);
    await sleep(300);
    const items = s.items();
    assert.equal(items.length, 1);
    assert.equal(items[0].body.hook_event_name, 'UserPromptSubmit');
    assert.equal(items[0].body.project, 'acme');
    assert.ok(!s.text().includes('PROMPT-SECRET') && !s.text().includes('/Users/someone'));
    s.close();
  } finally { r.stop(); }
});

test('started by hand: no pairing code, the same exact origins as plugin mode, nothing else reads it', async () => {
  const port = await freePort();
  const OTHER_PAGE = 'http://localhost:3315';
  // --code was the pairing code's flag until relay 1.4: it no longer means anything.
  const child = spawn(process.execPath, [RELAY, '--port', String(port), '--origin', PAGE, '--code', 'TESTCODE'], { env: { ...ENV, CONSTELLATION_RELAY_ORIGINS: OTHER_PAGE }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let out = '';
  await new Promise((res, rej) => {
    child.stdout.on('data', d => { out += d; if (out.includes('Stop with Ctrl+C')) res(); });
    child.on('exit', c => rej(new Error(`relay exited ${c}: ${out}`)));
  });
  try {
    assert.doesNotMatch(out.replace(/Claude Code/g, ''), /pairing|paste|\bcode\b/i);
    assert.match(out, /Open the lab and press "Connect Claude Code"/);
    assert.match(out, new RegExp(`Also allowed to read the stream: ${PAGE}, ${OTHER_PAGE}`));
    for (const origin of [SITE, 'https://www.diegobianqui.com', PAGE, OTHER_PAGE]) {
      for (const p of ['/health', '/sessions']) {
        const ok = await request(port, { path: p, headers: { origin } });
        assert.equal(ok.status, 200, `${origin} ${p}`);
        assert.equal(ok.headers['access-control-allow-origin'], origin);
        assert.match(ok.headers.vary, /Origin/);
      }
      const pre = await request(port, { method: 'OPTIONS', path: '/events', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-private-network': 'true' } });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers['access-control-allow-private-network'], 'true');
      assert.equal(pre.headers['access-control-allow-headers'], undefined, 'no Authorization header to allow');
    }
    const h = JSON.parse((await request(port, { path: '/health', headers: { origin: SITE } })).body);
    assert.equal(h.ok, true);
    assert.equal(h.mode, 'manual');
    assert.equal(h.version, '1.5.1');
    assert.equal('pairing' in h, false);
    // The stream answers the page with no Authorization header.
    const s = await openStream(port, SITE);
    s.close();
    // An Authorization header changes nothing either way.
    assert.equal((await request(port, { path: '/health', headers: { origin: SITE, authorization: 'Bearer TESTCODE' } })).status, 200);
    assert.equal((await request(port, { path: '/health', headers: { authorization: 'Bearer TESTCODE' } })).status, 403);
    // Other pages, look-alikes and requests without an Origin: refused, never readable.
    for (const origin of ['https://evil.example', 'http://diegobianqui.com', 'https://diegobianqui.com.evil.example', 'null', 'http://localhost:3311', undefined]) {
      for (const p of ['/health', '/events', '/sessions']) {
        const res = await request(port, { path: p, headers: origin === undefined ? {} : { origin } });
        assert.equal(res.status, 403, `${origin} ${p}`);
        assert.equal(res.headers['access-control-allow-origin'], undefined, `${origin} ${p}`);
        assert.ok(!res.body.includes('"ok"') && !res.body.includes('event:'), `${origin} ${p} body ${res.body}`);
      }
    }
    // The other protections hold: no ingest from web pages, Host checked.
    const body = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' });
    assert.equal((await request(port, { method: 'POST', path: '/hook', headers: { origin: SITE, 'content-type': 'application/json' }, body })).status, 403);
    assert.equal((await request(port, { path: '/health', headers: { origin: SITE, host: `rebind.attacker.test:${port}` } })).status, 421);
  } finally { child.kill('SIGTERM'); }
});

// ------------------------------------------------------------ starting it from the hooks

test('hook --start: one relay for many hooks at once; all events arrive', async () => {
  const port = await freePort();
  const env = { ...ENV, CONSTELLATION_RELAY_PORT: String(port), CONSTELLATION_RELAY_ORIGINS: PAGE };
  const runs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    hook(['--start'], { hook_event_name: 'SessionStart', session_id: `sess-start-${i}`, source: 'startup', transcript_path: '/nowhere/x.jsonl' }, env)));
  // On Windows a hook that starts the relay may wait up to 6 s (see hookTimes).
  const limit = process.platform === 'win32' ? 7000 : 2600;
  for (const r of runs) {
    assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
    assert.ok(r.ms < limit, `took ${r.ms} ms`);
  }
  await sleep(800);
  const pids = relayPids(port);
  try {
    assert.equal(pids.length, 1, `relays running: ${pids.length}`);
    const h = JSON.parse((await request(port, { path: '/health', headers: { origin: PAGE } })).body);
    assert.equal(h.mode, 'plugin');
    assert.equal(h.counts.hooks, 6);
    // A later hook finds it running and starts nothing new.
    assert.equal((await hook(['--start'], { hook_event_name: 'UserPromptSubmit', session_id: 'sess-start-0' }, env)).code, 0);
    await sleep(300);
    assert.deepEqual(relayPids(port), pids);
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  }
});

test('hook --start: starts nothing when another program holds the port, and stays silent', async () => {
  const sockets = [];
  const other = net.createServer(s => { sockets.push(s); s.on('error', () => {}); s.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); }).listen(0, '127.0.0.1');
  await new Promise(r => other.on('listening', r));
  const port = other.address().port;
  const env = { ...ENV, CONSTELLATION_RELAY_PORT: String(port) };
  const r = await hook(['--start'], { hook_event_name: 'SessionStart', session_id: 'sess-other' }, env);
  assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
  await sleep(400);
  assert.ok(sockets.length >= 1, 'the hook posted to whatever listens');
  assert.deepEqual(relayPids(port), []);
  other.close();

  // A relay started in plugin mode on a taken port exits at once, without a word.
  const taken = net.createServer().listen(0, '127.0.0.1');
  await new Promise(x => taken.on('listening', x));
  const res = await new Promise(resolve => {
    const c = spawn(process.execPath, [RELAY, '--plugin', '--port', String(taken.address().port)], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { out += d; });
    c.on('exit', code => resolve({ code, out }));
  });
  assert.deepEqual(res, { code: 0, out: '' });
  taken.close();
});

test('plugin mode exits by itself when idle; a connected page keeps it running', async () => {
  const r = await startPluginRelay(['--idle-seconds', '1.5']);
  const s = await openStream(r.port);
  // Twice the idle time with the page open: still running.
  await sleep(3000);
  assert.equal(r.child.exitCode, null, 'running while a page is connected');
  // Hooks also count as use.
  s.close();
  for (let i = 0; i < 4; i++) {
    await sleep(500);
    await request(r.port, { method: 'POST', path: '/hook', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'idle' }) });
  }
  assert.equal(r.child.exitCode, null, 'running while hooks arrive');
  const t0 = Date.now();
  const code = await r.exited;
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 4000, `exited after ${Date.now() - t0} ms`);
  await assert.rejects(request(r.port, { path: '/health', headers: { origin: PAGE } }));
});

// ------------------------------------------------------------ token numbers from transcripts

const SECRET = {
  prompt: 'PROMPT-TEXT-SECRET refund the duplicate charge',
  reply: 'REPLY-TEXT-SECRET the second charge was a retry',
  thinking: 'THINKING-SECRET',
  tool: 'TOOL-INPUT-SECRET rm -rf build',
  email: 'jane.secret@example.com',
  path: '/Users/jane/clients/acme-secret',
};
const enc = p => p.replace(/[^a-zA-Z0-9]/g, '-');

function transcriptFor(session, project = SECRET.path, config = CONFIG) {
  const dir = path.join(config, 'projects', enc(project));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${session}.jsonl`);
}
const userLine = (session, text) => JSON.stringify({ type: 'user', sessionId: session, cwd: SECRET.path, message: { role: 'user', content: text }, uuid: 'u-' + Math.random(), timestamp: new Date().toISOString() });
function assistantLine(session, { id, req, model = 'claude-opus-5-5', usage, content, agentId, ts = '2026-10-23T10:00:00.000Z' }) {
  return JSON.stringify({
    type: 'assistant', sessionId: session, cwd: SECRET.path, gitBranch: 'main', userType: 'external', ...(agentId ? { agentId, isSidechain: true } : {}),
    requestId: req, uuid: 'a-' + Math.random(), timestamp: ts,
    message: { id, type: 'message', role: 'assistant', model, content, stop_reason: 'end_turn', usage: { service_tier: 'standard', ...usage } },
  });
}
const U = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });

// The api_request records in the stream: [{ session, agent, model, request, in, out, cacheRead, cacheWrite }]
function usageIn(items) {
  const out = [];
  for (const it of items) {
    if (it.path !== '/v1/logs') continue;
    for (const rl of it.body.resourceLogs) for (const sl of rl.scopeLogs) for (const lr of sl.logRecords) {
      const a = Object.fromEntries(lr.attributes.map(kv => [kv.key, kv.value.stringValue ?? Number(kv.value.intValue)]));
      out.push({ session: a['session.id'], agent: a.agent_id, model: a.model, request: a.request_id, in: a.input_tokens, out: a.output_tokens, cacheRead: a.cache_read_tokens, cacheWrite: a.cache_creation_tokens, cacheWrite1h: a.cache_creation_1h_tokens, speed: a.speed, geo: a.inference_geo, source: a['usage.source'], event: a['event.name'], body: lr.body.stringValue });
    }
  }
  return out;
}

test('transcripts: only the numbers come out, read incrementally, partial lines waited for', async () => {
  const r = await startPluginRelay();
  const s = await openStream(r.port);
  const session = 'aaaa1111-2222-3333-4444-555566667777';
  const file = transcriptFor(session);
  const send = (event, extra = {}) => hook([`http://127.0.0.1:${r.port}/hook`], {
    hook_event_name: event, session_id: session, transcript_path: file, cwd: SECRET.path, last_assistant_message: SECRET.reply, prompt: SECRET.prompt, ...extra,
  });
  try {
    // A turn: prompt, a reply in two content blocks (the same message twice, as Claude Code writes
    // it), a tool call, a synthetic message and a message without usage.
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'summary', summary: SECRET.prompt }),
      userLine(session, `${SECRET.prompt} ${SECRET.email}`),
      assistantLine(session, { id: 'msg_A', req: 'req_A', usage: U(10, 200, 3000, 400), content: [{ type: 'thinking', thinking: SECRET.thinking }] }),
      assistantLine(session, { id: 'msg_A', req: 'req_A', usage: U(10, 200, 3000, 400), content: [{ type: 'tool_use', name: 'Bash', input: { command: SECRET.tool } }] }),
      userLine(session, [{ type: 'tool_result', content: `${SECRET.path}/notes.md ${SECRET.email}` }]),
      assistantLine(session, { id: 'msg_B', req: 'req_B', model: 'claude-haiku-4-5', usage: U(5, 60, 3400, 0), content: [{ type: 'text', text: SECRET.reply }] }),
      assistantLine(session, { id: 'msg_S', req: 'req_S', model: '<synthetic>', usage: U(0, 0, 0, 0), content: [{ type: 'text', text: 'API Error' }] }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg_N', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: SECRET.reply }] } }),
      '{"type":"assistant","message":{"usage": not json',
      '',
    ].join('\n'));
    assert.equal((await send('Stop')).code, 0);
    await sleep(700);
    let usage = usageIn(s.items());
    assert.deepEqual(usage.map(u => [u.request, u.model, u.in, u.out, u.cacheRead, u.cacheWrite]), [
      ['req_A', 'claude-opus-5-5', 10, 200, 3000, 400],
      ['req_B', 'claude-haiku-4-5', 5, 60, 3400, 0],
    ]);
    assert.ok(usage.every(u => u.session === session && u.event === 'api_request' && u.body === 'claude_code.api_request' && u.agent === undefined));

    // The late read after Stop finds nothing new: nothing counted twice.
    await sleep(2800);
    assert.equal(usageIn(s.items()).length, 2);

    // Incremental: a new call, and a line still being written.
    const next = assistantLine(session, { id: 'msg_C', req: 'req_C', usage: U(7, 70, 3500, 10), content: [{ type: 'text', text: SECRET.reply }] });
    const half = assistantLine(session, { id: 'msg_D', req: 'req_D', usage: U(8, 80, 3600, 20), content: [{ type: 'text', text: SECRET.reply }] });
    fs.appendFileSync(file, `${userLine(session, SECRET.prompt)}\n${next}\n${half.slice(0, 120)}`);
    assert.equal((await send('PostToolUse', { tool_name: 'Bash', tool_input: { command: SECRET.tool } })).code, 0);
    await sleep(600);
    usage = usageIn(s.items());
    assert.deepEqual(usage.map(u => u.request), ['req_A', 'req_B', 'req_C'], 'only the new complete line');
    // The rest of the line arrives; the same message is written again (another content block).
    fs.appendFileSync(file, `${half.slice(120)}\n${half}\n`);
    assert.equal((await send('PostToolUse', { tool_name: 'Read' })).code, 0);
    await sleep(600);
    usage = usageIn(s.items());
    assert.deepEqual(usage.map(u => [u.request, u.in, u.out, u.cacheRead, u.cacheWrite]).slice(2), [['req_C', 7, 70, 3500, 10], ['req_D', 8, 80, 3600, 20]]);

    // A line too long to be a model call's (a pasted image) is skipped, and the next one counted.
    fs.appendFileSync(file, `${userLine(session, 'x'.repeat(5 << 20))}\n${assistantLine(session, { id: 'msg_E', req: 'req_E', usage: U(1, 2, 3, 4), content: [] })}\n`);
    assert.equal((await send('UserPromptSubmit')).code, 0);
    await sleep(900);
    assert.deepEqual(usageIn(s.items()).map(u => u.request).slice(4), ['req_E']);

    // Nothing of the text, the paths or the identity anywhere in the stream.
    const text = s.text();
    for (const m of [...Object.values(SECRET), 'refund', 'notes.md', '.jsonl', enc(SECRET.path), CONFIG, TMP, 'transcript_path', 'last_assistant_message', '"prompt"', 'API Error', 'msg_N', '<synthetic>', 'gitBranch', 'thinking', 'tool_use']) {
      assert.ok(!text.includes(m), `stream contains ${m}`);
    }
    const h = JSON.parse((await request(r.port, { path: '/health', headers: { origin: PAGE } })).body);
    assert.equal(h.counts.transcripts, 5);
  } finally { s.close(); r.stop(); }
});

test('transcripts: a subagent\'s own transcript, attributed to it', async () => {
  const r = await startPluginRelay();
  const s = await openStream(r.port);
  const session = 'bbbb1111-2222-3333-4444-555566667777';
  const agent = 'a1b2c3d4e5';
  const main = transcriptFor(session);
  fs.writeFileSync(main, assistantLine(session, { id: 'msg_M', req: 'req_M', usage: U(1, 1, 1, 1), content: [] }) + '\n');
  const subDir = path.join(path.dirname(main), session, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const sub = path.join(subDir, `agent-${agent}.jsonl`);
  fs.writeFileSync(sub, [
    userLine(session, SECRET.prompt),
    assistantLine(session, { id: 'msg_S1', req: 'req_S1', usage: U(20, 300, 0, 9000), content: [{ type: 'text', text: SECRET.reply }], agentId: agent }),
    '',
  ].join('\n'));
  try {
    // A hook inside the subagent (agent_id, the session's transcript_path): both files are read.
    await hook([`http://127.0.0.1:${r.port}/hook`], { hook_event_name: 'PostToolUse', session_id: session, agent_id: agent, agent_type: 'Explore', tool_name: 'Read', transcript_path: main });
    await sleep(600);
    let usage = usageIn(s.items());
    assert.deepEqual(usage.map(u => [u.request, u.agent]).sort(), [['req_M', undefined], ['req_S1', agent]]);
    // SubagentStop names it directly; nothing new, nothing twice.
    fs.appendFileSync(sub, assistantLine(session, { id: 'msg_S2', req: 'req_S2', usage: U(2, 30, 9000, 0), content: [], agentId: agent }) + '\n');
    await hook([`http://127.0.0.1:${r.port}/hook`], { hook_event_name: 'SubagentStop', session_id: session, agent_id: agent, agent_type: 'Explore', transcript_path: main, agent_transcript_path: sub });
    await sleep(600);
    usage = usageIn(s.items());
    assert.deepEqual(usage.filter(u => u.agent === agent).map(u => u.request), ['req_S1', 'req_S2']);
    assert.ok(!s.text().includes('subagents') && !s.text().includes(SECRET.reply));
  } finally { s.close(); r.stop(); }
});

test('transcripts: only Claude Code transcripts named by the hook are read', async () => {
  const r = await startPluginRelay();
  const s = await openStream(r.port);
  const session = 'cccc1111-2222-3333-4444-555566667777';
  const line = assistantLine(session, { id: 'msg_X', req: 'req_X', usage: U(1, 2, 3, 4), content: [] }) + '\n';
  // Not under a "projects" folder; under one but named after another session; a symbolic link.
  const outside = path.join(TMP, 'elsewhere', `${session}.jsonl`);
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, line);
  const wrongName = path.join(path.dirname(transcriptFor(session)), 'other-session.jsonl');
  fs.writeFileSync(wrongName, line);
  const linkDir = path.join(CONFIG, 'projects', 'linked');
  fs.mkdirSync(linkDir, { recursive: true });
  const link = path.join(linkDir, `${session}.jsonl`);
  fs.symlinkSync(outside, link);
  try {
    for (const transcript_path of [outside, wrongName, link, 'relative/projects/x.jsonl', `${CONFIG}/projects/../../elsewhere/${session}.jsonl`]) {
      await hook([`http://127.0.0.1:${r.port}/hook`], { hook_event_name: 'Stop', session_id: session, transcript_path });
    }
    // A hook posted straight to the relay (not through the forwarder) is held to the same rules.
    await request(r.port, { method: 'POST', path: '/hook', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'x', transcript_path: '/etc/passwd' }) });
    await sleep(700);
    assert.deepEqual(usageIn(s.items()), []);
    assert.equal(s.items().filter(i => i.path === '/hook').length, 6);
  } finally { s.close(); r.stop(); }
});

test('transcripts: with telemetry on, its own events are the source (no double count)', async () => {
  const r = await startPluginRelay();
  const s = await openStream(r.port);
  const session = 'dddd1111-2222-3333-4444-555566667777';
  const file = transcriptFor(session);
  fs.writeFileSync(file, assistantLine(session, { id: 'msg_T', req: 'req_T', usage: U(1, 2, 3, 4), content: [] }) + '\n');
  try {
    const otlp = { resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: [{ timeUnixNano: '1', body: { stringValue: 'claude_code.api_request' }, attributes: [{ key: 'event.name', value: { stringValue: 'api_request' } }, { key: 'session.id', value: { stringValue: session } }, { key: 'request_id', value: { stringValue: 'req_T' } }, { key: 'input_tokens', value: { intValue: '1' } }] }] }] }] };
    assert.equal((await request(r.port, { method: 'POST', path: '/v1/logs', headers: { 'content-type': 'application/json' }, body: JSON.stringify(otlp) })).status, 200);
    await hook([`http://127.0.0.1:${r.port}/hook`], { hook_event_name: 'Stop', session_id: session, transcript_path: file });
    await sleep(700);
    const usage = usageIn(s.items());
    assert.equal(usage.length, 1, 'only the telemetry event');
    assert.equal(usage[0].model, undefined);
  } finally { s.close(); r.stop(); }
});

// ------------------------------------------------------------ telemetry per session, scan backfill

// An OTLP logs body: one api_request event per call, as Claude Code's telemetry sends them.
function telemetryLogs(session, calls) {
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }, { key: 'session.id', value: { stringValue: session } }] },
      scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: calls.map(c => ({
        timeUnixNano: `${c.at}000000`, body: { stringValue: 'claude_code.api_request' },
        attributes: [
          { key: 'event.name', value: { stringValue: 'api_request' } },
          { key: 'event.timestamp', value: { stringValue: new Date(c.at).toISOString() } },
          { key: 'session.id', value: { stringValue: session } },
          { key: 'request_id', value: { stringValue: c.req } },
          { key: 'model', value: { stringValue: 'claude-opus-5-5' } },
          { key: 'input_tokens', value: { intValue: '1' } }, { key: 'output_tokens', value: { intValue: '2' } },
          { key: 'cost_usd', value: { doubleValue: 0.01 } },
        ],
      })) }],
    }],
  };
}
const postLogs = (port, body) => request(port, { method: 'POST', path: '/v1/logs', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const iso = ms => new Date(ms).toISOString();

test('telemetry per session: a session without it keeps its transcript usage; one with it counts each call once', async () => {
  const r = await startPluginRelay();
  const s = await openStream(r.port);
  const withT = 'eeee1111-2222-3333-4444-555566667777';
  const without = 'ffff1111-2222-3333-4444-555566667777';
  const fileT = transcriptFor(withT);
  const fileN = transcriptFor(without);
  const t0 = Date.now() - 60000; // the session's telemetry started a minute ago
  try {
    // Telemetry for one session: two calls, the first at t0.
    assert.equal((await postLogs(r.port, telemetryLogs(withT, [{ req: 'req_T1', at: t0 }, { req: 'req_T2', at: t0 + 5000 }]))).status, 200);
    fs.writeFileSync(fileT, [
      // Before its telemetry reached the relay, and not in it: counted from the transcript.
      assistantLine(withT, { id: 'msg_T0', req: 'req_T0', usage: U(3, 30, 0, 0), content: [], ts: iso(t0 - 600000) }),
      // In its telemetry: not counted again, whatever the time says.
      assistantLine(withT, { id: 'msg_T1', req: 'req_T1', usage: U(1, 2, 0, 0), content: [], ts: iso(t0 - 1000) }),
      assistantLine(withT, { id: 'msg_T2', req: 'req_T2', usage: U(1, 2, 0, 0), content: [], ts: iso(t0 + 5000) }),
      // After its telemetry started, its event not here yet: telemetry will count it.
      assistantLine(withT, { id: 'msg_T3', req: 'req_T3', usage: U(1, 2, 0, 0), content: [], ts: iso(Date.now()) }),
      '',
    ].join('\n'));
    fs.writeFileSync(fileN, [
      assistantLine(without, { id: 'msg_N1', req: 'req_N1', usage: U(10, 100, 1000, 50), content: [], ts: iso(Date.now() - 2000) }),
      assistantLine(without, { id: 'msg_N2', req: 'req_N2', usage: U(20, 200, 2000, 0), content: [], ts: iso(Date.now()) }),
      '',
    ].join('\n'));
    await hook([`http://127.0.0.1:${r.port}/hook`], { hook_event_name: 'Stop', session_id: withT, transcript_path: fileT });
    await hook([`http://127.0.0.1:${r.port}/hook`], { hook_event_name: 'Stop', session_id: without, transcript_path: fileN });
    await sleep(2800); // records wait 2 s while telemetry is arriving
    const fromTranscripts = usageIn(s.items()).filter(u => u.source === 'transcript');
    assert.deepEqual(fromTranscripts.map(u => [u.session, u.request]).sort(), [[withT, 'req_T0'], [without, 'req_N1'], [without, 'req_N2']].sort());
    // Telemetry arrives for the call the transcript left to it, and the session's next call is read:
    // still nothing twice.
    await postLogs(r.port, telemetryLogs(withT, [{ req: 'req_T3', at: Date.now() }]));
    fs.appendFileSync(fileT, assistantLine(withT, { id: 'msg_T4', req: 'req_T4', usage: U(1, 2, 0, 0), content: [], ts: iso(Date.now()) }) + '\n');
    fs.appendFileSync(fileN, assistantLine(without, { id: 'msg_N3', req: 'req_N3', usage: U(1, 1, 0, 0), content: [], ts: iso(Date.now()) }) + '\n');
    await hook([`http://127.0.0.1:${r.port}/hook`], { hook_event_name: 'PostToolUse', session_id: withT, tool_name: 'Read', transcript_path: fileT });
    await hook([`http://127.0.0.1:${r.port}/hook`], { hook_event_name: 'PostToolUse', session_id: without, tool_name: 'Read', transcript_path: fileN });
    await sleep(2800);
    const all = usageIn(s.items());
    assert.deepEqual(all.filter(u => u.source === 'transcript').map(u => u.request).sort(), ['req_N1', 'req_N2', 'req_N3', 'req_T0']);
    assert.deepEqual(all.filter(u => u.source !== 'transcript').map(u => u.request), ['req_T1', 'req_T2', 'req_T3']);
    // Each call once across both sources.
    const ids = all.map(u => u.request);
    assert.equal(new Set(ids).size, ids.length);
    const h = JSON.parse((await request(r.port, { path: '/health', headers: { origin: PAGE } })).body);
    assert.equal(h.version, '1.5.1');
    assert.equal(h.counts.transcripts, 4);
    assert.equal(h.counts.transcriptsSkipped, 4);
  } finally { s.close(); r.stop(); }
});

test('telemetry that starts mid-way: calls before it from the transcript, after it from telemetry, each once', async () => {
  const r = await startPluginRelay();
  const s = await openStream(r.port);
  const session = 'abab1111-2222-3333-4444-555566667777';
  const file = transcriptFor(session);
  try {
    // No telemetry yet anywhere: the transcript's calls are published at once.
    fs.writeFileSync(file, [
      assistantLine(session, { id: 'msg_1', req: 'req_1', usage: U(1, 10, 0, 0), content: [], ts: iso(Date.now() - 120000) }),
      assistantLine(session, { id: 'msg_2', req: 'req_2', usage: U(2, 20, 0, 0), content: [], ts: iso(Date.now() - 60000) }),
      '',
    ].join('\n'));
    await hook([`http://127.0.0.1:${r.port}/hook`], { hook_event_name: 'Stop', session_id: session, transcript_path: file });
    await sleep(600);
    assert.deepEqual(usageIn(s.items()).map(u => u.request), ['req_1', 'req_2']);
    // Telemetry starts (a new relay, a resumed session): its first batch has call 3, and an
    // exporter retry repeats call 2, which the page counts once by its request id.
    const now = Date.now();
    await postLogs(r.port, telemetryLogs(session, [{ req: 'req_2', at: now - 60000 }, { req: 'req_3', at: now }]));
    fs.appendFileSync(file, [
      assistantLine(session, { id: 'msg_3', req: 'req_3', usage: U(3, 30, 0, 0), content: [], ts: iso(now) }),
      assistantLine(session, { id: 'msg_4', req: 'req_4', usage: U(4, 40, 0, 0), content: [], ts: iso(now + 10) }),
      '',
    ].join('\n'));
    await hook([`http://127.0.0.1:${r.port}/hook`], { hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Read', transcript_path: file });
    await sleep(2800);
    await postLogs(r.port, telemetryLogs(session, [{ req: 'req_4', at: now + 10 }]));
    await sleep(200);
    const all = usageIn(s.items());
    assert.deepEqual(all.filter(u => u.source === 'transcript').map(u => u.request), ['req_1', 'req_2']);
    assert.deepEqual(all.filter(u => u.source !== 'transcript').map(u => u.request), ['req_2', 'req_3', 'req_4']);
  } finally { s.close(); r.stop(); }
});

test('transcripts: 1-hour cache writes, fast mode and US-only inference pass as numbers and short words', async () => {
  const r = await startPluginRelay();
  const s = await openStream(r.port);
  const session = 'acac1111-2222-3333-4444-555566667777';
  const file = transcriptFor(session);
  try {
    fs.writeFileSync(file, [
      assistantLine(session, { id: 'msg_F', req: 'req_F', usage: { ...U(5, 50, 100, 1000), cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 }, speed: 'fast', inference_geo: 'us' }, content: [] }),
      assistantLine(session, { id: 'msg_G', req: 'req_G', usage: { ...U(5, 50, 100, 10), cache_creation: { ephemeral_1h_input_tokens: 'lots' }, speed: SECRET.prompt, inference_geo: SECRET.path }, content: [] }),
      '',
    ].join('\n'));
    await hook([`http://127.0.0.1:${r.port}/hook`], { hook_event_name: 'Stop', session_id: session, transcript_path: file });
    await sleep(600);
    assert.deepEqual(usageIn(s.items()).map(u => [u.request, u.cacheWrite, u.cacheWrite1h, u.speed, u.geo]), [
      ['req_F', 1000, 600, 'fast', 'us'],
      ['req_G', 10, undefined, undefined, undefined],
    ]);
    assert.ok(!s.text().includes(SECRET.prompt) && !s.text().includes(SECRET.path));
  } finally { s.close(); r.stop(); }
});

test('scan: the sessions found get their token numbers too, within the same limits, no paths or text', async () => {
  const config = path.join(TMP, 'scan-config');
  const env = { ...ENV, CLAUDE_CONFIG_DIR: config };
  const r = await startPluginRelay([], env);
  const s = await openStream(r.port);
  const A = '1a1a1111-2222-3333-4444-555566667777'; // hooks earlier, and a subagent
  const B = '2b2b1111-2222-3333-4444-555566667777'; // no hooks ever (running before the plugin)
  const C = '3c3c1111-2222-3333-4444-555566667777'; // a 34 MB transcript: only its last 32 MB on first sight
  const OLD = '4d4d1111-2222-3333-4444-555566667777'; // changed 2 days ago: not in the scan
  const fa = transcriptFor(A, SECRET.path, config);
  const fb = transcriptFor(B, '/Users/jane/other-secret', config);
  const fc = transcriptFor(C, SECRET.path, config);
  const fo = transcriptFor(OLD, SECRET.path, config);
  const line = (sess, id, extra = {}) => assistantLine(sess, { id: `msg_${id}`, req: `req_${id}`, usage: U(1, 2, 3, 4), content: [{ type: 'text', text: SECRET.reply }], ...extra });
  try {
    fs.writeFileSync(fa, line(A, 'A1') + '\n');
    await hook([`http://127.0.0.1:${r.port}/hook`], { hook_event_name: 'Stop', session_id: A, transcript_path: fa });
    await sleep(600);
    assert.deepEqual(usageIn(s.items()).map(u => u.request), ['req_A1']);
    fs.appendFileSync(fa, line(A, 'A2') + '\n');
    const subDir = path.join(path.dirname(fa), A, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-sub1.jsonl'), line(A, 'AS', { agentId: 'sub1' }) + '\n');
    fs.writeFileSync(path.join(subDir, 'notes.jsonl'), line(A, 'AX') + '\n'); // not a subagent's transcript
    fs.symlinkSync(fb, path.join(subDir, 'agent-link.jsonl')); // a link: not followed
    fs.writeFileSync(fb, [userLine(B, SECRET.prompt), line(B, 'B1'), line(B, 'B2'), ''].join('\n'));
    // C: an early call, 34 MB of other lines, a late call.
    const filler = userLine(C, 'x'.repeat(1000)) + '\n';
    const fd = fs.openSync(fc, 'w');
    fs.writeSync(fd, line(C, 'C_early') + '\n');
    const chunk = filler.repeat(1024); // about 1 MB
    for (let i = 0; i < 34; i++) fs.writeSync(fd, chunk);
    fs.writeSync(fd, line(C, 'C_late') + '\n');
    fs.closeSync(fd);
    fs.writeFileSync(fo, line(OLD, 'O1') + '\n');
    const twoDays = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(fo, twoDays, twoDays);

    const t = Date.now();
    const res = await request(r.port, { path: '/sessions', headers: { origin: PAGE } });
    const answeredIn = Date.now() - t;
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.sessions.map(x => x.session).sort(), [A, B, C].sort());
    assert.equal(body.files, undefined, 'the transcript paths stay in the relay');
    assert.ok(answeredIn < 1000, `the scan answered in ${answeredIn} ms`);
    await sleep(3000);
    const usage = usageIn(s.items());
    assert.deepEqual(usage.map(u => u.request).sort(), ['req_A1', 'req_A2', 'req_AS', 'req_B1', 'req_B2', 'req_C_late'].sort());
    assert.equal(usage.find(u => u.request === 'req_AS').agent, 'sub1');
    // A second scan reads only what is new.
    fs.appendFileSync(fb, line(B, 'B3') + '\n');
    await request(r.port, { path: '/sessions', headers: { origin: PAGE } });
    await sleep(1500);
    assert.deepEqual(usageIn(s.items()).map(u => u.request).slice(usage.length), ['req_B3']);
    const text = s.text();
    for (const m of [SECRET.reply, SECRET.prompt, 'other-secret', enc(SECRET.path), config, TMP, '.jsonl', 'subagents', 'xxxxxxxxxx']) {
      assert.ok(!text.includes(m), `stream contains ${m}`);
    }
  } finally { s.close(); r.stop(); }
});
