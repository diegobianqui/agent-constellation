// The desktop app's install and update messages (README.md, and the lab's Connect dialog): each
// carries one exact shell command. These run that command as the README prints it, with the
// marketplace pointed at this checkout (offline), in a temp HOME and CLAUDE_CONFIG_DIR, with a
// PATH that has node but no `claude`: Claude Code's command is found where the desktop app keeps
// its copy. Never touches your real Claude Code configuration.
//   node --test test/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-install-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// The messages: the README's ```` blocks. The command: the line that starts with C=.
const messages = [...README.matchAll(/^````\n([\s\S]*?)\n````$/gm)].map(m => m[1]);
const commandOf = msg => msg.split('\n').find(l => l.startsWith('C="$(command -v claude'));
const install = messages.find(m => m.startsWith('Install the agent-constellation plugin'));
const update = messages.find(m => m.startsWith('Update the agent-constellation plugin'));

// The real Claude Code command, to stand in for the desktop app's copy. Without it, the tests that
// install are skipped.
let realClaude = null;
try { realClaude = fs.realpathSync(execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim()); } catch { realClaude = null; }
const SHELL = fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';
const noNode = !['/usr/bin/node', '/bin/node'].some(f => fs.existsSync(f));

function sandbox(name, { desktopCopy = true } = {}) {
  const home = path.join(TMP, name, 'home');
  const config = path.join(TMP, name, 'config');
  const bin = path.join(TMP, name, 'bin');
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  if (desktopCopy && realClaude) {
    const dir = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code', '2.1.300', 'a1b2c3', 'claude.app', 'Contents', 'MacOS');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(realClaude, path.join(dir, 'claude'));
  } else fs.mkdirSync(home, { recursive: true });
  return { home, config, bin };
}

function run(command, box, PATH) {
  const offline = command.replace('marketplace add diegobianqui/agent-constellation', `marketplace add '${ROOT}'`);
  const r = spawnSync(SHELL, ['-c', offline], {
    encoding: 'utf8', timeout: 120000,
    env: { HOME: box.home, CLAUDE_CONFIG_DIR: box.config, PATH, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('the README has both messages, each with one exact command and the same instructions', () => {
  assert.ok(install && update, 'install and update messages');
  for (const m of [install, update]) {
    assert.match(m, /Run this exact command once with Bash and nothing else/);
    assert.match(m, /Don't search for files or run other checks first\./);
    assert.match(m, /If the line is an error, show it and stop\./);
    assert.equal(m.split('\n').filter(l => l.startsWith('C=')).length, 1);
  }
  assert.match(install, /"Start a new session, then run \/agent-constellation:open\."/);
  assert.match(commandOf(install), /plugin marketplace add diegobianqui\/agent-constellation >\/dev\/null && "\$C" plugin install agent-constellation@agent-constellation 2>&1 \| tail -1$/);
  assert.match(commandOf(update), /plugin marketplace update agent-constellation >\/dev\/null && "\$C" plugin update agent-constellation@agent-constellation 2>&1 \| tail -1$/);
  // The part that finds Claude Code's command and checks Node.js is the same in both.
  const head = c => c.slice(0, c.indexOf('"$C" plugin'));
  assert.equal(head(commandOf(install)), head(commandOf(update)));
});

test('install: no claude on the PATH, the desktop app\'s copy found; twice is harmless; update', { skip: !realClaude && 'no claude command here' }, () => {
  const box = sandbox('install');
  const PATH = `${box.bin}:/usr/bin:/bin`;
  assert.notEqual(spawnSync(SHELL, ['-c', 'command -v claude'], { env: { PATH } }).status, 0, 'no claude on this PATH');
  const first = run(commandOf(install), box, PATH);
  assert.equal(first.code, 0, first.out + first.err);
  assert.match(first.out, /installed plugin: agent-constellation@agent-constellation/i);
  assert.equal(first.out.split('\n').length, 1, 'one line');
  const second = run(commandOf(install), box, PATH);
  assert.equal(second.code, 0, second.out + second.err);
  assert.match(second.out, /already installed/);
  // Installed in the temp config, nowhere else.
  const settings = JSON.parse(fs.readFileSync(path.join(box.config, 'settings.json'), 'utf8'));
  assert.equal(settings.enabledPlugins['agent-constellation@agent-constellation'], true);
  // The update message, on the same install (the marketplace is this checkout).
  const up = run(commandOf(update), box, PATH);
  assert.equal(up.code, 0, up.out + up.err);
  assert.match(up.out, /already at the latest version|updated from/);
});

test('install: Node.js missing, one plain line and exit 1', { skip: (!realClaude && 'no claude command here') || (!noNode && 'node in /usr/bin') }, () => {
  const box = sandbox('no-node');
  const r = run(commandOf(install), box, '/usr/bin:/bin');
  assert.equal(r.code, 1);
  assert.equal(r.out, 'The plugin needs Node.js 18 or newer: nodejs.org');
  assert.ok(!fs.existsSync(path.join(box.config, 'plugins')), 'nothing installed');
});

test('install: no Claude Code command anywhere, one plain line and exit 1', () => {
  const box = sandbox('no-claude', { desktopCopy: false });
  const r = run(commandOf(install), box, `${box.bin}:/usr/bin:/bin`);
  assert.equal(r.code, 1);
  assert.equal(r.out, "Claude Code's command wasn't found on this computer: install Claude Code for the terminal (code.claude.com/docs/en/setup), then send this message again.");
});
