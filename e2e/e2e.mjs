#!/usr/bin/env node
// End-to-end test of the plugin with the real Claude Code CLI, as a user gets it: install from this
// checkout, validate, run real `claude -p` sessions that fire the plugin's hooks (no model, no
// account: a dummy API key and either a closed port or the stand-in API in mock-api.mjs), and check
// what reaches the relay. Runs on Linux, macOS and Windows (Git Bash or PowerShell). Used by
// e2e/docker/linux.sh and .github/workflows/test.yml; not part of `npm test`.
//
//   node e2e/e2e.mjs [--github] [--no-git-bash] [--report <file.json>]
//
// --github       also install from github.com/diegobianqui/agent-constellation (what users get)
// --no-git-bash  Windows only: hide Git Bash from Claude Code (PATH without Git, no
//                CLAUDE_CODE_GIT_BASH_PATH; CI also renames C:\Program Files\Git), so it runs hooks
//                and commands with PowerShell
// --powershell-tool  run the plugin's commands with the PowerShell tool when Claude Code offers it
//
// It needs port 4318 free (the plugin's hooks start their relay there): it refuses to run when
// anything listens on it, so it never touches a relay you are running. Everything else lives in a
// temp folder: HOME, CLAUDE_CONFIG_DIR, the project. Relays it started are stopped at the end.
// Needs `claude` on the PATH (or CLAUDE_BIN), Node.js 18+.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockApi, MOCK_USAGE } from './mock-api.mjs';
import { relayPids as pluginRelayPids } from '../test/processes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'agent-constellation');
const RELAY_FILE = path.join(PLUGIN, 'relay', 'constellation-relay.mjs');
const PORT = 4318;
const SITE = 'https://diegobianqui.com';
const LAB_URL = 'https://diegobianqui.com/lab/constellation?connect=claude-code';
const WIN = process.platform === 'win32';
const args = process.argv.slice(2);
const GITHUB = args.includes('--github');
const NO_GIT_BASH = args.includes('--no-git-bash');
// --powershell-tool: the stand-in model runs the commands with the PowerShell tool whenever Claude
// Code offers it (on Windows it does even with Git Bash, and may prefer it).
const PREFER_POWERSHELL = args.includes('--powershell-tool');
const REPORT = args.includes('--report') ? args[args.indexOf('--report') + 1] : process.env.E2E_REPORT;
const SECRET = 'PROMPT-SECRET-e2e-7f3a';
const RELAY_VERSION = (/const VERSION = '([^']+)'/.exec(fs.readFileSync(RELAY_FILE, 'utf8')) || [])[1];
const PLUGIN_VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
let current = 'setup';
function check(name, ok, detail = '', { info = false } = {}) {
  results.push({ step: current, name, ok: !!ok, info, detail: String(detail).slice(0, 2000) });
  console.log(`${ok ? 'ok  ' : info ? 'info' : 'FAIL'}  [${current}] ${name}${detail && (!ok || info) ? `\n      ${String(detail).slice(0, 1500).replace(/\n/g, '\n      ')}` : ''}`);
  return !!ok;
}
function step(name) { current = name; console.log(`\n== ${name}`); }

// ---------------------------------------------------------------- environment

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-e2e-')));
const HOME = path.join(TMP, 'home');
const PROJECT = path.join(TMP, 'project-e2e');
const STUBS = path.join(TMP, 'stubs');
const OPENED = path.join(TMP, 'opened.txt');
// What the stubbed opener recorded, once it has `n` lines (it runs detached: it may write a moment
// after the open script has exited).
const opened = async (n = 1) => (await waitFor(() => {
  const lines = fs.existsSync(OPENED) ? fs.readFileSync(OPENED, 'utf8').trim().split('\n').filter(Boolean) : [];
  return lines.length >= n ? lines : null;
}, 5000, 100)) || (fs.existsSync(OPENED) ? fs.readFileSync(OPENED, 'utf8').trim().split('\n').filter(Boolean) : []);
for (const d of [HOME, PROJECT, STUBS]) fs.mkdirSync(d, { recursive: true });

