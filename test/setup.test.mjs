// Tests for the plugin's commands and what they run: telemetry on and off through setup (and only
// telemetry), removing the hooks setup added, setup's output in each situation, the relay's answer
// to the lab page (no pairing code, in either mode), what an older relay started by hand looks
// like, and dropping the second copy of each event when the hooks are
// installed twice.
//   node --test test/
// Never touches your real Claude Code configuration: HOME and CLAUDE_CONFIG_DIR point at a temp
// folder, setup always gets --settings <temp file>, and every relay runs on a free port other than
// 4318 (setup asks the port it is given for /health).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relayPids } from './processes.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugins', 'agent-constellation');
const RELAY = path.join(PLUGIN, 'relay', 'constellation-relay.mjs');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-setup-test-')));
const DEAD_PORT = 4397; // nothing listens here
const ENV = { PATH: process.env.PATH, HOME: TMP, CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'), CONSTELLATION_RELAY_PORT: String(DEAD_PORT) };
const SITE = 'https://diegobianqui.com';

const children = new Set();
after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function run(args, { relay = RELAY, env = ENV, input } = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [relay, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.on('close', code => { clearTimeout(kill); resolve({ code, out, err }); });
    p.stdin.end(input);
  });
}

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

// A settings file in its own folder (so backups can be counted), written as setup writes JSON.
let n = 0;
function settingsFile(name, content) {
  const dir = path.join(TMP, `${name}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'settings.json');
  if (content !== undefined) fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  return {
    f,
    raw: () => fs.readFileSync(f, 'utf8'),
    read: () => JSON.parse(fs.readFileSync(f, 'utf8')),
    backups: () => fs.readdirSync(dir).filter(x => x.startsWith('settings.json.backup-')).length,
  };
}

// A user's own settings: other env, other hooks on the same events.
const USER = {
  model: 'opus',
  env: { FOO: 'bar', OTEL_METRIC_EXPORT_INTERVAL: '60000' },
  permissions: { allow: ['Bash(npm test)'] },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [] },
};
const ourHooks = s => Object.values(s.hooks || {}).flat().flatMap(g => g.hooks || []).filter(h => /constellation-relay\.mjs"? hook /.test(h.command));

// A relay of its own on a free port: plugin mode or by hand. `extra`: more arguments (an older
// relay by hand gets its pairing code with --code, as it was tested then).
async function startRelay({ plugin = true, relay = RELAY, extra = [] } = {}) {
  const port = await freePort();
  const args = plugin ? [relay, '--plugin', '--port', String(port), ...extra] : [relay, '--port', String(port), ...extra];
  const child = spawn(process.execPath, args, { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', d => { out += d; if (/plugin mode|is running on/.test(out)) resolve(); });
    child.on('exit', c => reject(new Error(`relay exited ${c}: ${out}`)));
  });
  return { port, stop: () => child.kill('SIGTERM') };
}

// An older relay from this repository's history: by default as the plugin 1.0 shipped it (relay
// 1.2); plugin 1.2 shipped relay 1.4 (the last one with a pairing code).
function oldRelay(commit = 'fa35268', version = '1.2.0') {
  try {
    const src = execFileSync('git', ['-C', ROOT, 'show', `${commit}:plugins/agent-constellation/relay/constellation-relay.mjs`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const f = path.join(TMP, `old-${version}`, 'constellation-relay.mjs');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, src);
    return src.includes(`const VERSION = '${version}'`) ? f : null;
  } catch { return null; }
}

// ------------------------------------------------------------ the plugin's commands

test('the commands: user-invoked skills that run exactly the commands they pre-approve', () => {
  for (const [name, commands] of [
    ['telemetry', ['setup --no-hooks --plugin', 'setup --remove --no-hooks --plugin', 'status --plugin']],
    ['remove-manual-hooks', ['setup --remove --no-telemetry --plugin']],
  ]) {
    const md = fs.readFileSync(path.join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8');
    const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
    assert.match(front, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(front, /^disable-model-invocation: true$/m, `${name}: Claude never runs it on its own`);
    assert.match(front, /^description: .{20,}/m);
    // The same commands for the Bash tool and the PowerShell tool (Windows: Claude Code may run
    // commands with either), and nothing else.
    const allowed = [...front.matchAll(/^ {2}- '(.+)'$/gm)].map(m => m[1]);
    const run = c => `node "\${CLAUDE_PLUGIN_ROOT}/relay/constellation-relay.mjs" ${c}`;
    assert.deepEqual(allowed, [...commands.map(c => `Bash(${run(c)})`), ...commands.map(c => `PowerShell(${run(c)})`)], `${name}: allowed-tools`);
    for (const c of commands) assert.ok(body.includes('`' + run(c) + '`'), `${name}: body names ${c}`);
    // Nothing that would add hooks, force an endpoint or touch anything else.
    assert.ok(!/setup --plugin|--force --plugin|rm |curl /.test(body.replace(/--force`? themselves/, '')), `${name}: no other commands`);
  }
});

