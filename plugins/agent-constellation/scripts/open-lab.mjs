#!/usr/bin/env node
// /agent-constellation:open runs this, and only that command does: it makes sure the plugin's
// relay is running on 127.0.0.1:4318 (starting it as the plugin's hooks do), then opens the lab in
// your default browser with ?connect=claude-code, which connects the page to the relay on load.
// It prints one line saying what it did. Nothing opens a browser from a hook or on install.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureRelay } from '../relay/constellation-relay.mjs';

export const LAB_URL = 'https://diegobianqui.com/lab/constellation?connect=claude-code';
const DEFAULT_PORT = 4318;

/** The command that opens a URL in the default browser on this platform. */
export function opener(platform, url) {
  if (platform === 'darwin') return { command: 'open', args: [url], options: {} };
  // "start" is built into cmd; its first quoted argument is a window title, hence the "".
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', url], options: { windowsVerbatimArguments: true, windowsHide: true } };
  return { command: 'xdg-open', args: [url], options: {} };
}

/** Opens the URL; resolves to { ok, command } once the opener started (or failed to). */
export function openUrl(url, { platform = process.platform, spawn = nodeSpawn } = {}) {
  const { command, args, options } = opener(platform, url);
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true, ...options });
    } catch {
      resolve({ ok: false, command });
      return;
    }
    child.on('error', () => resolve({ ok: false, command }));
    child.on('spawn', () => { child.unref(); resolve({ ok: true, command }); });
  });
}

/** The one line for the user. */
export function summary(url, opened, relay, port) {
  const where = `port ${port}`;
  const v = relay.version ? ` ${relay.version}` : '';
  const state = relay.state === 'plugin' ? (relay.started ? `started the plugin's relay${v} on ${where}` : `the plugin's relay${v} is running on ${where}`)
    : relay.state === 'manual' ? `a relay started by hand${relay.version ? ` (version ${relay.version})` : ''} holds ${where}: the page will ask for its pairing code, or say how to stop it`
    : relay.state === 'other' ? `something other than the relay holds ${where}: the page will say no relay answers`
    : `the relay did not start on ${where} (it needs Node.js 18 or later)`;
  return opened.ok
    ? `Opened ${url} in your browser; ${state}.`
    : `Could not open a browser (${opened.command}): open ${url} yourself; ${state}.`;
}

async function main() {
  // For tests only, as for the plugin's hooks: another port, another page.
  const envPort = Number(process.env.CONSTELLATION_RELAY_PORT);
  const port = Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? envPort : DEFAULT_PORT;
  let url = LAB_URL;
  if (process.env.CONSTELLATION_LAB_URL) {
    try {
      const u = new URL(process.env.CONSTELLATION_LAB_URL);
      if (/^https?:$/.test(u.protocol)) url = u.href;
    } catch { /* keep the lab's own address */ }
  }
  const relay = await ensureRelay({ port });
  const opened = process.env.CONSTELLATION_OPEN_DRY_RUN === '1' ? { ok: true, command: opener(process.platform, url).command } : await openUrl(url);
  console.log(summary(url, opened, relay, port));
}

let isMain = false;
try { isMain = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { isMain = false; }
if (isMain) main();