// The PATH Claude Code gets. --no-git-bash: without Git's folders, so Claude Code finds no Git Bash.
const PATH_KEY = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
let basePath = process.env[PATH_KEY] || '';
if (WIN && NO_GIT_BASH) basePath = basePath.split(';').filter(p => !/\\Git\\|\\Git$/i.test(p)).join(';');

// The opener, stubbed where it is a program on the PATH (xdg-open, open): it records its argument.
// On Windows the opener is cmd's built-in `start`, which no PATH entry can replace: there the test
// points the lab URL at a local server and checks the browser asks it for the page.
if (!WIN) {
  for (const name of ['xdg-open', 'open']) {
    const f = path.join(STUBS, name);
    fs.writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${OPENED}'\n`);
    fs.chmodSync(f, 0o755);
  }
}

function envFor(config, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE|CONSTELLATION_|OTEL_)/i.test(k)) continue;
    env[k] = v;
  }
  env[PATH_KEY] = WIN ? basePath : `${STUBS}:${basePath}`;
  Object.assign(env, {
    HOME, CLAUDE_CONFIG_DIR: config,
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    ANTHROPIC_API_KEY: 'sk-ant-e2e-dummy-key',
  }, extra);
  if (WIN) env.USERPROFILE = HOME;
  return env;
}

// Claude Code's own executable (on Windows, npm's claude.cmd stands in front of claude.exe).
function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const dirs = basePath.split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const n of WIN ? ['claude.exe'] : ['claude']) {
      const f = path.join(d, n);
      if (fs.existsSync(f)) return f;
    }
    if (WIN && fs.existsSync(path.join(d, 'claude.cmd'))) {
      const exe = path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

// Git Bash on Windows (not the WSL launcher C:\Windows\System32\bash.exe, which may come first on
// the PATH): <Git>\bin\bash.exe, next to the git on the PATH.
function gitBash() {
  if (!WIN) return 'bash';
  if (NO_GIT_BASH) return null;
  const roots = new Set(['C:\\Program Files\\Git']);
  for (const d of basePath.split(';')) {
    const m = /^(.*\\Git)\\(cmd|bin|usr\\bin|mingw64\\bin)\\?$/i.exec(d);
    if (m) roots.add(m[1]);
  }
  for (const r of roots) { const b = path.join(r, 'bin', 'bash.exe'); if (fs.existsSync(b)) return b; }
  return null;
}

function run(cmd, argv, { env, cwd = PROJECT, timeout = 120000, input } = {}) {
  const r = spawnSync(cmd, argv, { env, cwd, encoding: 'utf8', timeout, input, windowsHide: true });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), error: r.error };
}

// ---------------------------------------------------------------- the relay, seen as the page sees it

function get(p, headers = {}, { ms = 2000, stream = false } = {}) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, headers: { host: `127.0.0.1:${PORT}`, ...headers } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      const finish = () => { resolve({ status: res.statusCode, headers: res.headers, body }); req.destroy(); };
      if (stream) setTimeout(finish, 800); else res.on('end', finish);
    });
    req.setTimeout(ms, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', err => resolve({ status: 0, error: err.code || String(err) }));
  });
}
async function health() {
  const r = await get('/health', { origin: SITE });
  try { return r.status === 200 ? JSON.parse(r.body) : null; } catch { return null; }
}
async function events() {
  const r = await get('/events', { origin: SITE }, { stream: true });
  const text = r.body || '';
  return { text, items: text.split('\n\n').filter(b => b.startsWith('data: {"path"')).map(b => { try { return JSON.parse(b.slice(6)); } catch { return null; } }).filter(Boolean) };
}
async function waitFor(fn, ms, every = 500) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > until) return v;
    await sleep(every);
  }
}
const portFree = () => new Promise(resolve => {
  const s = net.createServer().once('error', () => resolve(false)).listen(PORT, '127.0.0.1', () => s.close(() => resolve(true)));
});