// ------------------------------------------------------------ telemetry on and off

test('telemetry on/off (setup --no-hooks / --remove --no-hooks) round-trips the file exactly and leaves hooks alone', async () => {
  const s = settingsFile('telemetry', USER);
  const original = s.raw();
  // The user also has the hooks setup adds (from an earlier manual setup).
  assert.equal((await run(['setup', '--no-telemetry', '--settings', s.f])).code, 0);
  const withHooks = s.raw();
  const hooksBefore = JSON.stringify(s.read().hooks);
  assert.equal(ourHooks(s.read()).length, 16);

  const on = await run(['setup', '--no-hooks', '--plugin', '--settings', s.f]);
  assert.equal(on.code, 0, on.err);
  const after = s.read();
  assert.equal(after.env.OTEL_EXPORTER_OTLP_ENDPOINT, `http://127.0.0.1:${DEAD_PORT}`);
  assert.equal(after.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(after.env.FOO, 'bar');
  assert.equal(JSON.stringify(after.hooks), hooksBefore, 'hooks untouched by telemetry on');
  assert.match(on.out, /\+ env OTEL_EXPORTER_OTLP_ENDPOINT=/);
  assert.doesNotMatch(on.out, /hooks run this file|background hooks/);

  const off = await run(['setup', '--remove', '--no-hooks', '--plugin', '--settings', s.f]);
  assert.equal(off.code, 0, off.err);
  assert.equal(s.raw(), withHooks, 'telemetry off puts the file back byte for byte, hooks included');
  assert.match(off.out, /- 8 telemetry settings/);
  assert.doesNotMatch(off.out, /- \d+ hooks/);
  assert.match(off.out, /hooks setup added are still there.*\/agent-constellation:remove-manual-hooks/);

  // Off again: nothing to do, nothing written.
  const backups = s.backups();
  const again = await run(['setup', '--remove', '--no-hooks', '--plugin', '--settings', s.f]);
  assert.match(again.out, /Nothing to remove: .* has no telemetry that setup turned on/);
  assert.equal(s.backups(), backups);

  // Remove the manual hooks (the other command): back to the user's own file.
  const rm = await run(['setup', '--remove', '--no-telemetry', '--plugin', '--settings', s.f]);
  assert.equal(rm.code, 0, rm.err);
  assert.match(rm.out, /- 16 hooks/);
  assert.match(rm.out, /The plugin's own hooks stay/);
  assert.equal(s.raw(), original);
});

test('telemetry on twice: "Already set; nothing changed", no new backup', async () => {
  for (const content of [USER, undefined, '']) {
    const s = settingsFile('idempotent', content);
    assert.equal((await run(['setup', '--no-hooks', '--plugin', '--settings', s.f])).code, 0);
    const raw = s.raw();
    const backups = s.backups();
    const again = await run(['setup', '--no-hooks', '--plugin', '--settings', s.f]);
    assert.equal(again.code, 0);
    assert.match(again.out, /Already set; nothing changed in /);
    assert.doesNotMatch(again.out, /Updated|Backup saved/);
    assert.equal(s.raw(), raw);
    assert.equal(s.backups(), backups, 'no backup for a run that changes nothing');
    assert.equal((await run(['setup', '--remove', '--no-hooks', '--plugin', '--settings', s.f])).code, 0);
    if (content === USER) assert.deepEqual(s.read(), USER);
    else assert.deepEqual(s.read(), {});
  }
  // The same for a full manual setup run twice.
  const m = settingsFile('idempotent-full', USER);
  await run(['setup', '--settings', m.f]);
  const raw = m.raw();
  const backups = m.backups();
  assert.match((await run(['setup', '--settings', m.f])).out, /Already set; nothing changed/);
  assert.equal(m.raw(), raw);
  assert.equal(m.backups(), backups);
  // A changed port is a change: the endpoint and the hooks move, in place, and the old values aren't kept.
  const moved = await run(['setup', '--settings', m.f, '--port', '4396']);
  assert.match(moved.out, /OTEL_EXPORTER_OTLP_ENDPOINT=http:\/\/127\.0\.0\.1:4396/);
  assert.equal(ourHooks(m.read()).length, 16);
  assert.ok(ourHooks(m.read()).every(h => h.command.endsWith('hook --via settings http://127.0.0.1:4396/hook')));
  assert.equal((await run(['setup', '--settings', m.f, '--remove'])).code, 0);
  assert.deepEqual(m.read(), USER);
});

test('telemetry on keeps a foreign endpoint unless forced; off puts it back', async () => {
  const foreign = { ...USER, env: { ...USER.env, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.corp.example' } };
  // An endpoint with a credential in it: only its host is ever shown.
  const secret = settingsFile('foreign-secret', { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user:SECRETPW@otel.corp.example:4318/v1?token=SECRETTOKEN' } });
  const rs = await run(['setup', '--no-hooks', '--settings', secret.f]);
  assert.equal(rs.code, 1);
  assert.match(rs.err, /already send telemetry to otel\.corp\.example:4318\./);
  assert.doesNotMatch(rs.out + rs.err, /SECRET/);
  const st = await run(['status', '--settings', secret.f]);
  assert.match(st.out, /Telemetry: +on, to otel\.corp\.example:4318 \(not the relay/);
  assert.doesNotMatch(st.out + st.err, /SECRET/);
  // Shell variables: named, never shown.
  const sh = settingsFile('shell-env', {});
  const rsh = await run(['setup', '--no-hooks', '--settings', sh.f], { env: { ...ENV, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://u:SHELLSECRET@elsewhere.example', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://SHELLSECRET2@x.example' } });
  assert.equal(rsh.code, 0, rsh.err);
  assert.match(rsh.err, /your shell exports OTEL_EXPORTER_OTLP_ENDPOINT\./);
  assert.match(rsh.err, /your shell exports OTEL_EXPORTER_OTLP_LOGS_ENDPOINT\./);
  assert.doesNotMatch(rsh.out + rsh.err, /SECRET/);
  const s = settingsFile('foreign', foreign);
  const raw = s.raw();
  const r = await run(['setup', '--no-hooks', '--plugin', '--settings', s.f]);
  assert.equal(r.code, 1);
  assert.match(r.err, /already send telemetry to otel\.corp\.example\./);
  assert.equal(s.raw(), raw);
  assert.equal(s.backups(), 0);
  assert.equal((await run(['setup', '--no-hooks', '--force', '--settings', s.f])).code, 0);
  assert.match((await run(['setup', '--no-hooks', '--plugin', '--settings', s.f])).out, /Already set/);
  assert.equal((await run(['setup', '--remove', '--no-hooks', '--plugin', '--settings', s.f])).code, 0);
  assert.equal(s.raw(), raw);
});

test('setup --plugin never adds hooks (the plugin sends them itself)', async () => {
  const s = settingsFile('plugin-hooks', USER);
  const raw = s.raw();
  const r = await run(['setup', '--plugin', '--settings', s.f]);
  assert.equal(r.code, 1);
  assert.match(r.err, /The plugin sends the hook events itself/);
  assert.equal(s.raw(), raw);
});

test('a settings file from relay 1.2 setup: telemetry and hooks come off separately', async t => {
  const old = oldRelay();
  if (!old) return t.skip('relay 1.2 not in this checkout\'s history');
  const s = settingsFile('from-1.2', USER);
  const original = s.raw();
  assert.equal((await run(['setup', '--settings', s.f, '--port', String(DEAD_PORT)], { relay: old })).code, 0);
  assert.equal(ourHooks(s.read()).length, 16);
  // Telemetry off with the new relay: the old hooks stay.
  assert.equal((await run(['setup', '--remove', '--no-hooks', '--plugin', '--settings', s.f])).code, 0);
  assert.equal(ourHooks(s.read()).length, 16);
  assert.equal(s.read().env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  // Then the hooks.
  assert.equal((await run(['setup', '--remove', '--no-telemetry', '--plugin', '--settings', s.f])).code, 0);
  assert.equal(s.raw(), original);
});

// ------------------------------------------------------------ setup's output in each situation

test('setup output: no "Start the relay" when one answers, no hooks line without hooks', async () => {
  // A plugin-mode relay answers on the port.
  const p = await startRelay({ plugin: true });
  try {
    const s = settingsFile('out-plugin', {});
    const r = await run(['setup', '--no-hooks', '--plugin', '--settings', s.f, '--port', String(p.port)]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`The plugin's relay 1\\.5\\.1 is running on port ${p.port}: telemetry goes to it\\.`));
    assert.doesNotMatch(r.out, /Start the relay/);
    assert.doesNotMatch(r.out, /hooks run this file/);
    assert.match(r.out, /1\. Start a new Claude Code session/);
    assert.match(r.out, /To undo: {2}\/agent-constellation:telemetry off/);
    // The same from the downloaded file, without --plugin.
    const d = settingsFile('out-plugin-cli', {});
    const r2 = await run(['setup', '--no-hooks', '--settings', d.f, '--port', String(p.port)]);
    assert.match(r2.out, /The plugin's relay 1\.5\.1 is running/);
    assert.doesNotMatch(r2.out, /Start the relay|hooks run this file/);
    assert.match(r2.out, /To undo: {2}node constellation-relay\.mjs setup --remove --no-hooks/);
    // Status says what runs there.
    const st = await run(['status', '--plugin', '--settings', s.f, '--port', String(p.port)]);
    assert.match(st.out, /Telemetry: +on, to the relay/);
    assert.match(st.out, /Hooks that setup added: none/);
    assert.match(st.out, new RegExp(`Relay on port ${p.port}: the plugin's relay, version 1\\.5\\.1`));
  } finally { p.stop(); }

  // A relay started by hand answers.
  const m = await startRelay({ plugin: false });
  try {
    const s = settingsFile('out-manual', {});
    const r = await run(['setup', '--settings', s.f, '--port', String(m.port)]);
    assert.match(r.out, /A relay started by hand \(version 1\.5\.1\) is running on port \d+: telemetry goes to it\./);
    assert.doesNotMatch(r.out, /Start the relay/);
    assert.match(r.out, /16 background hooks/);
    assert.match(r.out, /The hooks run this file from where it is now/);
    const st = await run(['status', '--settings', s.f, '--port', String(m.port)]);
    assert.match(st.out, new RegExp(`Relay on port ${m.port}: a relay started by hand, version 1\\.5\\.1\n`));
    assert.doesNotMatch(st.out, /pairing|code/i);
    assert.match(st.out, /Hooks that setup added: 16/);
  } finally { m.stop(); }

  // Nothing answers: with the plugin, the plugin starts it; without, start it by hand.
  const a = settingsFile('out-none-plugin', {});
  const r = await run(['setup', '--no-hooks', '--plugin', '--settings', a.f]);
  assert.match(r.out, /The plugin starts its relay on port \d+ when a session starts\./);
  assert.doesNotMatch(r.out, /Start the relay|hooks run this file/);
  const b = settingsFile('out-none', {});
  const r2 = await run(['setup', '--settings', b.f]);
  assert.match(r2.out, /1\. Start the relay: {2}node constellation-relay\.mjs --port 4397/);
  assert.match(r2.out, /2\. Start a new Claude Code session/);
  assert.match(r2.out, /The hooks run this file/);
  const r3 = await run(['setup', '--settings', b.f]);
  assert.match(r3.out, /Already set; nothing changed/);
  assert.match(r3.out, /Next: Start the relay/);

  // Something else holds the port.
  const other = net.createServer(sock => sock.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')).listen(0, '127.0.0.1');
  await new Promise(x => other.on('listening', x));
  const c = settingsFile('out-other', {});
  const r4 = await run(['setup', '--no-hooks', '--settings', c.f, '--port', String(other.address().port)]);
  assert.match(r4.out, /Something other than the relay answers on port/);
  other.close();
});

// ------------------------------------------------------------ older relays that ask for a code

test('an older relay (1.4) started by hand: setup and status say the lab can\'t connect, and how to stop it', async t => {
  const old = oldRelay('7b59653', '1.4.0');
  if (!old) return t.skip('relay 1.4 not in this checkout\'s history');
  const m = await startRelay({ plugin: false, relay: old, extra: ['--code', 'TESTCODE'] });
  try {
    // What the lab page sees: 401, with the version.
    const res = await request(m.port, { path: '/health', headers: { origin: SITE } });
    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.body).version, '1.4.0');
    const s = settingsFile('out-old', {});
    const r = await run(['setup', '--no-hooks', '--settings', s.f, '--port', String(m.port)]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`An older relay started by hand \\(version 1\\.4\\.0\\) is running on port ${m.port}: telemetry goes to it\\.`));
    assert.match(r.out, new RegExp(`The lab can't connect to it: stop it \\(lsof -nP -iTCP:${m.port} -sTCP:LISTEN shows its PID; then kill <PID>\\)`));
    assert.doesNotMatch(r.out, /Start the relay/);
    const st = await run(['status', '--port', String(m.port), '--settings', s.f]);
    assert.match(st.out, /an older relay started by hand \(version 1\.4\.0\); the lab can't connect to it: stop it/);
  } finally { m.stop(); }
});

test('an older relay (1.2) answers 401 without a version: status says so', async t => {
  const old = oldRelay();
  if (!old) return t.skip('relay 1.2 not in this checkout\'s history');
  const m = await startRelay({ plugin: false, relay: old, extra: ['--code', 'TESTCODE'] });
  try {
    const res = await request(m.port, { path: '/health', headers: { origin: SITE } });
    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.body).version, undefined);
    const st = await run(['status', '--port', String(m.port), '--settings', settingsFile('old-status', {}).f]);
    assert.match(st.out, /an older relay started by hand \(version 1\.2 or earlier\); the lab can't connect to it/);
  } finally { m.stop(); }
});

// ------------------------------------------------------------ hooks installed twice

function forward(port, via, payload) {
  return new Promise(resolve => {
    const args = [RELAY, 'hook', ...(via ? ['--via', via] : []), `http://127.0.0.1:${port}/hook`];
    const p = spawn(process.execPath, args, { env: ENV, stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('close', resolve);
    p.stdin.end(JSON.stringify(payload));
  });
}
const post = (port, payload, ts) => request(port, { method: 'POST', path: '/hook', headers: { 'content-type': 'application/json', 'x-hook-ts': String(ts) }, body: JSON.stringify(payload) });
const health = async port => JSON.parse((await request(port, { path: '/health', headers: { origin: SITE } })).body);
function streamItems(port) {
  return new Promise(resolve => {
    let text = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}`, origin: SITE } }, res => {
      res.setEncoding('utf8');
      res.on('data', d => {
        text += d;
        if (text.includes('event: ready')) { res.destroy(); resolve(text.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)))); }
      });
    });
    req.on('error', () => resolve([]));
  });
}

test('hooks installed twice: one copy of each event passes, /health says so', async () => {
  const r = await startRelay({ plugin: true });
  try {
    const session = 'twice-1111';
    const events = [
      { hook_event_name: 'SessionStart', session_id: session, source: 'startup' },
      { hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'PROMPT-SECRET' },
      { hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_use_id: 'tu1' },
      { hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Read', tool_use_id: 'tu2' },
      { hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Bash', tool_use_id: 'tu1' },
      { hook_event_name: 'SubagentStart', session_id: session, agent_id: 'ag1', agent_type: 'Explore' },
      { hook_event_name: 'Stop', session_id: session },
    ];
    // Each event through both kinds of hooks at once, as Claude Code runs them: the plugin's
    // (--via plugin) and setup's, half of them from an older setup that doesn't say --via.
    for (const [i, e] of events.entries()) {
      await Promise.all([forward(r.port, 'plugin', e), forward(r.port, i % 2 ? 'settings' : null, e)]);
    }
    await sleep(200);
    const h = await health(r.port);
    assert.equal(h.duplicateHooks, true);
    assert.equal(h.counts.hooks, events.length);
    assert.equal(h.counts.duplicates, events.length);
    assert.ok(h.hooksVia.plugin > 0 && h.hooksVia.settings > 0);
    const items = (await streamItems(r.port)).filter(i => i.path === '/hook');
    assert.deepEqual(items.map(i => [i.body.hook_event_name, i.body.tool_use_id || i.body.agent_id || '']), events.map(e => [e.hook_event_name, e.tool_use_id || e.agent_id || '']));
    assert.ok(items.every(i => i.body.via === undefined), 'the kind is not passed on');
  } finally { r.stop(); }
});

test('hooks installed once: nothing is dropped, even the same event twice', async () => {
  for (const via of ['plugin', 'settings', null]) {
    const r = await startRelay({ plugin: true });
    try {
      const e = { hook_event_name: 'Stop', session_id: `once-${via}` };
      // The same event twice in a row from one kind of hooks (two turns that end at once).
      await Promise.all([forward(r.port, via, e), forward(r.port, via, e)]);
      await forward(r.port, via, { hook_event_name: 'Notification', session_id: `once-${via}`, notification_type: 'idle_prompt' });
      await sleep(200);
      const h = await health(r.port);
      assert.equal(h.counts.hooks, 3, `via ${via}`);
      assert.equal(h.counts.duplicates, 0);
      assert.equal(h.duplicateHooks, false);
    } finally { r.stop(); }
  }
});

test('hooks installed twice: copies are paired by session, ids and a 5 s window', async () => {
  const r = await startRelay({ plugin: true });
  try {
    const t0 = Date.now();
    const e = { hook_event_name: 'Stop', session_id: 'win-1' };
    // Two genuine Stops, each arriving twice in any order: two pass.
    await post(r.port, { ...e, via: 'settings' }, t0);
    await post(r.port, { ...e, via: 'settings' }, t0 + 50);
    await post(r.port, { ...e, via: 'plugin' }, t0 + 10);
    await post(r.port, { ...e, via: 'plugin' }, t0 + 60);
    // The other kind, but more than 5 s apart (by when the hook ran): a separate event.
    await post(r.port, { ...e, via: 'plugin' }, t0 + 9000);
    // Another session, another tool use or another agent: never paired.
    await post(r.port, { ...e, session_id: 'win-2', via: 'settings' }, t0);
    await post(r.port, { hook_event_name: 'PreToolUse', session_id: 'win-1', tool_use_id: 'a', via: 'plugin' }, t0);
    await post(r.port, { hook_event_name: 'PreToolUse', session_id: 'win-1', tool_use_id: 'b', via: 'settings' }, t0);
    await post(r.port, { hook_event_name: 'SubagentStop', session_id: 'win-1', agent_id: 'x', via: 'plugin' }, t0);
    await post(r.port, { hook_event_name: 'SubagentStop', session_id: 'win-1', agent_id: 'y', via: 'settings' }, t0);
    await sleep(200);
    const h = await health(r.port);
    assert.equal(h.counts.duplicates, 2);
    assert.equal(h.counts.hooks, 8);
  } finally { r.stop(); }
});

// ------------------------------------------------------------ /agent-constellation:open

const OPEN = path.join(PLUGIN, 'scripts', 'open-lab.mjs');

test('open: a user-invoked skill that runs only the open script', () => {
  const md = fs.readFileSync(path.join(PLUGIN, 'skills', 'open', 'SKILL.md'), 'utf8');
  const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
  assert.match(front, /^name: open$/m);
  assert.match(front, /^disable-model-invocation: true$/m);
  const cmd = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/open-lab.mjs"';
  assert.deepEqual([...front.matchAll(/^ {2}- '(.+)'$/gm)].map(m => m[1]), [`Bash(${cmd})`, `PowerShell(${cmd})`]);
  assert.ok(body.includes('`' + cmd + '`'));
  // No hook opens anything: the hooks only run the forwarder.
  const hooks = fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8');
  assert.ok(!hooks.includes('open-lab'));
});

test('open: the right opener per platform, through spawn (stubbed: nothing opens)', async () => {
  const { opener, openUrl, summary, LAB_URL } = await import(pathToFileURL(OPEN).href);
  assert.equal(LAB_URL, 'https://diegobianqui.com/lab/constellation?connect=claude-code');
  assert.deepEqual(opener('darwin', LAB_URL), { command: 'open', args: [LAB_URL], options: {} });
  assert.deepEqual(opener('linux', LAB_URL), { command: 'xdg-open', args: [LAB_URL], options: {} });
  assert.deepEqual(opener('freebsd', LAB_URL).command, 'xdg-open');
  const win = opener('win32', LAB_URL);
  assert.deepEqual([win.command, win.args], ['cmd', ['/c', 'start', '""', `"${LAB_URL}"`]]);
  assert.equal(win.options.windowsVerbatimArguments, true);
  // cmd's command line: the URL is one quoted word, so an & in it starts no other command.
  const amp = opener('win32', 'http://localhost:3314/lab/constellation?connect=claude-code&x=1');
  assert.equal(['cmd', ...amp.args].join(' '), 'cmd /c start "" "http://localhost:3314/lab/constellation?connect=claude-code&x=1"');

  const calls = [];
  const fake = (ok) => (command, args, options) => {
    calls.push({ command, args, options });
    const listeners = {};
    const child = { on: (e, f) => { listeners[e] = f; return child; }, unref() { child.unrefd = true; } };
    setTimeout(() => (ok ? listeners.spawn() : listeners.error(new Error('ENOENT'))), 5);
    return child;
  };
  for (const [platform, command] of [['darwin', 'open'], ['linux', 'xdg-open'], ['win32', 'cmd']]) {
    const r = await openUrl(LAB_URL, { platform, spawn: fake(true) });
    assert.deepEqual(r, { ok: true, command });
    const c = calls.at(-1);
    assert.equal(c.command, command);
    assert.ok(c.args.some(a => a.replace(/^"|"$/g, '') === LAB_URL));
    assert.equal(c.options.detached, true);
    assert.equal(c.options.stdio, 'ignore');
  }
  assert.deepEqual(await openUrl(LAB_URL, { platform: 'linux', spawn: fake(false) }), { ok: false, command: 'xdg-open' });

  assert.equal(summary(LAB_URL, { ok: true }, { state: 'plugin', version: '1.5.0', started: true }, 4318),
    `Opened ${LAB_URL} in your browser; started the plugin's relay 1.5.0 on port 4318.`);
  assert.equal(summary(LAB_URL, { ok: true }, { state: 'manual', version: '1.5.0', started: false }, 4318),
    `Opened ${LAB_URL} in your browser; a relay started by hand (version 1.5.0) is running on port 4318.`);
  assert.equal(summary(LAB_URL, { ok: true }, { state: 'old', version: '1.4.0', started: false }, 4318),
    `Opened ${LAB_URL} in your browser; an older relay started by hand (version 1.4.0) holds port 4318: the page will say how to stop it.`);
  assert.match(summary(LAB_URL, { ok: true }, { state: 'old', version: null }, 4318), /an older relay started by hand \(version 1\.2 or earlier\) holds port 4318/);
  for (const state of ['plugin', 'manual', 'old', 'other', 'none']) assert.doesNotMatch(summary(LAB_URL, { ok: true }, { state, version: null }, 4318).replace(LAB_URL, ''), /pairing|code\b/i);
  assert.match(summary(LAB_URL, { ok: false, command: 'xdg-open' }, { state: 'none' }, 4318), /^Could not open a browser \(xdg-open\): open .* yourself; the relay did not start/);
});

test('open: starts the relay when none runs, finds it when it does (browser not opened)', async () => {
  const port = await freePort();
  const env = { ...ENV, CONSTELLATION_RELAY_PORT: String(port), CONSTELLATION_OPEN_DRY_RUN: '1', CONSTELLATION_LAB_URL: 'http://localhost:3314/lab/constellation?connect=claude-code' };
  const first = await run([], { relay: OPEN, env });
  assert.equal(first.code, 0, first.err);
  assert.equal(first.out.trim().split('\n').length, 1, 'one line');
  assert.match(first.out, new RegExp(`^Opened http://localhost:3314/lab/constellation\\?connect=claude-code in your browser; started the plugin's relay 1\\.5\\.1 on port ${port}\\.`));
  try {
    const again = await run([], { relay: OPEN, env });
    assert.match(again.out, new RegExp(`the plugin's relay 1\\.5\\.1 is running on port ${port}\\.`));
    const h = await health(port);
    assert.equal(h.mode, 'plugin');
  } finally {
    for (const pid of relayPids(port)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
  }
});

// ------------------------------------------------------------ Windows and Linux (platform injected)

test('hooks on Windows: a --start hook waits long enough to see a refused connection', async () => {
  const { hookTimes } = await import(pathToFileURL(RELAY).href);
  assert.deepEqual(hookTimes('darwin', true), { total: 2000, request: 1500 });
  assert.deepEqual(hookTimes('linux', true), { total: 2000, request: 1500 });
  assert.deepEqual(hookTimes('win32', false), { total: 2000, request: 1500 });
  const win = hookTimes('win32', true);
  assert.ok(win.request >= 4000 && win.total > win.request, 'Windows refuses a closed loopback port after about 2 s of retries');
});

test('hooks.json: the same command line works in sh, Git Bash and PowerShell', () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  for (const [event, groups] of Object.entries(hooks)) {
    for (const h of groups.flatMap(g => g.hooks)) {
      // A bare `node` first (PowerShell would print a quoted path instead of running it), the
      // placeholder quoted (paths with spaces), and nothing shell-specific: no pipes, redirects,
      // `&&`, `$VAR` or backslashes.
      assert.match(h.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/relay\/constellation-relay\.mjs" hook( --start)? --via plugin$/, event);
      assert.equal(h.shell, undefined, `${event}: the default shell (Git Bash, or PowerShell without it)`);
    }
  }
});

test('the hooks setup adds: a command line that runs in sh, Git Bash and PowerShell', async () => {
  const { manualHookCommand } = await import(pathToFileURL(RELAY).href);
  // macOS and Linux: Node's absolute path (the desktop app may have no node on its PATH).
  assert.equal(manualHookCommand('darwin', '/opt/homebrew/bin/node', '/Users/ana/relay/constellation-relay.mjs', 'http://127.0.0.1:4318'),
    '"/opt/homebrew/bin/node" "/Users/ana/relay/constellation-relay.mjs" hook --via settings http://127.0.0.1:4318/hook');
  // Windows: a bare node first (PowerShell would print a quoted path instead of running it) and
  // forward slashes (the same file in Git Bash and PowerShell).
  const win = manualHookCommand('win32', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Ana Lopez\\relay\\constellation-relay.mjs', 'http://127.0.0.1:4318');
  assert.equal(win, 'node "C:/Users/Ana Lopez/relay/constellation-relay.mjs" hook --via settings http://127.0.0.1:4318/hook');
  assert.match(win, /constellation-relay\.mjs"? hook /, 'found again by setup --remove');
});

test('transcript paths as Claude Code writes them on Windows: read; anything else ignored', async () => {
  const { transcriptTargets } = await import(pathToFileURL(RELAY).href);
  const W = path.win32;
  const main = 'C:\\Users\\Ana\\.claude\\projects\\C--Users-Ana-site\\sess-1.jsonl';
  assert.deepEqual(transcriptTargets({ session_id: 'sess-1', transcript_path: main }, W), [{ file: main, session: 'sess-1' }]);
  // Forward slashes (Git Bash) come out as the same file.
  assert.deepEqual(transcriptTargets({ session_id: 'sess-1', transcript_path: main.replace(/\\/g, '/') }, W), [{ file: main, session: 'sess-1' }]);
  // A subagent's transcript, next to the session's.
  assert.deepEqual(transcriptTargets({ session_id: 'sess-1', agent_id: 'a1', transcript_path: main }, W).map(t => t.file),
    [main, 'C:\\Users\\Ana\\.claude\\projects\\C--Users-Ana-site\\sess-1\\subagents\\agent-a1.jsonl']);
  for (const bad of ['C:\\Users\\Ana\\secrets\\sess-1.jsonl', 'sess-1.jsonl', '..\\projects\\sess-1.jsonl', 'C:\\Users\\Ana\\.claude\\projects\\x\\other.jsonl']) {
    assert.deepEqual(transcriptTargets({ session_id: 'sess-1', transcript_path: bad }, W), [], bad);
  }
});

test('the plugin reads environment variables only by their literal names', () => {
  // A computed name (process.env[x]) or a whole copy of the environment could pick up any
  // credential the user has set; the plugin needs none.
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(mjs|js|json|md|sh)$/.test(e.name)) files.push(f); } };
  walk(PLUGIN);
  assert.ok(files.length > 5);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /process\.env\s*\[/, `${path.relative(PLUGIN, f)}: process.env[…]`);
    assert.doesNotMatch(src, /\.\.\.\s*process\.env\b|Object\.(keys|entries|values|assign)\(\s*process\.env\b|for\s*\(.*\bin\s+process\.env\b/, `${path.relative(PLUGIN, f)}: copies or walks process.env`);
  }
});

test('no download-and-run text in the plugin folder', () => {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (!/\.png$/.test(e.name)) files.push(f); } };
  walk(PLUGIN);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /\bcurl\b|\bwget\b|\|\s*(ba)?sh\b|\biex\b|\birm\b|https?:\/\/\S+\.(mjs|js|sh|ps1)\b/i, path.relative(PLUGIN, f));
  }
});

test('the icon: a square PNG at the directory\'s path, named in plugin.json', () => {
  const icon = path.join(PLUGIN, '.claude-plugin', 'icon.png');
  const png = fs.readFileSync(icon);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  assert.equal(w, h);
  assert.ok(w >= 512 && w <= 2048, `${w} px`);
  assert.ok(png.length < 2 * 1024 * 1024);
  assert.equal(JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).icon, './.claude-plugin/icon.png');
});