// The relays in plugin mode on the port (in a container or on a CI runner: the ones this test started).
const relayPids = () => pluginRelayPids(PORT).map(pid => ({ pid, cmd: `pid ${pid}` }));
async function stopRelays() {
  for (const { pid } of relayPids()) { try { process.kill(pid); } catch { /* gone */ } }
  return waitFor(async () => (await get('/health', { origin: SITE }, { ms: 500 })).status === 0, 10000, 250);
}

// A `claude -p` session. Stops it after `ms`, or as soon as `until()` says so.
function session(prompt, { config, extraEnv = {}, ms = 120000, until } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(CLAUDE, ['-p', prompt], { cwd: PROJECT, env: envFor(config, extraEnv), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '', done = false, killed = false;
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const kill = () => { if (!done) { killed = true; if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); else child.kill('SIGKILL'); } };
    const timer = setTimeout(kill, ms);
    let poll;
    if (until) poll = setInterval(async () => { if (!done && await until()) { clearInterval(poll); kill(); } }, 500);
    child.on('error', e => { err += String(e); });
    child.on('close', code => {
      done = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve({ code, out: out.trim(), err: err.trim(), killed, ms: Date.now() - t0 });
    });
  });
}

// The shell command of a skill, as Claude Code shows it to the model (the plugin root filled in).
function skillCommands(name) {
  const md = fs.readFileSync(path.join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8');
  return [...md.matchAll(/^\s+- '?Bash\((.+)\)'?$/gm)].map(m => m[1].replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PLUGIN));
}

// ---------------------------------------------------------------- the run

const CLAUDE = claudeBin();
const CONFIG = path.join(TMP, 'config');
fs.mkdirSync(CONFIG, { recursive: true });

async function main() {
  step('environment');
  console.log(`platform ${process.platform} ${process.arch}, node ${process.version}, plugin ${PLUGIN_VERSION}, relay ${RELAY_VERSION}`);
  console.log(`checkout ${ROOT}\ntemp ${TMP}${WIN ? `\nGit Bash ${NO_GIT_BASH ? 'hidden' : 'allowed'}` : ''}`);
  if (!check('claude found', CLAUDE, `PATH=${basePath}`)) return;
  const v = run(CLAUDE, ['--version'], { env: envFor(CONFIG) });
  check('claude --version', v.code === 0, v.out + v.err);
  console.log(v.out);
  if (!check(`port ${PORT} is free (nothing of yours is touched)`, await portFree(), 'Something listens on 4318: stop it or run this in a container or CI.')) return;

  // 1. Install from this checkout.
  step('install');
  const env = envFor(CONFIG);
  const add = run(CLAUDE, ['plugin', 'marketplace', 'add', ROOT], { env });
  check('marketplace add <checkout>', add.code === 0 && /Successfully added marketplace: agent-constellation/.test(add.out), add.out + add.err);
  const inst = run(CLAUDE, ['plugin', 'install', 'agent-constellation@agent-constellation'], { env });
  check('plugin install', inst.code === 0 && /Successfully installed plugin: agent-constellation@agent-constellation/.test(inst.out), inst.out + inst.err);
  const list = run(CLAUDE, ['plugin', 'list'], { env });
  check(`plugin list: ${PLUGIN_VERSION}, enabled`, list.code === 0 && list.out.includes(`Version: ${PLUGIN_VERSION}`) && /enabled/.test(list.out), list.out + list.err);
  const settings = JSON.parse(fs.readFileSync(path.join(CONFIG, 'settings.json'), 'utf8'));
  check('enabled in the temp config only', settings.enabledPlugins && settings.enabledPlugins['agent-constellation@agent-constellation'] === true, JSON.stringify(settings));

  // 2. Validate.
  step('validate');
  for (const [what, dir] of [['marketplace', ROOT], ['plugin', PLUGIN]]) {
    const r = run(CLAUDE, ['plugin', 'validate', '--strict', dir], { env });
    check(`validate --strict ${what}`, r.code === 0 && /Validation passed/.test(r.out + r.err), r.out + r.err);
  }

  // 3. A session with no model (closed port): the hooks fire, the relay starts.
  step('session: hooks, relay start (no model)');
  const closed = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const before = Date.now();
  const s1 = await session(`hi ${SECRET}`, {
    config: CONFIG, ms: 150000, extraEnv: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${closed}`, CLAUDE_CODE_MAX_RETRIES: '1' },
    until: async () => { const h = await health(); return h && h.counts && h.counts.hooks >= 2; },
  });
  console.log(`claude -p ran ${s1.ms} ms (${s1.killed ? 'stopped after the hooks fired' : `exit ${s1.code}`})`);
  const h1 = await waitFor(health, 15000);
  check('relay answers on 4318', h1, `claude stdout: ${s1.out}\nstderr: ${s1.err}`);
  if (h1) {
    check(`relay mode plugin, version ${RELAY_VERSION}`, h1.mode === 'plugin' && h1.version === RELAY_VERSION, JSON.stringify(h1));
    check('SessionStart and UserPromptSubmit reached it (counts.hooks >= 2)', h1.counts.hooks >= 2, JSON.stringify(h1.counts));
    check('hooks came from the plugin (--via plugin)', h1.hooksVia && h1.hooksVia.plugin >= before - 5000, JSON.stringify(h1.hooksVia));
  }
  const pids = relayPids();
  check('one relay process, from this checkout, in plugin mode', pids.length === 1, pids.map(p => `${p.pid} ${p.cmd}`).join('\n') || 'none found');
  await sleep(1500);
  check('the relay outlives the session that started it (detached)', await health(), 'no answer after claude stopped');
  // CORS: the lab's origins only.
  const ok = await get('/health', { origin: SITE });
  check('GET /health, Origin https://diegobianqui.com: 200 + CORS header', ok.status === 200 && ok.headers['access-control-allow-origin'] === SITE, `${ok.status} ${JSON.stringify(ok.headers || {})}`);
  const www = await get('/health', { origin: 'https://www.diegobianqui.com' });
  check('GET /health, Origin https://www.diegobianqui.com: 200', www.status === 200 && www.headers['access-control-allow-origin'] === 'https://www.diegobianqui.com', String(www.status));
  for (const origin of ['https://evil.example', 'http://diegobianqui.com', undefined]) {
    const r = await get('/health', origin ? { origin } : {});
    check(`GET /health, ${origin ? `Origin ${origin}` : 'no Origin'}: 403, no CORS header`, r.status === 403 && !r.headers['access-control-allow-origin'], `${r.status} ${r.body}`);
  }
  const ev1 = await events();
  const names = ev1.items.filter(i => i.path === '/hook').map(i => i.body.hook_event_name);
  check('/events: SessionStart and UserPromptSubmit', names.includes('SessionStart') && names.includes('UserPromptSubmit'), names.join(' '));
  check('/events: project folder name only', ev1.items.some(i => i.body.project === 'project-e2e') && !ev1.text.includes(TMP) && !ev1.text.includes(TMP.replace(/\\/g, '\\\\')), ev1.text.slice(0, 600));
  check('/events: no text from the prompt', !ev1.text.includes(SECRET) && !ev1.text.includes('"prompt"'), ev1.text.slice(0, 600));

  // 4 and 5. The plugin's commands, run by Claude Code through its shell tool, as a model would
  // (the stand-in API copies the command out of the skill). Token numbers from the transcript.
  step('commands through Claude Code (stand-in API)');
  const mock = await startMockApi({ prefer: PREFER_POWERSHELL ? 'PowerShell' : null, log: c => console.log(`  api #${c.id}: shell tools offered: ${c.shells.join(', ') || 'none'}${c.tool ? `; calls ${c.tool}` : ''}${c.command ? `, runs: ${c.command}` : ''}${c.toolResult ? `, result${c.toolResult.isError ? ' (error)' : ''}: ${c.toolResult.text.split('\n')[0].slice(0, 160)}` : ''}`) });
  const browser = await new Promise(resolve => {
    // Windows: the page the browser should open (the lab URL pointed here, with an & in it).
    const hits = [];
    const srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>e2e</title>ok'); });
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, hits, close: () => srv.close() }));
  });
  const labUrl = WIN ? `http://127.0.0.1:${browser.port}/lab/constellation?connect=claude-code&e2e=1` : LAB_URL;
  const apiEnv = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`, ...(WIN ? { CONSTELLATION_LAB_URL: labUrl } : {}) };
  const toolRuns = [];
  async function skill(prompt, expectCommand, expectOut) {
    const from = mock.calls.length;
    const r = await session(prompt, { config: CONFIG, extraEnv: apiEnv, ms: 120000 });
    const calls = mock.calls.slice(from);
    const ran = calls.find(c => c.command);
    const result = calls.find(c => c.toolResult);
    toolRuns.push(ran && ran.tool);
    check(`${prompt}: Claude Code offered a shell tool (${ran ? ran.tool : 'none'})`, ran, `claude exit ${r.code}: ${r.out}\n${r.err}`);
    if (!ran) return null;
    // Claude Code fills in the plugin root with forward slashes on Windows (D:/a/...).
    const want = WIN ? expectCommand.replace(/\\/g, '/') : expectCommand;
    check(`${prompt}: the command from the skill`, ran.command === want, `${ran.command}\nexpected ${want}`);
    // Claude Code may add a note of its own after the command's output ("Shell cwd was reset ...").
    const output = result ? result.toolResult.text.replace(/\n+Shell cwd was reset to .*$/, '') : '';
    check(`${prompt}: allowed and run without asking, output as expected`, result && !result.toolResult.isError && expectOut.test(output), result ? result.toolResult.text : `no tool result; claude: ${r.out} ${r.err}`);
    return output;
  }
  const [cmdOpen] = skillCommands('open');
  const [cmdOn, cmdOff, cmdStatus] = skillCommands('telemetry');
  const [cmdRemove] = skillCommands('remove-manual-hooks');
  fs.rmSync(OPENED, { force: true });
  await skill('/agent-constellation:open', cmdOpen, /^Opened .* in your browser; the plugin's relay .* is running on port 4318\.$/);
  if (!WIN) { const l = await opened(1); check('open: the opener got the lab URL', l.length === 1 && l[0] === LAB_URL, l.join('\n') || 'opener not called'); }
  await skill('/agent-constellation:telemetry', cmdStatus, /Telemetry: +off[\s\S]*Relay on port 4318: the plugin's relay/);
  await skill('/agent-constellation:telemetry on', cmdOn, /Updated [\s\S]*OTEL_EXPORTER_OTLP_ENDPOINT=http:\/\/127\.0\.0\.1:4318/);
  const sOn = JSON.parse(fs.readFileSync(path.join(CONFIG, 'settings.json'), 'utf8'));
  check('telemetry on: in the temp settings', sOn.env && sOn.env.OTEL_EXPORTER_OTLP_ENDPOINT === 'http://127.0.0.1:4318', JSON.stringify(sOn.env));
  // A session with telemetry on: its OTLP events reach the relay too.
  const otelBefore = ((await health()) || { counts: {} }).counts.logs || 0;
  await session('hello', { config: CONFIG, extraEnv: apiEnv, ms: 60000 });
  const otel = await waitFor(async () => { const h = await health(); return h && h.counts.logs > otelBefore ? h : null; }, 8000);
  check('telemetry on: a new session\'s OpenTelemetry reaches the relay', otel, JSON.stringify(((await health()) || {}).counts), { info: true });
  await skill('/agent-constellation:telemetry off', cmdOff, /Updated [\s\S]*telemetry settings/);
  const sOff = JSON.parse(fs.readFileSync(path.join(CONFIG, 'settings.json'), 'utf8'));
  check('telemetry off: gone from the temp settings', !sOff.env || !sOff.env.OTEL_EXPORTER_OTLP_ENDPOINT, JSON.stringify(sOff.env));
  // Manual hooks (setup without the plugin) next to the plugin's, then the command that removes them.
  const manual = run(process.execPath, [RELAY_FILE, 'setup', '--no-telemetry'], { env: envFor(CONFIG) });
  check('setup --no-telemetry adds manual hooks (temp settings)', manual.code === 0 && /background hooks/.test(manual.out), manual.out + manual.err);
  const dupBefore = ((await health()) || { counts: {} }).counts.duplicates || 0;
  await skill('/agent-constellation:remove-manual-hooks', cmdRemove, /Updated [\s\S]*hooks/);
  const h2 = await health();
  check('manual hooks fired too, and the relay dropped their copies (counts.duplicates)', h2 && h2.counts.duplicates > dupBefore && h2.hooksVia.settings > 0, JSON.stringify(h2 && { counts: h2.counts, hooksVia: h2.hooksVia }));
  const sRm = JSON.parse(fs.readFileSync(path.join(CONFIG, 'settings.json'), 'utf8'));
  check('remove-manual-hooks: none left in the temp settings', !JSON.stringify(sRm.hooks || {}).includes('constellation-relay'), JSON.stringify(sRm.hooks));

  step('token numbers from the transcript');
  const usage = await waitFor(async () => {
    const ev = await events();
    const recs = [];
    for (const it of ev.items) {
      if (it.path !== '/v1/logs') continue;
      for (const rl of it.body.resourceLogs || []) for (const sl of rl.scopeLogs || []) for (const lr of sl.logRecords || []) {
        const a = Object.fromEntries((lr.attributes || []).map(kv => [kv.key, kv.value.stringValue ?? kv.value.intValue]));
        if (a['usage.source'] === 'transcript') recs.push(a);
      }
    }
    return recs.length ? { recs, text: ev.text } : null;
  }, 10000);
  check('api_request records read from the sessions\' transcripts', usage, 'none in /events');
  if (usage) {
    const r = usage.recs[0];
    check(`the stand-in API's numbers: in ${MOCK_USAGE.input_tokens}, out ${MOCK_USAGE.output_tokens}, cache read ${MOCK_USAGE.cache_read_input_tokens}, cache write ${MOCK_USAGE.cache_creation_input_tokens}`,
      usage.recs.every(x => Number(x.input_tokens) === MOCK_USAGE.input_tokens && Number(x.output_tokens) === MOCK_USAGE.output_tokens && Number(x.cache_read_tokens) === MOCK_USAGE.cache_read_input_tokens && Number(x.cache_creation_tokens) === MOCK_USAGE.cache_creation_input_tokens),
      JSON.stringify(r));
    check('request ids from the API kept', usage.recs.every(x => /^req_e2e_\d+$/.test(x.request_id)), usage.recs.map(x => x.request_id).join(' '));
    check('no transcript path or text in the stream', !usage.text.includes('.jsonl') && !usage.text.includes('Done.') && !usage.text.includes(SECRET), '');
  }
  mock.close();

  // 5. The open script by itself: starts the relay when none runs, then finds it.
  step('open-lab.mjs');
  check('relays stopped', await stopRelays(), relayPids().map(p => p.cmd).join('\n'));
  fs.rmSync(OPENED, { force: true });
  const openEnv = envFor(CONFIG, WIN ? { CONSTELLATION_LAB_URL: labUrl } : {});
  const o1 = run(process.execPath, [path.join(PLUGIN, 'scripts', 'open-lab.mjs')], { env: openEnv, timeout: 30000 });
  check('no relay: starts it, opens the lab', o1.code === 0 && /^Opened .* in your browser; started the plugin's relay .* on port 4318\.$/.test(o1.out), o1.out + o1.err);
  const o2 = run(process.execPath, [path.join(PLUGIN, 'scripts', 'open-lab.mjs')], { env: openEnv, timeout: 30000 });
  check('relay running: finds it', o2.code === 0 && /^Opened .* in your browser; the plugin's relay .* is running on port 4318\.$/.test(o2.out), o2.out + o2.err);
  if (WIN) {
    const hit = await waitFor(() => browser.hits.find(u => u.includes('connect=claude-code') && u.includes('e2e=1')), 30000);
    check('start opened the default browser at the lab URL, & included', hit, `requests seen: ${browser.hits.join(' ') || 'none'}`, { info: !hit });
  } else {
    const lines = await opened(2);
    check(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} called with the lab URL, twice`, lines.length === 2 && lines.every(l => l === LAB_URL), lines.join('\n') || 'not called');
  }
  browser.close();
  // Where no opener works: one line with the address.
  if (!WIN) {
    const noOpener = run(process.execPath, [path.join(PLUGIN, 'scripts', 'open-lab.mjs')], { env: { ...openEnv, [PATH_KEY]: path.dirname(process.execPath) }, timeout: 30000 });
    check('no opener on the PATH: says so, with the address', noOpener.code === 0 && /^Could not open a browser \((xdg-open|open)\): open https:\/\/diegobianqui\.com\/lab\/constellation\?connect=claude-code yourself; /.test(noOpener.out), noOpener.out + noOpener.err);
  }

  // The skills' commands typed in each shell on this computer (as a user could), with the plugin
  // root filled in as Claude Code fills it in.
  step('the commands in each shell');
  const shells = [];
  const bash = gitBash();
  if (bash && run(bash, ['-c', 'exit 0'], { env: envFor(CONFIG) }).code === 0) shells.push(['bash', c => [bash, ['-c', c]]]);
  for (const ps of WIN ? ['pwsh', 'powershell'] : ['pwsh']) {
    if (run(ps, ['-NoProfile', '-Command', 'exit 0'], { env: envFor(CONFIG) }).code === 0) shells.push([ps, c => [ps, ['-NoProfile', '-Command', c]]]);
  }
  for (const [shell, wrap] of shells) {
    const r = run(...wrap(cmdStatus), { env: envFor(CONFIG) });
    check(`${shell}: ${cmdStatus.replace(PLUGIN, '<plugin>')}`, r.code === 0 && /Relay on port 4318: the plugin's relay/.test(r.out), r.out + r.err);
  }

  // 6. The desktop app's install message's command (README).
  step('install message command');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  const command = readme.split('\n').find(l => l.startsWith('C="$(command -v claude') && l.includes('plugin install'));
  const shell = process.platform === 'darwin' ? '/bin/zsh' : gitBash();
  if (!shell) {
    check('needs Bash (Git Bash): the README says to use the two claude plugin commands instead', true, 'skipped without Git Bash', { info: true });
  } else if (!check('README has the install command', command)) { /* nothing to run */ } else {
    const offline = command.replace('marketplace add diegobianqui/agent-constellation', `marketplace add '${ROOT.replace(/\\/g, '/')}'`);
    const cfg2 = path.join(TMP, 'config-message');
    fs.mkdirSync(cfg2, { recursive: true });
    // No claude on the PATH: every folder holding one left out.
    const noClaude = basePath.split(path.delimiter).filter(d => !['claude', 'claude.exe', 'claude.cmd'].some(n => fs.existsSync(path.join(d, n)))).join(path.delimiter);
    const r0 = run(shell, ['-c', offline], { env: { ...envFor(cfg2), [PATH_KEY]: noClaude } });
    check('no claude anywhere: the "wasn\'t found" line, exit 1', r0.code === 1 && r0.out === "Claude Code's command wasn't found on this computer: install Claude Code for the terminal (code.claude.com/docs/en/setup), then send this message again.", `${r0.code} ${r0.out} ${r0.err}`);
    const r1 = run(shell, ['-c', offline], { env: envFor(cfg2) });
    check('claude on the PATH: installs, one line', r1.code === 0 && /installed plugin: agent-constellation@agent-constellation/i.test(r1.out) && r1.out.split('\n').length === 1, `${r1.code} ${r1.out} ${r1.err}`);
    const r2 = run(shell, ['-c', offline], { env: envFor(cfg2) });
    check('twice: harmless ("already installed")', r2.code === 0 && /already installed/.test(r2.out), `${r2.code} ${r2.out} ${r2.err}`);
    if (GITHUB) {
      const cfg3 = path.join(TMP, 'config-message-github');
      fs.mkdirSync(cfg3, { recursive: true });
      const r3 = run(shell, ['-c', command], { env: envFor(cfg3) });
      check('the message as printed, from GitHub: installs', r3.code === 0 && /installed plugin: agent-constellation@agent-constellation/i.test(r3.out), `${r3.code} ${r3.out} ${r3.err}`);
    }
  }

  if (GITHUB) {
    step('install from GitHub');
    const cfg = path.join(TMP, 'config-github');
    fs.mkdirSync(cfg, { recursive: true });
    const genv = envFor(cfg);
    const a = run(CLAUDE, ['plugin', 'marketplace', 'add', 'diegobianqui/agent-constellation'], { env: genv });
    check('marketplace add diegobianqui/agent-constellation', a.code === 0, a.out + a.err);
    const i = run(CLAUDE, ['plugin', 'install', 'agent-constellation@agent-constellation'], { env: genv });
    check('plugin install', i.code === 0 && /Successfully installed/.test(i.out), i.out + i.err);
    const l = run(CLAUDE, ['plugin', 'list'], { env: genv });
    check('plugin list', l.code === 0 && /agent-constellation@agent-constellation/.test(l.out), l.out + l.err);
    console.log(l.out.split('\n').filter(x => /Version|Read from/.test(x)).join('\n'));
  }

  step('summary');
  const shellTools = [...new Set(toolRuns.filter(Boolean))];
  const offered = [...new Set(mock.calls.flatMap(c => c.shells))];
  console.log(`Shell tools Claude Code offered: ${offered.join(', ') || 'none'}; the commands ran with: ${shellTools.join(', ') || 'none'}`);
  results.push({ step: 'summary', name: `shell tools offered: ${offered.join(', ') || 'none'}; commands ran with: ${shellTools.join(', ') || 'none'}`, ok: true, info: true, detail: '' });
}

let crashed = null;
try { await main(); } catch (err) { crashed = err; check('the test itself ran to the end', false, err && err.stack); }
try { await stopRelays(); } catch { /* best effort */ }
const failed = results.filter(r => !r.ok && !r.info);
console.log(`\n${results.filter(r => r.ok && !r.info).length} passed, ${failed.length} failed, ${results.filter(r => r.info).length} info`);
const meta = { platform: process.platform, arch: process.arch, node: process.version, gitBash: WIN ? !NO_GIT_BASH : null, powershellTool: PREFER_POWERSHELL, plugin: PLUGIN_VERSION, relay: RELAY_VERSION };
if (REPORT) fs.writeFileSync(REPORT, JSON.stringify({ ...meta, results }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map(r => `| ${r.ok ? (r.info ? 'info' : 'pass') : r.info ? 'info' : '**FAIL**'} | ${r.step} | ${r.name.replace(/\|/g, '\\|')} | ${r.ok && !r.info ? '' : r.detail.split('\n')[0].replace(/\|/g, '\\|').slice(0, 200)} |`);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### e2e: ${meta.platform} ${meta.arch}, node ${meta.node}${WIN ? `, Git Bash ${NO_GIT_BASH ? 'hidden' : 'present'}` : ''}${PREFER_POWERSHELL ? ', PowerShell tool' : ''}\n\n| | step | check | detail |\n|---|---|---|---|\n${rows.join('\n')}\n\n`);
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment longer */ }
process.exit(failed.length || crashed ? 1 : 0);
