#!/usr/bin/env node
/*
 * Constellation relay: shows your own Claude Code sessions in the agent constellation lab
 * (https://diegobianqui.com/lab/constellation), privately.
 *
 * Read this file before you run it. It is one file, needs Node.js 18 or later, and has no
 * dependencies. What it does:
 *
 *   1. It listens on 127.0.0.1 (this computer only) for what Claude Code sends when telemetry
 *      and hooks are turned on: OpenTelemetry (OTLP/HTTP, JSON) and hook payloads.
 *   2. Before it keeps or passes on anything, it strips the text and the identity out: prompts,
 *      replies, commands, file paths, tool inputs and outputs, error messages, email, account
 *      and organization ids. What is left is the shape of the activity: which agents and tools
 *      ran, when, for how long, whether they failed, which model and how many tokens. Two names
 *      pass too, so you can tell your sessions apart: the project folder's name (never its
 *      path) and the session's title. Start it with --no-names to drop them as well.
 *   3. It streams that to the lab page open in your browser, and only to it: the page has to
 *      present the pairing code printed when the relay starts, and only the lab's own origin
 *      may read the stream.
 *   4. Token counts without telemetry: when a hook event names the session's transcript (the
 *      JSONL file Claude Code keeps on this computer), or "Scan sessions" on the page finds it,
 *      the relay reads the new lines of that file locally and keeps only numbers from them:
 *      input, output and cache tokens, the model and the request id of each model call (and,
 *      when set, fast mode and US-only inference, which change the price). Never the text, never
 *      the file's path. For a session whose telemetry reaches the relay, its telemetry counts
 *      each call and the transcript only fills in calls from before it started (each call once).
 *
 * Nothing is sent to diegobianqui.com or to any other server. The page talks to this relay from
 * your browser, over your computer's loopback interface. The relay keeps the last events in
 * memory only (nothing on disk) and forgets them when you stop it.
 *
 * Plugin mode (--plugin): the agent-constellation Claude Code plugin starts the relay this way
 * from its hooks, in the background, when no relay is running yet. There is no pairing code:
 * only the lab's own origin may read the stream (exact CORS match, and a request without an
 * Origin header is refused), so other websites can't read it. Programs running on this computer
 * as you could read it, as they could already read the transcripts themselves. It exits by
 * itself after 30 minutes with no hook events and no page connected.
 *
 * This file, as served at https://diegobianqui.com/relay/constellation-relay.mjs, is the source.
 * The plugin (github.com/diegobianqui/agent-constellation) ships a byte-for-byte copy of it,
 * updated with that repository's scripts/sync-relay.mjs.
 *
 * Commands
 *   node constellation-relay.mjs                start the relay (prints a pairing code)
 *   node constellation-relay.mjs --no-names     the same, without project folder names and session titles
 *   node constellation-relay.mjs setup          point Claude Code at the relay (settings.json): telemetry and hooks
 *   node constellation-relay.mjs setup --no-hooks
 *                                               telemetry only (with the plugin, which sends the hook events)
 *   node constellation-relay.mjs setup --remove undo exactly what setup added (--no-hooks: telemetry
 *                                               only; --no-telemetry: hooks only)
 *   node constellation-relay.mjs status         what setup set, and what answers on the relay's port
 *   node constellation-relay.mjs hook <url>     used by the hooks that setup adds, not by you
 *   node constellation-relay.mjs hook --start   used by the plugin's hooks: also starts the relay
 *                                               in plugin mode if nothing listens on its port
 *   node constellation-relay.mjs --help
 *
 * Hooks installed twice (the plugin's and the ones setup added): each copy says where it comes
 * from (--via plugin or --via settings; hooks from an older setup say nothing and count as
 * settings). When both kinds send the same event for the same session within a few seconds, the
 * relay passes on one copy and drops the other, and /health tells the page so it can say how to
 * remove the manual ones.
 *
 * Endpoints (all on http://127.0.0.1:<port>)
 *   POST /v1/traces /v1/logs /v1/metrics   from Claude Code: OTLP/HTTP, JSON (gzip or deflate)
 *   POST /hook                             from the hook forwarder: one hook payload
 *   GET  /health                           to the page: { ok, version, mode, counts, lastSeen,
 *                                          duplicateHooks }
 *   GET  /events                           to the page: Server-Sent Events, one stripped
 *                                          payload per message, as { path, body, ts }
 *   GET  /sessions                         to the page: the Claude Code sessions on this computer
 *                                          from the last 24 hours (id, project folder name, last
 *                                          active), from the file names and times in
 *                                          ~/.claude/projects. Afterwards the relay reads those
 *                                          sessions' token numbers, as in 4, and streams them.
 *   The page's requests need "Authorization: Bearer <pairing code>" (in plugin mode: an allowed
 *   Origin instead).
 */

import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.4.0';
const SELF = fileURLToPath(import.meta.url);
const DEFAULT_PORT = 4318;
// For tests only: the plugin's hooks use this port, and pass these extra page origins to the
// relay they start (comma-separated), when set in the environment Claude Code runs in.
const ENV_PORT = 'CONSTELLATION_RELAY_PORT';
const ENV_ORIGINS = 'CONSTELLATION_RELAY_ORIGINS';

// The only web pages allowed to read the stream. Add one with --origin (for local development).
const SITE_ORIGINS = ['https://diegobianqui.com', 'https://www.diegobianqui.com'];

const BUFFER_MAX = 2000;          // stripped payloads kept in memory for a page that connects later
const OTLP_MAX_BYTES = 8 << 20;   // per request, after decompression
const HOOK_MAX_BYTES = 1 << 20;
const MAX_VIEWERS = 4;
const KEEPALIVE_MS = 15000;
const SCAN_WINDOW_MS = 24 * 3600 * 1000; // /sessions: transcripts changed in the last 24 hours
const SCAN_ACTIVE_MS = 2 * 60 * 1000;    // ...and "active now": changed in the last 2 minutes
const SCAN_MAX = 50;
const SCAN_SUBAGENTS_MAX = 20;           // ...and per session, its most recent subagent transcripts
const IDLE_MS = 30 * 60 * 1000;          // plugin mode: exit after this long with no hooks and no page
// Hooks installed twice: two copies of one event (same event, session, tool use, agent and task)
// from the two kinds of hooks, stamped within DUP_MS of each other, are one event. /health says
// so for TWICE_MS after the last such pair.
const DUP_MS = 5000;
const TWICE_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- command line

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';
const flag = name => argv.includes(name);
function opt(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
function opts(name) {
  const out = [];
  argv.forEach((a, i) => { if (a === name && i + 1 < argv.length) out.push(argv[i + 1]); });
  return out;
}
function portArg() {
  // CONSTELLATION_RELAY_PORT: for tests only, as for the plugin's hooks.
  const raw = opt('--port') ?? (process.env[ENV_PORT] || String(DEFAULT_PORT));
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`--port must be a number from 1 to 65535 (got ${raw}).`);
  return n;
}
function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

const HELP = `
Constellation relay ${VERSION}: watch your own Claude Code sessions in
https://diegobianqui.com/lab/constellation. Runs on this computer only.

  node constellation-relay.mjs [--port 4318] [--origin <url>] [--no-names]
      Start the relay. It prints a pairing code: open the lab, click "Connect Claude Code"
      (or Connections, then Claude Code) and paste it. Then start a new Claude Code session.
      --origin adds a web page allowed to read the stream (e.g. a local copy of the site).
      --no-names drops project folder names and session titles: the page shows short ids.

  node constellation-relay.mjs setup [options]
      Point Claude Code on this computer at the relay by editing ~/.claude/settings.json
      (or $CLAUDE_CONFIG_DIR/settings.json). A backup is saved first and everything else in
      the file is kept.
      --port <n>        relay port (default 4318); start the relay with the same --port
      --print           show what would change, change nothing
      --remove          take out exactly what setup added
      --force           replace an OpenTelemetry endpoint that points somewhere else
      --no-hooks        telemetry only: hooks in the file are left as they are
                        (with --remove: take out the telemetry settings only)
      --no-telemetry    hooks only: telemetry settings are left as they are
                        (with --remove: take out the hooks only)
      --settings <file> edit another settings file
      Running it again with nothing to change changes nothing and saves no backup.

  node constellation-relay.mjs status [--port 4318] [--settings <file>]
      What setup set in the settings file (telemetry, hooks) and what answers on the relay's port.

  node constellation-relay.mjs hook [--via plugin|settings] <url>
      The background hook that setup installs: reads one hook payload on stdin, strips it and
      posts it to the relay. Silent, at most about 2 seconds, always exits 0.
      --start   if nothing listens on the relay's port, start the relay in plugin mode first
                (used by the agent-constellation Claude Code plugin)
      --via     which hooks run it: the plugin's or the ones setup added to settings.json.
                The relay uses it to drop the second copy when both are installed.

  node constellation-relay.mjs --plugin [--port 4318] [--origin <url>] [--no-names]
      The relay as the plugin starts it: no pairing code (only the lab's own origin may read
      the stream), quiet, and it exits by itself after 30 minutes with no hook events and no
      page connected. If the port is taken, it exits without a word.

What reaches the page: event names, ids, agent and tool names, timings, success flags, model
names and token counts, and (unless --no-names) each session's project folder name and title.
Never prompts, replies, commands, paths, tool inputs or outputs, error messages, email or
account ids. Nothing goes to any server.
Token counts come from telemetry or, without it, from the session transcripts on this computer:
the relay reads the new lines of a transcript when a hook event names it (or a scan finds it)
and keeps only the token numbers, the model name and the request id of each model call.
"Scan sessions" on the page lists your sessions from the last 24 hours from the file names and
times in ~/.claude/projects, then reads those sessions' token numbers the same way.
Cloud sessions (Claude Code on the web) can't reach this computer, so they can't be shown.
`;

// ---------------------------------------------------------------- stripping
//
// One rule for everything that arrives: keep what the lab needs to draw the activity, drop the
// rest. Hook payloads go through an allowlist. OpenTelemetry attributes go through a denylist of
// text and identity keys, plus a size cap, because Claude Code adds attributes over time.

const ID = /^[\w.:-]{1,128}$/;                 // session, prompt, agent and tool use ids
const TOKEN = /^[\w.:@/[\]-]{1,128}$/;          // event, tool and model names, enums
const NAME = /^[\w .:@/()[\]-]{1,80}$/;        // agent types, which can be display names ("Report Writer")
const isNum = v => typeof v === 'number' && Number.isFinite(v);

// Hook payload fields that are kept, each with the shape its value must have.
const HOOK_FIELDS = {
  hook_event_name: TOKEN,
  session_id: ID,
  prompt_id: ID,
  agent_id: ID,
  agent_type: NAME,
  tool_name: TOKEN,
  tool_use_id: ID,
  task_id: ID,
  permission_mode: TOKEN,
  notification_type: TOKEN,   // e.g. permission_prompt, idle_prompt (the message itself is dropped)
  trigger: TOKEN,             // compaction: auto or manual
  source: TOKEN,              // session start: startup, resume, clear, compact
  reason: TOKEN,              // session end: clear, logout, prompt_input_exit, other
  model: TOKEN,
  error_type: TOKEN,
};
const HOOK_BOOLS = ['stop_hook_active', 'is_interrupt'];
const HOOK_NUMBERS = ['duration_ms'];

/**
 * A name for the page (a project folder name or a session title): control and direction
 * characters out, spaces collapsed, at most 80 characters. Empty is undefined.
 */
export function cleanName(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  const chars = Array.from(s);
  return chars.length > 80 ? chars.slice(0, 79).join('') + '…' : s;
}

/** The last segment of a folder path, never the path. Your home folder itself is "~". */
export function folderName(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return undefined;
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  let home = '';
  try { home = os.homedir().replace(/[\\/]+$/, ''); } catch { home = ''; }
  if (home && trimmed === home) return '~';
  const last = trimmed.split(/[\\/]/).filter(Boolean).pop();
  if (!last || last === '.' || last === '..' || /^[A-Za-z]:$/.test(last)) return undefined;
  return cleanName(last);
}

/**
 * A hook payload, stripped. Dropped: prompt, tool_input (except the subagent type of an Agent
 * call, which links a subagent to the call that started it), tool_response, message,
 * last_assistant_message, error (a has_error flag is kept), cwd (only its last folder name is
 * kept, as `project`), transcript_path, agent_transcript_path, task subjects, custom
 * instructions and anything unknown. With names: false, the project folder name and the
 * session title (SessionStart's session_title) are dropped too.
 */
export function stripHook(p, { names = true } = {}) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out = {};
  for (const [k, re] of Object.entries(HOOK_FIELDS)) {
    if (typeof p[k] === 'string' && re.test(p[k])) out[k] = p[k];
  }
  if (names) {
    // The hook forwarder sends `project` (already stripped); Claude Code sends `cwd`.
    const project = typeof p.cwd === 'string' ? folderName(p.cwd) : cleanName(p.project);
    if (project) out.project = project;
    const title = cleanName(p.session_title);
    if (title) out.session_title = title;
  }
  for (const k of HOOK_BOOLS) if (typeof p[k] === 'boolean') out[k] = p[k];
  for (const k of HOOK_NUMBERS) if (isNum(p[k])) out[k] = p[k];
  if (p.error) out.has_error = true;
  const sub = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input.subagent_type : undefined;
  if (/^(Agent|Task)$/.test(String(p.tool_name)) && typeof sub === 'string' && NAME.test(sub)) {
    out.tool_input = { subagent_type: sub };
  }
  return out.hook_event_name ? out : null;
}

// Attribute keys that carry text or identity. Matched anywhere in the key, case-insensitive.
const DENY = /prompt|command|response|input|parameters|path|content|body|error|email|account|organization|user\.|message|description|url|cwd|file|directory/i;
// Identity that the pattern above doesn't catch: the computer's name, the repository, custom
// resource attributes, hook command names.
const DENY_KEYS = /^(host\.name|host\.id|service\.instance\.id|process\.|vcs\.|workspace\.|terminal|hook_name|skill_name|plugin|marketplace|enabled_via)/i;
// Claude Code's own bookkeeping events (which hooks and plugins are registered, each hook run):
// they say nothing about the agents' work and would flood the page. Hooks arrive as hook events.
const NOISE_EVENTS = new Set(['hook_registered', 'hook_execution_start', 'hook_execution_complete', 'plugin_loaded', 'plugin_installed', 'managed_settings_resolved']);
const eventNameOf = lr => {
  const attr = Array.isArray(lr.attributes) && lr.attributes.find(kv => kv && kv.key === 'event.name');
  const raw = (attr && attr.value && attr.value.stringValue) || (lr.body && lr.body.stringValue) || '';
  return String(raw).replace(/^claude_code\./, '');
};
// Counters and ids whose names match DENY but hold no text.
const SAFE_KEYS = new Set([
  'prompt.id', 'prompt_length', 'user_prompt_length', 'response_length', 'gen_ai.response.id',
  'input_tokens', 'tool_input_size_bytes', 'tool_result_size_bytes',
]);
// Resource attributes are an allowlist: anyone can add their own through OTEL_RESOURCE_ATTRIBUTES.
const RESOURCE_KEYS = new Set(['service.name', 'service.version', 'os.type', 'host.arch', 'session.id']);
const MAX_STRING = 160;

function keepValue(v) {
  if (!v || typeof v !== 'object') return undefined;
  if (typeof v.stringValue === 'string') return v.stringValue.length <= MAX_STRING ? { stringValue: v.stringValue } : undefined;
  if (v.intValue !== undefined && /^-?\d{1,20}$/.test(String(v.intValue))) return { intValue: String(v.intValue) };
  if (isNum(v.doubleValue)) return { doubleValue: v.doubleValue };
  if (typeof v.boolValue === 'boolean') return { boolValue: v.boolValue };
  return undefined; // arrays, maps and bytes can hold anything
}

function stripAttrs(list, resource = false) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const kv of list) {
    if (!kv || typeof kv.key !== 'string') continue;
    const k = kv.key;
    if (resource ? !RESOURCE_KEYS.has(k) : !SAFE_KEYS.has(k) && (DENY.test(k) || DENY_KEYS.test(k))) continue;
    const value = keepValue(kv.value);
    if (value) out.push({ key: k, value });
  }
  return out;
}

const keepTime = t => (typeof t === 'string' && /^\d{1,20}$/.test(t)) || isNum(t) ? t : undefined;
const keepHex = s => (typeof s === 'string' && /^[0-9a-fA-F]{0,64}$/.test(s) ? s : undefined);
const scopeOf = s => ({
  name: s && typeof s.name === 'string' && TOKEN.test(s.name) ? s.name : undefined,
  version: s && typeof s.version === 'string' && TOKEN.test(s.version) ? s.version : undefined,
});

/** OTLP traces, stripped: ids, span names, times and allowed attributes. Span events, links and status messages are dropped. */
export function stripTraces(body) {
  const resourceSpans = [];
  for (const rs of (body && body.resourceSpans) || []) {
    const scopeSpans = [];
    for (const ss of (rs && (rs.scopeSpans || rs.instrumentationLibrarySpans)) || []) {
      const spans = [];
      for (const s of (ss && ss.spans) || []) {
        if (!s || typeof s !== 'object') continue;
        spans.push({
          traceId: keepHex(s.traceId), spanId: keepHex(s.spanId), parentSpanId: keepHex(s.parentSpanId) || '',
          name: typeof s.name === 'string' && TOKEN.test(s.name) ? s.name : 'span',
          kind: isNum(s.kind) ? s.kind : undefined,
          startTimeUnixNano: keepTime(s.startTimeUnixNano), endTimeUnixNano: keepTime(s.endTimeUnixNano),
          attributes: stripAttrs(s.attributes),
          status: s.status && isNum(s.status.code) ? { code: s.status.code } : undefined,
        });
      }
      if (spans.length) scopeSpans.push({ scope: scopeOf(ss.scope), spans });
    }
    if (scopeSpans.length) resourceSpans.push({ resource: { attributes: stripAttrs(rs.resource && rs.resource.attributes, true) }, scopeSpans });
  }
  return { resourceSpans };
}

/** OTLP logs (Claude Code events), stripped: event names, times and allowed attributes. */
export function stripLogs(body) {
  const resourceLogs = [];
  for (const rl of (body && body.resourceLogs) || []) {
    const scopeLogs = [];
    for (const sl of (rl && (rl.scopeLogs || rl.instrumentationLibraryLogs)) || []) {
      const logRecords = [];
      for (const lr of (sl && sl.logRecords) || []) {
        if (!lr || typeof lr !== 'object') continue;
        if (NOISE_EVENTS.has(eventNameOf(lr))) continue;
        // The body of a Claude Code event is its name ("claude_code.tool_result"); anything else is dropped.
        const name = lr.body && typeof lr.body.stringValue === 'string' && /^[\w.]{1,80}$/.test(lr.body.stringValue) ? lr.body.stringValue : undefined;
        logRecords.push({
          timeUnixNano: keepTime(lr.timeUnixNano), observedTimeUnixNano: keepTime(lr.observedTimeUnixNano),
          severityNumber: isNum(lr.severityNumber) ? lr.severityNumber : undefined,
          severityText: typeof lr.severityText === 'string' && TOKEN.test(lr.severityText) ? lr.severityText : undefined,
          body: name ? { stringValue: name } : undefined,
          attributes: stripAttrs(lr.attributes),
          traceId: keepHex(lr.traceId), spanId: keepHex(lr.spanId),
        });
      }
      if (logRecords.length) scopeLogs.push({ scope: scopeOf(sl.scope), logRecords });
    }
    if (scopeLogs.length) resourceLogs.push({ resource: { attributes: stripAttrs(rl.resource && rl.resource.attributes, true) }, scopeLogs });
  }
  return { resourceLogs };
}

// ---------------------------------------------------------------- sessions: names and times only
//
// "Scan sessions" on the page: Claude Code keeps one transcript per session in
// <config dir>/projects/<project folder>/<session id>.jsonl, where the folder name is the
// project's path with every character other than a letter or digit turned into "-". This reads
// directory listings and file times only (readdir, stat), never a file's contents, and returns
// the session id, when it last changed and, with names, the project's last folder name. The relay
// then hands the transcripts it found to the transcript reader below (token numbers only).

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

const encodePath = s => s.replace(/[^a-zA-Z0-9]/g, '-');

// "-Users-dev-dev-my-site" -> "my-site": walks the folders on this computer from the root,
// matching each entry's encoded name, so dashes, dots and spaces in folder names come out right.
// A project folder that no longer exists gives its encoded name's last part ("site").
async function projectName(encoded, cache) {
  if (cache.has(encoded)) return cache.get(encoded);
  let result;
  const home = (() => { try { return os.homedir(); } catch { return ''; } })();
  if (home && encodePath(home) === encoded) result = '~';
  else if (process.platform !== 'win32' && encoded.startsWith('-')) {
    let dir = '/';
    let rest = encoded.slice(1);
    let last;
    for (let depth = 0; rest && depth < 40; depth++) {
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { break; }
      // The longest folder name that matches the start of what is left.
      let best = null;
      for (const e of entries) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        const enc = encodePath(e.name);
        if ((rest === enc || rest.startsWith(enc + '-')) && (!best || enc.length > encodePath(best).length)) best = e.name;
      }
      if (!best) break;
      dir = path.join(dir, best);
      last = best;
      rest = rest.slice(encodePath(best).length + 1);
    }
    if (last && !rest) result = folderName(dir);
  }
  if (!result) result = cleanName(encoded.split('-').filter(Boolean).pop());
  cache.set(encoded, result);
  return result;
}

/**
 * The sessions from the last 24 hours, newest first. With withFiles, also `files`: the transcripts
 * of those sessions (each session's own, and its subagents' in <session id>/subagents/), for the
 * relay's transcript reader only. Their paths are built from directory listings here, never from
 * anything a request says, and never leave the relay.
 */
export async function scanSessions({ names = true, dir = path.join(claudeConfigDir(), 'projects'), now = Date.now(), withFiles = false } = {}) {
  const found = [];
  let projects;
  try { projects = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return { sessions: [], scanned: false }; }
  let stats = 0;
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    let files;
    try { files = await fs.promises.readdir(path.join(dir, p.name), { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      const m = /^(.+)\.jsonl$/.exec(f.name);
      if (!m || !f.isFile() || !ID.test(m[1])) continue;
      if (++stats > 20000) break;
      let st;
      try { st = await fs.promises.stat(path.join(dir, p.name, f.name)); } catch { continue; }
      if (now - st.mtimeMs > SCAN_WINDOW_MS) continue;
      found.push({ session: m[1], folder: p.name, lastActive: Math.round(st.mtimeMs) });
    }
  }
  found.sort((a, b) => b.lastActive - a.lastActive);
  const cache = new Map();
  const sessions = [];
  const files = [];
  for (const f of found.slice(0, SCAN_MAX)) {
    const item = { session: f.session, lastActive: f.lastActive, active: now - f.lastActive < SCAN_ACTIVE_MS };
    if (names) {
      const project = await projectName(f.folder, cache);
      if (project) item.project = project;
    }
    sessions.push(item);
    if (withFiles) {
      files.push({ file: path.join(dir, f.folder, `${f.session}.jsonl`), session: f.session });
      files.push(...await subagentTranscripts(path.join(dir, f.folder, f.session, 'subagents'), f.session, now));
    }
  }
  const result = { sessions, scanned: true, total: found.length };
  if (withFiles) result.files = files;
  return result;
}

// A session's subagent transcripts (agent-<agent id>.jsonl, plain files only) changed in the last
// 24 hours, the most recent SCAN_SUBAGENTS_MAX.
async function subagentTranscripts(dir, session, now) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.slice(0, 2000)) {
    const m = /^agent-(.+)\.jsonl$/.exec(e.name);
    if (!m || !e.isFile() || !ID.test(m[1])) continue;
    let st;
    try { st = await fs.promises.stat(path.join(dir, e.name)); } catch { continue; }
    if (now - st.mtimeMs > SCAN_WINDOW_MS) continue;
    out.push({ file: path.join(dir, e.name), session, agent: m[1], at: st.mtimeMs });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, SCAN_SUBAGENTS_MAX).map(t => ({ file: t.file, session: t.session, agent: t.agent }));
}

// ---------------------------------------------------------------- transcripts: token numbers only
//
// Without telemetry, Claude Code still writes each model call's usage into the session's
// transcript (<config dir>/projects/<project>/<session id>.jsonl; a subagent's goes in
// <session id>/subagents/agent-<agent id>.jsonl). When a hook event names a transcript, the relay
// reads the lines added since its last read and keeps, per assistant message, only: input,
// output, cache read and cache creation tokens, the model name and the request id. The text, the
// path and every other field stay in the file. Reads are incremental (a byte offset per file),
// bounded, and a line still being written is left for the next read.

const T_CHUNK = 1 << 20;            // bytes per read
const T_MAX_PASS = 8 << 20;         // bytes per pass; a longer backlog continues a moment later
const T_FIRST_MAX = 32 << 20;       // a transcript seen for the first time: at most its last 32 MB
const T_LINE_MAX = 4 << 20;         // longer lines (pasted images, huge tool results) are skipped
const T_FILES_MAX = 1000;           // transcripts followed at once (least recently read dropped)
const T_READS_MAX = 4;              // transcripts read at the same moment (a scan can name many)
const T_SEEN_MAX = 5000;            // message ids remembered per transcript, to count each call once
const MAX_TOKENS = 1e9;

const tokenCount = v => (Number.isInteger(v) && v >= 0 && v <= MAX_TOKENS ? v : 0);

/**
 * The transcript a hook payload names, if it looks like one of Claude Code's: an absolute path to
 * "<session id>.jsonl" (or "agent-<agent id>.jsonl" in a "subagents" folder for a subagent's own
 * transcript) under a "projects" folder. Anything else is ignored, so a hook payload can't make
 * the relay read another file.
 */
export function transcriptTargets(p) {
  const out = [];
  if (!p || typeof p !== 'object') return out;
  const session = typeof p.session_id === 'string' && ID.test(p.session_id) ? p.session_id : null;
  const agent = typeof p.agent_id === 'string' && ID.test(p.agent_id) ? p.agent_id : null;
  if (!session) return out;
  const ok = f => typeof f === 'string' && f.length < 4096 && path.isAbsolute(f) && !f.includes('\0') &&
    path.normalize(f).split(path.sep).includes('projects');
  const main = p.transcript_path;
  if (ok(main) && path.basename(main) === `${session}.jsonl`) {
    out.push({ file: path.normalize(main), session });
    // A hook that fired inside a subagent: that subagent's own transcript, next to the session's.
    if (agent) out.push({ file: path.join(path.dirname(path.normalize(main)), session, 'subagents', `agent-${agent}.jsonl`), session, agent });
  }
  const sub = p.agent_transcript_path;
  if (agent && ok(sub) && path.basename(sub) === `agent-${agent}.jsonl` && !out.some(t => t.file === path.normalize(sub))) {
    out.push({ file: path.normalize(sub), session, agent });
  }
  return out;
}

/**
 * One transcript line -> the usage of one model call, or null. Only numbers, the model name and
 * ids come out.
 */
export function usageFromLine(line) {
  // Cheap checks first: most lines are tool results and user messages.
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || o.type !== 'assistant' || !o.message || typeof o.message !== 'object') return null;
  const u = o.message.usage;
  if (!u || typeof u !== 'object') return null;
  const model = typeof o.message.model === 'string' && TOKEN.test(o.message.model) && o.message.model !== '<synthetic>' ? o.message.model : null;
  if (!model) return null;
  const tokens = {
    in: tokenCount(u.input_tokens), out: tokenCount(u.output_tokens),
    cacheRead: tokenCount(u.cache_read_input_tokens), cacheWrite: tokenCount(u.cache_creation_input_tokens),
  };
  if (!tokens.in && !tokens.out && !tokens.cacheRead && !tokens.cacheWrite) return null;
  // The part of the cache writes that went to the 1-hour cache (priced higher than the 5-minute one).
  const c = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const hour = c ? Math.min(tokenCount(c.ephemeral_1h_input_tokens), tokens.cacheWrite) : 0;
  if (hour) tokens.cacheWrite1h = hour;
  const messageId = typeof o.message.id === 'string' && ID.test(o.message.id) ? o.message.id : null;
  const requestId = typeof o.requestId === 'string' && ID.test(o.requestId) ? o.requestId : null;
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  const r = { key: messageId || requestId, requestId: requestId || messageId, model, tokens, ts: Number.isFinite(ts) ? ts : Date.now() };
  // Price modifiers, as short words: fast mode, and US-only inference.
  if (u.speed === 'fast') r.speed = 'fast';
  if (typeof u.inference_geo === 'string' && /^[a-z_]{1,16}$/.test(u.inference_geo)) r.geo = u.inference_geo;
  return r;
}

/** Usage records as an OTLP logs body of Claude Code api_request events, which the lab page reads. */
export function usageToLogs(records, { session, agent }) {
  const int = n => ({ intValue: String(n) });
  const str = s => ({ stringValue: s });
  const logRecords = records.map(r => ({
    timeUnixNano: `${r.ts}000000`,
    body: str('claude_code.api_request'),
    attributes: [
      { key: 'event.name', value: str('api_request') },
      { key: 'usage.source', value: str('transcript') },
      { key: 'session.id', value: str(session) },
      ...(agent ? [{ key: 'agent_id', value: str(agent) }] : []),
      { key: 'model', value: str(r.model) },
      ...(r.requestId ? [{ key: 'request_id', value: str(r.requestId) }] : []),
      { key: 'input_tokens', value: int(r.tokens.in) },
      { key: 'output_tokens', value: int(r.tokens.out) },
      { key: 'cache_read_tokens', value: int(r.tokens.cacheRead) },
      { key: 'cache_creation_tokens', value: int(r.tokens.cacheWrite) },
      ...(r.tokens.cacheWrite1h ? [{ key: 'cache_creation_1h_tokens', value: int(r.tokens.cacheWrite1h) }] : []),
      ...(r.speed ? [{ key: 'speed', value: str(r.speed) }] : []),
      ...(r.geo ? [{ key: 'inference_geo', value: str(r.geo) }] : []),
    ],
  }));
  return { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: str('constellation-relay') }] }, scopeLogs: [{ scope: { name: 'constellation-relay.transcripts', version: VERSION }, logRecords }] }] };
}

/**
 * Follows transcripts: trigger(target, delay) schedules a read of one; emit(records, target) gets
 * the new usage records. One read at a time per file.
 */
export function createTranscriptReader({ emit }) {
  const files = new Map(); // file -> { offset, skipping, seen: Set, order: [], timer, reading, again, queued, session, agent }
  let active = 0;          // reads running now, at most T_READS_MAX
  const waiting = [];      // [file, state] waiting for a free read

  function schedule(file, st) {
    if (active >= T_READS_MAX) {
      if (!st.queued) { st.queued = true; waiting.push([file, st]); }
      return;
    }
    active++;
    read(file, st).finally(() => {
      active--;
      const next = waiting.shift();
      if (next) { next[1].queued = false; schedule(next[0], next[1]); }
    });
  }

  function stateOf(t) {
    let st = files.get(t.file);
    if (!st) {
      st = { offset: -1, skipping: false, seen: new Set(), order: [], timer: null, reading: false, again: false, session: t.session, agent: t.agent || null };
      files.set(t.file, st);
      if (files.size > T_FILES_MAX) {
        const [oldest, old] = files.entries().next().value;
        if (old.timer) clearTimeout(old.timer);
        files.delete(oldest);
      }
    } else {
      // Most recently used last, for the eviction above.
      files.delete(t.file);
      files.set(t.file, st);
    }
    return st;
  }

  function trigger(t, delay = 250) {
    const st = stateOf(t);
    if (st.timer) return;
    st.timer = setTimeout(() => { st.timer = null; schedule(t.file, st); }, delay);
    if (st.timer.unref) st.timer.unref();
  }

  async function read(file, st) {
    if (st.reading) { st.again = true; return; }
    st.reading = true;
    let fh;
    try {
      fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)).catch(() => null);
      if (!fh) return;
      const stat = await fh.stat();
      if (!stat.isFile()) return;
      const size = stat.size;
      if (st.offset < 0) {
        st.offset = Math.max(0, size - T_FIRST_MAX);
        st.skipping = st.offset > 0; // started mid-file: the first, partial line is skipped
      }
      if (size < st.offset) { st.offset = 0; st.skipping = false; } // rewritten from scratch
      const records = [];
      let budget = T_MAX_PASS;
      let carry = Buffer.alloc(0);
      let pos = st.offset;
      while (pos < size && budget > 0) {
        const len = Math.min(T_CHUNK, size - pos, budget);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        budget -= bytesRead;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let start = 0;
        for (let nl = data.indexOf(10); nl >= 0; nl = data.indexOf(10, start)) {
          if (st.skipping) st.skipping = false;
          else {
            const r = usageFromLine(data.toString('utf8', start, nl));
            if (r && (!r.key || !st.seen.has(r.key))) {
              if (r.key) {
                st.seen.add(r.key);
                st.order.push(r.key);
                if (st.order.length > T_SEEN_MAX) st.seen.delete(st.order.shift());
              }
              records.push(r);
            }
          }
          start = nl + 1;
        }
        // Everything up to the last newline is consumed; the rest waits for its newline.
        st.offset = pos - (data.length - start);
        carry = data.subarray(start);
        if (carry.length > T_LINE_MAX) {
          // A line too long to be a model call's: skip it up to its end.
          st.offset = pos;
          st.skipping = true;
          carry = Buffer.alloc(0);
        }
      }
      if (records.length) emit(records, st);
      if (pos < size && budget <= 0) st.again = true; // more backlog: continue shortly
    } catch {
      // A transcript that can't be read is simply not counted.
    } finally {
      if (fh) await fh.close().catch(() => {});
      st.reading = false;
      if (st.again) {
        st.again = false;
        if (!st.timer) {
          st.timer = setTimeout(() => { st.timer = null; schedule(file, st); }, 20);
          if (st.timer.unref) st.timer.unref();
        }
      }
    }
  }

  return { trigger, files };
}

// ---------------------------------------------------------------- telemetry and transcripts: count each call once
//
// The same model call can reach the page twice: as the api_request event (and llm_request span)
// that a session's telemetry sends, and as a usage record read from its transcript. Both carry
// the API's request id (request_id in telemetry, requestId in the transcript). The rule, per
// session:
//   - A session is a telemetry session from the first OTLP record carrying its session.id that
//     reaches this relay. `since` is the earliest event time in what it has sent (an exporter
//     that retries an older batch moves it back).
//   - For a telemetry session, a transcript record is not published when its request id was in
//     that session's telemetry, or when it happened at or after `since` (telemetry was on for that
//     call, so its own event counts it, even if that event hasn't arrived yet).
//   - Every other transcript record is published: sessions without telemetry, and calls from
//     before a session's telemetry reached the relay (a relay started after the session, a
//     session started before telemetry was turned on) that telemetry didn't send.
//   - While any telemetry is arriving, transcript records wait T_HOLD_MS before this check, so a
//     call's api_request event, exported every second, is usually here first.
//   - What is left (a transcript record published before that session's first telemetry arrived,
//     carrying a request id telemetry then sends too) the page counts once: by request id, with
//     telemetry's cost in place of the estimate.

const T_HOLD_MS = 2000;
const OTEL_SESSIONS_MAX = 500;   // telemetry sessions remembered (least recently heard from dropped)
const OTEL_IDS_MAX = 5000;       // request ids remembered per session

// Milliseconds from an OTLP time (nanoseconds, as a string or a number), or 0.
function otlpMs(t) {
  if (typeof t === 'string' && /^\d{7,20}$/.test(t)) return Number(t.slice(0, -6));
  if (isNum(t) && t > 1e12) return Math.round(t / 1e6);
  return 0;
}

export function createTelemetrySessions({ now = () => Date.now() } = {}) {
  const sessions = new Map(); // session id -> { since, ids: Set, order: [] }

  function record(session, at, requestId) {
    if (typeof session !== 'string' || !ID.test(session)) return;
    const t = now();
    // An event time from the future, or from long ago (a clock that jumped), counts as now.
    const when = at > 0 && at <= t && t - at < 30 * 24 * 3600 * 1000 ? at : t;
    let e = sessions.get(session);
    if (!e) {
      e = { since: when, ids: new Set(), order: [] };
      if (sessions.size >= OTEL_SESSIONS_MAX) sessions.delete(sessions.keys().next().value);
    } else {
      sessions.delete(session); // most recently heard from last, for the eviction above
      if (when < e.since) e.since = when;
    }
    sessions.set(session, e);
    if (typeof requestId === 'string' && ID.test(requestId) && !e.ids.has(requestId)) {
      e.ids.add(requestId);
      e.order.push(requestId);
      if (e.order.length > OTEL_IDS_MAX) e.ids.delete(e.order.shift());
    }
  }

  const attr = (list, k) => {
    const kv = Array.isArray(list) && list.find(a => a && a.key === k);
    return kv && kv.value ? kv.value.stringValue : undefined;
  };

  /** Notes the sessions and request ids in a stripped OTLP logs or traces body. */
  function note(body) {
    for (const rl of (body && body.resourceLogs) || []) {
      const res = attr(rl.resource && rl.resource.attributes, 'session.id');
      for (const sl of rl.scopeLogs || []) for (const lr of sl.logRecords || []) {
        const iso = Date.parse(attr(lr.attributes, 'event.timestamp') || '');
        const at = Number.isFinite(iso) ? iso : otlpMs(lr.timeUnixNano) || otlpMs(lr.observedTimeUnixNano);
        record(attr(lr.attributes, 'session.id') || res, at, attr(lr.attributes, 'request_id'));
      }
    }
    for (const rs of (body && body.resourceSpans) || []) {
      const res = attr(rs.resource && rs.resource.attributes, 'session.id');
      for (const ss of rs.scopeSpans || []) for (const sp of ss.spans || []) {
        record(attr(sp.attributes, 'session.id') || res, otlpMs(sp.startTimeUnixNano), attr(sp.attributes, 'request_id') || attr(sp.attributes, 'gen_ai.response.id'));
      }
    }
  }

  /** True when telemetry counts this transcript record of this session (so it is not published). */
  function covers(session, r) {
    const e = sessions.get(session);
    if (!e) return false;
    return (!!r.requestId && e.ids.has(r.requestId)) || r.ts >= e.since;
  }

  return { note, covers, sessions };
}

// ---------------------------------------------------------------- start: the relay

function startRelay() {
  const PORT = portArg();
  const NAMES = !flag('--no-names');
  // Plugin mode: no pairing code (an allowed Origin instead), quiet, exits when idle.
  const PLUGIN = flag('--plugin');
  let idleMs = IDLE_MS;
  if (opt('--idle-seconds') !== undefined) {
    // For tests only.
    const n = Number(opt('--idle-seconds'));
    if (!(n > 0)) fail('--idle-seconds must be a positive number.');
    idleMs = n * 1000;
  }
  const HOST = '127.0.0.1';
  const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

  const origins = new Set(SITE_ORIGINS);
  for (const o of opts('--origin')) {
    let u;
    try { u = new URL(o); } catch { fail(`--origin must be a web origin such as http://localhost:3000 (got ${o}).`); }
    if (!/^https?:$/.test(u.protocol)) fail(`--origin must start with http:// or https:// (got ${o}).`);
    origins.add(u.origin);
  }

  // Pairing code: 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L), shown as
  // XXXX-XXXX. --code sets it, for automated tests only.
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let code = norm(opt('--code'));
  if (opt('--code') !== undefined && code.length < 8) fail('--code needs at least 8 letters or digits.');
  if (!code) code = Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  const shown = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
  const codeDigest = crypto.createHash('sha256').update(code).digest();

  // Constant-time comparison of the bearer token with the code (hashing makes lengths equal).
  // In plugin mode the page needs no code: an allowed Origin was already checked, and a request
  // without one (an <img>, a script on this computer that doesn't say who it is) is refused.
  function authorized(req) {
    if (PLUGIN) return req.headers.origin !== undefined && origins.has(req.headers.origin);
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) return false;
    const given = crypto.createHash('sha256').update(norm(m[1])).digest();
    return crypto.timingSafeEqual(given, codeDigest);
  }

  const buffer = [];
  const viewers = new Set();
  const counts = { traces: 0, logs: 0, metrics: 0, hooks: 0, transcripts: 0, transcriptsSkipped: 0, duplicates: 0 };
  const lastSeen = { otel: 0, hooks: 0, transcripts: 0 };
  const viaSeen = { plugin: 0, settings: 0 }; // when each kind of hook last sent an event
  let twiceAt = 0;                            // when the last pair of copies arrived
  let lastActivity = Date.now();
  let warnedProtobuf = false;
  let firstEvent = true;

  function publish(item) {
    buffer.push(item);
    if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX);
    const line = `data: ${JSON.stringify(item)}\n\n`;
    for (const res of viewers) res.write(line);
    if (firstEvent) {
      firstEvent = false;
      log('First event received from Claude Code.');
    }
  }

  function log(msg) { if (!PLUGIN) console.log(`${new Date().toTimeString().slice(0, 8)}  ${msg}`); }

  // Token numbers from the transcripts (the ones hook events name, and the ones a scan finds),
  // per session. A session whose telemetry reaches this relay has its own api_request events
  // (which also carry Claude Code's cost estimate): for it, a transcript record is published only
  // if telemetry can't have sent it (see telemetryCovers). Sessions without telemetry keep
  // publishing transcript usage, whatever other sessions do.
  const otelSessions = createTelemetrySessions();
  const transcripts = createTranscriptReader({
    emit(records, st) {
      const out = () => {
        const kept = records.filter(r => !otelSessions.covers(st.session, r));
        counts.transcriptsSkipped += records.length - kept.length;
        if (!kept.length) return;
        counts.transcripts += kept.length;
        lastSeen.transcripts = Date.now();
        publish({ path: '/v1/logs', body: stripLogs(usageToLogs(kept, st)), ts: Date.now() });
      };
      // While telemetry is arriving here, wait a moment: a call's own api_request event (sent
      // every second) may be on its way, and then it, not the transcript, counts the call.
      if (Date.now() - lastSeen.otel < 10 * 60 * 1000) setTimeout(out, T_HOLD_MS).unref();
      else out();
    },
  });
  // The transcript can lag the hook that ends a turn: read again a moment later.
  const LATE_READ = new Set(['Stop', 'SubagentStop', 'StopFailure', 'SessionEnd', 'PreCompact']);

  function send(res, status, obj, headers = {}) {
    const body = obj === undefined ? '' : JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const enc = String(req.headers['content-encoding'] || 'identity').toLowerCase();
      let stream = req;
      if (enc === 'gzip') stream = req.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = req.pipe(zlib.createInflate());
      else if (enc !== 'identity') { req.resume(); reject(Object.assign(new Error('unsupported encoding'), { status: 415 })); return; }
      const chunks = [];
      let size = 0;
      stream.on('data', c => {
        size += c.length;
        if (size > limit) { stream.destroy(); req.destroy(); reject(Object.assign(new Error('too large'), { status: 413 })); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', err => reject(Object.assign(err, { status: 400 })));
    });
  }

  // CORS for the page: only an exact allowed origin gets the headers that let it read a response.
  function cors(req) {
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin)) return { Vary: 'Origin' };
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }

  async function ingestOtlp(req, res, signal) {
    if (/protobuf/i.test(String(req.headers['content-type'] || ''))) {
      req.resume();
      if (!warnedProtobuf) {
        warnedProtobuf = true;
        console.warn('\n[!] Claude Code is sending OpenTelemetry as protobuf; this relay reads JSON.\n' +
          '    Run "node constellation-relay.mjs setup" (it sets OTEL_EXPORTER_OTLP_PROTOCOL=http/json)\n' +
          '    and start a new session. A shell-exported OTEL_EXPORTER_OTLP_PROTOCOL can override it.\n');
      }
      return send(res, 415, { error: 'Send OTLP as JSON: OTEL_EXPORTER_OTLP_PROTOCOL=http/json' });
    }
    let body;
    try { body = JSON.parse((await readBody(req, OTLP_MAX_BYTES)).toString('utf8') || '{}'); }
    catch (err) { return send(res, err.status || 400, { error: err.status === 413 ? 'Too large' : 'Invalid JSON' }); }
    send(res, 200, {});
    counts[signal]++;
    lastSeen.otel = Date.now();
    lastActivity = Date.now();
    // Metrics are counted, not forwarded: the lab draws from traces, events and hooks.
    if (signal === 'traces') {
      const stripped = stripTraces(body);
      otelSessions.note(stripped);
      publish({ path: '/v1/traces', body: stripped, ts: Date.now() });
    } else if (signal === 'logs') {
      const stripped = stripLogs(body);
      otelSessions.note(stripped);
      publish({ path: '/v1/logs', body: stripped, ts: Date.now() });
    }
  }

  async function ingestHook(req, res) {
    let raw;
    try { raw = await readBody(req, HOOK_MAX_BYTES); }
    catch (err) { return send(res, err.status || 400, undefined); }
    // An empty 2xx: a hook never waits on, or is decided by, the relay.
    res.writeHead(200, { 'Content-Length': 0 });
    res.end();
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return; }
    // The forwarder already stripped it (keeping the names, which only travel to this relay
    // over loopback); this pass drops them when the relay runs with --no-names.
    const body = stripHook(payload, { names: NAMES });
    if (!body) return;
    lastActivity = Date.now();
    // The forwarder passes the transcript paths along to this relay only; they are read here
    // and never published (stripHook dropped them from body). Reading a transcript twice counts
    // nothing twice (a byte offset per file), so a dropped copy may trigger it too.
    for (const t of transcriptTargets(payload)) {
      transcripts.trigger(t);
      if (LATE_READ.has(body.hook_event_name)) setTimeout(() => transcripts.trigger(t), 2500).unref();
    }
    // The forwarder stamps when the hook ran, so events keep their order after a slow post.
    const stamped = Number(req.headers['x-hook-ts']);
    const ts = Math.abs(stamped - Date.now()) < 600000 ? stamped : Date.now();
    const via = payload.via === 'plugin' ? 'plugin' : 'settings';
    viaSeen[via] = Date.now();
    if (twin(body, via, ts)) {
      counts.duplicates++;
      return;
    }
    counts.hooks++;
    lastSeen.hooks = Date.now();
    publish({ path: '/hook', body, ts });
  }

  // Hooks installed twice: the plugin's hooks and the ones setup added both run for every event,
  // so each event arrives twice, once of each kind. The second copy of a pair (same event,
  // session, tool use, agent and task, the other kind, stamped within DUP_MS) is dropped. Copies
  // of one kind are never dropped: with only one kind installed, every event passes.
  const unmatched = new Map(); // key -> { plugin: [ts], settings: [ts] }, copies still waiting for their twin
  let sweptAt = 0;
  function twin(body, via, ts) {
    const now = Date.now();
    if (now - sweptAt > 1000) {
      sweptAt = now;
      for (const [k, v] of unmatched) {
        v.plugin = v.plugin.filter(t => now - t < 2 * DUP_MS);
        v.settings = v.settings.filter(t => now - t < 2 * DUP_MS);
        if (!v.plugin.length && !v.settings.length) unmatched.delete(k);
      }
    }
    const key = [body.hook_event_name, body.session_id, body.tool_use_id, body.agent_id, body.task_id].map(v => v || '').join('|');
    let entry = unmatched.get(key);
    if (!entry) {
      if (unmatched.size >= 5000) unmatched.delete(unmatched.keys().next().value);
      entry = { plugin: [], settings: [] };
      unmatched.set(key, entry);
    }
    const other = entry[via === 'plugin' ? 'settings' : 'plugin'];
    const i = other.findIndex(t => Math.abs(t - ts) <= DUP_MS);
    if (i >= 0) {
      other.splice(i, 1);
      twiceAt = now;
      return true;
    }
    entry[via].push(ts);
    return false;
  }

  function openStream(req, res) {
    if (viewers.size >= MAX_VIEWERS) return send(res, 429, { error: 'Too many pages connected' }, cors(req));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      ...cors(req),
    });
    // What the relay already holds, then a marker, then live events.
    res.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION, buffered: buffer.length })}\n\n`);
    for (const item of buffer) res.write(`data: ${JSON.stringify(item)}\n\n`);
    res.write('event: ready\ndata: {}\n\n');
    viewers.add(res);
    log(`A page connected (${viewers.size} open).`);
    const ping = setInterval(() => res.write(': keep-alive\n\n'), KEEPALIVE_MS);
    const close = () => {
      clearInterval(ping);
      lastActivity = Date.now(); // idle time counts from when the last page left
      if (viewers.delete(res)) log(`A page disconnected (${viewers.size} open).`);
    };
    res.on('close', close); // the page went away (the request side closes as soon as it is read)
    res.on('error', close);
  }

  const server = http.createServer(async (req, res) => {
    try {
      // DNS rebinding: a hostile page can point its own domain at 127.0.0.1, but it can't make
      // the browser send Host: 127.0.0.1. Anything addressed to another name is refused.
      if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
        req.resume();
        return send(res, 421, { error: 'Unexpected Host header' });
      }
      const route = (req.url || '/').split('?')[0];
      const ingest = ['/v1/traces', '/v1/logs', '/v1/metrics', '/hook'].includes(route);
      const viewer = route === '/events' || route === '/health' || route === '/sessions';

      if (ingest) {
        // Browsers always send Origin on a POST from a web page; Claude Code and the hook never
        // do. So no website can post fake events here.
        if (req.headers.origin !== undefined) { req.resume(); return send(res, 403, { error: 'Requests from web pages are not accepted here' }); }
        if (req.method !== 'POST') { req.resume(); return send(res, 405, { error: 'POST only' }, { Allow: 'POST' }); }
        if (route === '/hook') {
          if (!/json/i.test(String(req.headers['content-type'] || ''))) { req.resume(); return send(res, 415, { error: 'Expected application/json' }); }
          return await ingestHook(req, res);
        }
        if (!/json|protobuf/i.test(String(req.headers['content-type'] || ''))) { req.resume(); return send(res, 415, { error: 'Expected application/json' }); }
        return await ingestOtlp(req, res, route.slice(4));
      }

      if (viewer) {
        req.resume();
        const origin = req.headers.origin;
        if (origin !== undefined && !origins.has(origin)) return send(res, 403, { error: 'This page is not allowed to read the relay' }, { Vary: 'Origin' });
        if (req.method === 'OPTIONS') {
          // Preflight for the Authorization header. Allow-Private-Network answers Chrome's
          // check before a public https page may reach this computer.
          res.writeHead(204, {
            ...cors(req),
            'Access-Control-Allow-Methods': 'GET',
            'Access-Control-Allow-Headers': 'authorization',
            'Access-Control-Allow-Private-Network': 'true',
            'Access-Control-Max-Age': '600',
            'Content-Length': 0,
          });
          return res.end();
        }
        if (req.method !== 'GET') return send(res, 405, { error: 'GET only' }, { Allow: 'GET, OPTIONS', ...cors(req) });
        if (PLUGIN && !authorized(req)) return send(res, 403, { error: 'Only the lab page can read this relay' }, { Vary: 'Origin' });
        // The version and mode are no secret: they let the page say what is running here.
        if (!authorized(req)) return send(res, 401, { error: 'Wrong pairing code', version: VERSION, mode: 'manual', pairing: true }, { 'WWW-Authenticate': 'Bearer', ...cors(req) });
        if (route === '/health') {
          const now = Date.now();
          return send(res, 200, {
            ok: true, version: VERSION, mode: PLUGIN ? 'plugin' : 'manual', pairing: !PLUGIN, names: NAMES,
            counts: { ...counts, viewers: viewers.size, buffered: buffer.length }, lastSeen: { ...lastSeen },
            hooksVia: { ...viaSeen },
            // Both the plugin's hooks and the ones setup added are sending: the page says how to
            // remove the manual ones.
            duplicateHooks: twiceAt > 0 && now - twiceAt < TWICE_MS,
          }, cors(req));
        }
        if (route === '/sessions') {
          const { files, ...found } = await scanSessions({ names: NAMES, withFiles: true });
          send(res, 200, found, cors(req));
          // Sessions already running when the plugin was installed send no hook events: read the
          // token numbers of the transcripts the scan found too (same reader, same limits, after
          // the answer; usage is published as it is read). Spread out a little.
          (files || []).forEach((t, i) => transcripts.trigger(t, 50 + 10 * i));
          return;
        }
        return openStream(req, res);
      }

      req.resume();
      return send(res, 404, { error: 'Unknown endpoint' });
    } catch (err) {
      console.error('Relay error:', err && err.message);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
      else res.end();
    }
  });

  server.keepAliveTimeout = 65000;
  server.on('error', err => {
    // Plugin mode: another relay (or anything else) already holds the port. Leave it be.
    if (PLUGIN) process.exit(0);
    if (err.code === 'EADDRINUSE') {
      fail(`Port ${PORT} is already in use (the agent-constellation plugin's relay, another relay or an OpenTelemetry collector?).\n` +
        `See what holds it:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN   (node constellation-relay.mjs status tells relays apart)\n` +
        `Stop it, or use another port for both:  node constellation-relay.mjs --port <n>\n` +
        `                                         node constellation-relay.mjs setup --port <n>`);
    }
    fail(`Could not start: ${err.message}`);
  });

  server.listen(PORT, HOST, () => {
    const extra = [...origins].filter(o => !SITE_ORIGINS.includes(o));
    if (PLUGIN) {
      // Started by the plugin's hooks, in the background: one line, for whoever runs it by hand.
      console.log(`Constellation relay ${VERSION} (plugin mode, no pairing code) on http://${HOST}:${PORT}; exits after ${Math.round(idleMs / 60000) || '<1'} min idle.`);
      return;
    }
    console.log(`
  Constellation relay ${VERSION} is running on http://${HOST}:${PORT} (this computer only)

  Pairing code:  ${shown}

  1. Open ${extra.length ? extra[0] : 'https://diegobianqui.com'}/lab/constellation
  2. Click "Connect Claude Code" and paste the code.
     Your browser may ask to allow access to devices on your local network: allow it.
  3. Start a new Claude Code session on this computer (terminal, IDE or desktop app).
     Sessions that were open before you ran setup don't send anything until restarted.

  Only the shape of the activity reaches the page. Nothing is sent to any server.
  ${NAMES ? 'Session names: the project folder name and the session title. To hide them, start with --no-names.' : 'Session names are off (--no-names): the page shows short session ids.'}
  Not set up yet? Run:  node constellation-relay.mjs setup${PORT === DEFAULT_PORT ? '' : ` --port ${PORT}`}
  Stop with Ctrl+C.${extra.length ? `\n  Also allowed to read the stream: ${extra.join(', ')}` : ''}
`);
  });

  const shutdown = () => {
    for (const res of viewers) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Plugin mode: nobody stops this relay by hand, so it stops itself once nothing has used it
  // for a while (no hook events, no telemetry, no page connected). The next session starts it again.
  if (PLUGIN) {
    const idleTimer = setInterval(() => {
      if (!viewers.size && Date.now() - lastActivity >= idleMs) {
        clearInterval(idleTimer);
        shutdown();
      }
    }, Math.min(30000, Math.max(250, idleMs / 4)));
  }
}

// ---------------------------------------------------------------- setup: settings.json

// The hook events the lab draws. Each gets one background command hook.
const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact',
  'TaskCreated', 'TaskCompleted', 'SessionEnd',
];
// Setup records what it added under this env key, so --remove takes out exactly that and puts
// back any value it replaced. (An env entry is harmless: it only reaches Claude Code's process.)
// The record has a part for telemetry and one for hooks, so each can be added and removed on its
// own: --no-hooks leaves the hooks as they are, --no-telemetry the telemetry.
const MARK = 'CONSTELLATION_RELAY_SETUP';
const OURS = /constellation-relay\.mjs"? hook /;
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isOurs = h => !!h && h.type === 'command' && typeof h.command === 'string' && OURS.test(h.command);
// The commands of the agent-constellation plugin that run setup for you (setup --plugin).
const PLUGIN_TELEMETRY_OFF = '/agent-constellation:telemetry off';
const PLUGIN_REMOVE_HOOKS = '/agent-constellation:remove-manual-hooks';

function settingsPath() {
  return path.resolve(opt('--settings') || path.join(claudeConfigDir(), 'settings.json'));
}

function readSettings(file) {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let settings = {};
  if (raw.trim()) {
    try { settings = JSON.parse(raw); } catch (err) { fail(`Could not parse ${file}: ${err.message}\nFix the JSON and run setup again. Nothing was changed.`); }
  }
  if (!isMap(settings)) fail(`${file} is not a JSON object. Nothing was changed.`);
  if (settings.env !== undefined && !isMap(settings.env)) fail(`"env" in ${file} is not an object. Nothing was changed.`);
  if (settings.hooks !== undefined && !isMap(settings.hooks)) fail(`"hooks" in ${file} is not an object. Nothing was changed.`);
  return settings;
}

/** The hooks setup added (any version, any port, wherever the relay file was). */
function countOurs(settings) {
  let n = 0;
  if (!isMap(settings.hooks)) return 0;
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) if (g && Array.isArray(g.hooks)) n += g.hooks.filter(isOurs).length;
  }
  return n;
}

/** What setup recorded, in the current shape. A record from relay 1.2 or earlier (one part) is converted. */
function readMark(settings) {
  const env = isMap(settings.env) ? settings.env : null;
  if (!env || typeof env[MARK] !== 'string') return null;
  let m;
  try { m = JSON.parse(env[MARK]); } catch { return null; }
  if (!isMap(m)) return null;
  const map = v => (isMap(v) ? { ...v } : {});
  const events = v => (Array.isArray(v) ? v.filter(e => typeof e === 'string') : []);
  if (m.v === 2) {
    return {
      v: 2, createdEnv: !!m.createdEnv,
      telemetry: isMap(m.telemetry) ? { added: map(m.telemetry.added), replaced: map(m.telemetry.replaced), set: map(m.telemetry.set) } : null,
      hooks: isMap(m.hooks) ? { createdHooks: !!m.hooks.createdHooks, createdEvents: events(m.hooks.createdEvents) } : null,
    };
  }
  const added = map(m.added);
  const replaced = map(m.replaced);
  const createdEvents = events(m.createdEvents);
  return {
    v: 2, createdEnv: !!m.createdEnv,
    telemetry: Object.keys(added).length || Object.keys(replaced).length ? { added, replaced, set: map(m.set) } : null,
    hooks: countOurs(settings) || m.createdHooks || createdEvents.length ? { createdHooks: !!m.createdHooks, createdEvents } : null,
  };
}

/** Puts the record back (or takes it out when nothing setup added is left). */
function writeMark(settings, mark) {
  if (!mark.telemetry && !mark.hooks) {
    if (isMap(settings.env)) {
      delete settings.env[MARK];
      if (mark.createdEnv && !Object.keys(settings.env).length) delete settings.env;
    }
    return;
  }
  if (!isMap(settings.env)) { settings.env = {}; mark.createdEnv = true; }
  settings.env[MARK] = JSON.stringify(mark);
}

function telemetryEnv(base) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',   // traces with agent_id and parent_agent_id
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: base,
    OTEL_TRACES_EXPORT_INTERVAL: '1000',
    OTEL_LOGS_EXPORT_INTERVAL: '1000',
  };
}

/** Sets the telemetry variables that aren't set yet, recording each one. Returns the changes. */
function addTelemetry(settings, mark, base) {
  const ENV = telemetryEnv(base);
  if (!isMap(settings.env)) { settings.env = {}; mark.createdEnv = true; }
  const env = settings.env;
  const t = mark.telemetry || { added: {}, replaced: {}, set: {} };
  const current = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // Setup's own endpoint (another --port), or one the user already agreed to replace (--force).
  const ours = 'OTEL_EXPORTER_OTLP_ENDPOINT' in t.set && current === t.set.OTEL_EXPORTER_OTLP_ENDPOINT;
  const consented = 'OTEL_EXPORTER_OTLP_ENDPOINT' in t.replaced;
  if (current && current.replace(/\/$/, '') !== base && !flag('--force') && !ours && !consented) {
    fail(`Your settings already send telemetry to ${current}.\n` +
      'Claude Code sends OpenTelemetry to one endpoint, so pointing it at the relay would stop that.\n' +
      'Run again with --force to switch it anyway (setup --remove puts it back), or with --no-telemetry\n' +
      'to add only the hooks. Nothing was changed.');
  }
  for (const k of ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT']) {
    if (env[k]) console.warn(`Note: your settings set ${k}=${env[k]}, which takes priority over the relay for that signal.`);
  }
  const changes = [];
  for (const [k, v] of Object.entries(ENV)) {
    if (env[k] === v) continue;
    if (k in t.set && env[k] === t.set[k]) {
      // Set by an earlier setup, to another value: the record of what was there before stays.
      if (k in t.added) t.added[k] = v;
    } else if (k in env) {
      t.replaced[k] = env[k];
      delete t.added[k];
    } else {
      t.added[k] = v;
      delete t.replaced[k];
    }
    t.set[k] = v;
    env[k] = v;
    changes.push(`env ${k}=${v}`);
  }
  mark.telemetry = t;
  // Shell variables can take priority over settings for sessions started from that shell.
  for (const k of [...Object.keys(ENV), 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_METRICS_EXPORTER']) {
    const shell = process.env[k];
    if (shell !== undefined && shell !== ENV[k] && !(k === 'OTEL_EXPORTER_OTLP_ENDPOINT' && shell.replace(/\/$/, '') === base)) {
      console.warn(`Note: your shell exports ${k}=${shell}. Sessions started from this shell may use it instead.`);
    }
  }
  return changes;
}

/** Takes out the telemetry variables setup set (and puts back what they replaced). Returns how many. */
function removeTelemetry(settings, mark) {
  const t = mark.telemetry;
  if (!t) return 0;
  const env = isMap(settings.env) ? settings.env : {};
  let n = 0;
  for (const [k, v] of Object.entries(t.added)) if (env[k] === (k in t.set ? t.set[k] : v)) { delete env[k]; n++; }
  for (const [k, v] of Object.entries(t.replaced)) if (env[k] === t.set[k]) { env[k] = v; n++; }
  mark.telemetry = null;
  return n;
}

// One event's hook groups without setup's hooks.
function withoutOurs(groups) {
  const kept = [];
  let removed = 0;
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
    const rest = g.hooks.filter(h => !isOurs(h));
    removed += g.hooks.length - rest.length;
    if (rest.length === g.hooks.length) kept.push(g);
    else if (rest.length) kept.push({ ...g, hooks: rest });
  }
  return { kept, removed };
}

/** Adds the hook to each event that doesn't have exactly this one yet. Returns how many were written. */
function addHooks(settings, mark, hookCommand) {
  const h = mark.hooks || { createdHooks: false, createdEvents: [] };
  if (!isMap(settings.hooks)) { settings.hooks = {}; h.createdHooks = true; }
  let wrote = 0;
  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      if (!h.createdEvents.includes(event)) h.createdEvents.push(event);
    }
    const groups = settings.hooks[event];
    const ours = groups.flatMap(g => (g && Array.isArray(g.hooks) ? g.hooks.filter(isOurs) : []));
    if (ours.length === 1 && ours[0].command === hookCommand && ours[0].async === true && ours[0].timeout === 10) continue;
    // Missing, twice, or from another port, file or version: one current hook instead.
    const { kept } = withoutOurs(groups);
    kept.push({ hooks: [{ type: 'command', command: hookCommand, async: true, timeout: 10 }] });
    settings.hooks[event] = kept;
    wrote++;
  }
  mark.hooks = h;
  return wrote;
}

/** Takes out every hook setup added. Returns how many. */
function removeHooks(settings, mark) {
  const created = new Set(mark.hooks ? mark.hooks.createdEvents : []);
  let n = 0;
  if (isMap(settings.hooks)) {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      const { kept, removed } = withoutOurs(groups);
      n += removed;
      if (kept.length || !created.has(event)) settings.hooks[event] = kept;
      else delete settings.hooks[event];
    }
    if (mark.hooks && mark.hooks.createdHooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  }
  mark.hooks = null;
  return n;
}

function backupAndWrite(file, obj) {
  let bak = null;
  if (fs.existsSync(file)) {
    bak = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, bak);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return bak;
}

/**
 * What answers on the relay's port: "plugin" (the relay the plugin starts), "manual" (a relay
 * started by hand, which asks for its pairing code), "other" or "none". It asks /health as the lab
 * page would, which a relay answers with its version and mode and nothing else.
 */
export function probeRelay(port, timeout = 800) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout, headers: { Origin: SITE_ORIGINS[0] } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', () => resolve({ state: 'other' }));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        const version = body && typeof body.version === 'string' && TOKEN.test(body.version) ? body.version : null;
        if (res.statusCode === 200 && body && body.ok === true) resolve({ state: body.mode === 'plugin' ? 'plugin' : 'manual', version });
        else if (res.statusCode === 401) resolve({ state: 'manual', version });
        else resolve({ state: 'other' });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ state: 'other' }); });
    req.on('error', err => resolve({ state: err && err.code === 'ECONNREFUSED' ? 'none' : 'other' }));
  });
}

// The relay's part of setup's "Next" steps: nothing to start when a relay already answers, or
// when the plugin starts one.
function relaySteps(found, port, { telemetry, fromPlugin }) {
  const to = telemetry ? ': telemetry goes to it' : '';
  const v = found.version ? ` ${found.version}` : '';
  const portFlag = port === DEFAULT_PORT ? '' : ` --port ${port}`;
  if (found.state === 'plugin') return { note: `The plugin's relay${v} is running on port ${port}${to}.` };
  if (found.state === 'manual') return { note: `A relay started by hand${found.version ? ` (version ${found.version})` : ''} is running on port ${port}${to}.` };
  if (found.state === 'other') {
    return { step: `Something other than the relay answers on port ${port}. Stop it, or use another port for both:\n` +
      `     node constellation-relay.mjs setup${telemetry ? '' : ' --no-telemetry'} --port <n>   and   node constellation-relay.mjs --port <n>` };
  }
  if (fromPlugin) return { note: `The plugin starts its relay on port ${port} when a session starts.` };
  return { step: `Start the relay:  node constellation-relay.mjs${portFlag}` };
}

async function setup() {
  const PORT = portArg();
  const BASE = `http://127.0.0.1:${PORT}`;
  const SETTINGS = settingsPath();
  const PRINT = flag('--print');
  const REMOVE = flag('--remove');
  const TELEMETRY = !flag('--no-telemetry');
  const HOOKS = !flag('--no-hooks');
  // Run by the plugin's commands (/agent-constellation:telemetry, :remove-manual-hooks): the
  // plugin sends the hook events and starts the relay itself.
  const FROM_PLUGIN = flag('--plugin');
  const scope = TELEMETRY && HOOKS ? '' : TELEMETRY ? ' --no-hooks' : ' --no-telemetry';

  if (!TELEMETRY && !HOOKS) { console.log(`\nNothing to do with both --no-hooks and --no-telemetry. ${SETTINGS} was not changed.\n`); return; }
  if (FROM_PLUGIN && HOOKS && !REMOVE) fail('The plugin sends the hook events itself: run setup with --no-hooks. Nothing was changed.');
  const settings = readSettings(SETTINGS);
  const mark = readMark(settings) || { v: 2, createdEnv: false, telemetry: null, hooks: null };

  // ---- --remove (--no-hooks: telemetry only; --no-telemetry: hooks only)
  if (REMOVE) {
    const hadTelemetry = !!mark.telemetry;
    const hadHooks = !!mark.hooks || countOurs(settings) > 0;
    if (!(TELEMETRY && hadTelemetry) && !(HOOKS && hadHooks)) {
      const what = TELEMETRY && HOOKS ? 'nothing that setup added' : TELEMETRY ? 'no telemetry that setup turned on' : 'no hooks that setup added';
      console.log(`\nNothing to remove: ${SETTINGS} has ${what}. Nothing was changed.\n`);
      return;
    }
    const lines = [];
    if (TELEMETRY) lines.push(`  - ${removeTelemetry(settings, mark)} telemetry settings`);
    if (HOOKS) lines.push(`  - ${removeHooks(settings, mark)} hooks`);
    writeMark(settings, mark);
    if (PRINT) { console.log(`\nWould update ${SETTINGS}. Nothing was changed.\n${lines.join('\n')}\n`); return; }
    const bak = backupAndWrite(SETTINGS, settings);
    console.log(`\nUpdated ${SETTINGS}${bak ? `\nBackup saved as ${bak}` : ''}\n${lines.join('\n')}`);
    if (!HOOKS && countOurs(settings)) console.log(`The hooks setup added are still there. To remove them too:  ${FROM_PLUGIN ? PLUGIN_REMOVE_HOOKS : 'node constellation-relay.mjs setup --remove --no-telemetry'}`);
    if (!TELEMETRY && mark.telemetry) console.log('Telemetry stays on.');
    if (HOOKS && FROM_PLUGIN) console.log("The plugin's own hooks stay: they send the events from now on.");
    console.log('Start a new Claude Code session (or quit and reopen the desktop app) for this to take effect.\n');
    return;
  }

  // ---- add (or update): only what isn't set yet
  // The absolute path of Node: the desktop app doesn't always have "node" on its PATH.
  const hookCommand = `"${process.execPath}" "${SELF}" hook --via settings ${BASE}/hook`;
  const changes = TELEMETRY ? addTelemetry(settings, mark, BASE) : [];
  const hooksWritten = HOOKS ? addHooks(settings, mark, hookCommand) : 0;
  if (hooksWritten) changes.push(`${hooksWritten} background hooks: ${hookCommand}`);
  // What answers on the port decides the next steps (--print asks nothing).
  const relay = PRINT ? null : relaySteps(await probeRelay(PORT), PORT, { telemetry: TELEMETRY, fromPlugin: FROM_PLUGIN });

  if (!changes.length) {
    console.log(`\nAlready set; nothing changed in ${SETTINGS}.`);
    if (relay) console.log(relay.note || `Next: ${relay.step}`);
    console.log('');
    return;
  }
  writeMark(settings, mark);
  if (PRINT) {
    console.log(`\nWould update ${SETTINGS}. Nothing was changed.\n`);
    for (const c of changes) console.log(`  + ${c}`);
    console.log('');
    return;
  }

  const bak = backupAndWrite(SETTINGS, settings);
  console.log(`\nUpdated ${SETTINGS}${bak ? `\nBackup saved as ${bak}` : ''}`);
  for (const c of changes) console.log(`  + ${c}`);
  const steps = [];
  if (relay.step) steps.push(relay.step);
  steps.push('Start a new Claude Code session (or quit and reopen the desktop app).\n     Settings are read when a session starts.');
  console.log(`${relay.note ? `\n${relay.note}` : ''}\nNext:`);
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  const undo = FROM_PLUGIN ? PLUGIN_TELEMETRY_OFF : `node constellation-relay.mjs setup --remove${scope}`;
  console.log(`\nTo undo:  ${undo}`);
  if (hooksWritten) console.log('The hooks run this file from where it is now. If you move it or change Node versions, run setup again.');
  console.log('');
}

// ---------------------------------------------------------------- status

async function status() {
  const PORT = portArg();
  const BASE = `http://127.0.0.1:${PORT}`;
  const SETTINGS = settingsPath();
  const FROM_PLUGIN = flag('--plugin');
  let settings = {};
  let note = '';
  if (!fs.existsSync(SETTINGS)) note = ' (no such file yet)';
  else {
    try {
      const raw = fs.readFileSync(SETTINGS, 'utf8');
      settings = raw.trim() ? JSON.parse(raw) : {};
      if (!isMap(settings)) { settings = {}; note = ' (not a JSON object)'; }
    } catch { settings = {}; note = ' (could not be parsed)'; }
  }
  const env = isMap(settings.env) ? settings.env : {};
  const mark = readMark(settings);
  const endpoint = typeof env.OTEL_EXPORTER_OTLP_ENDPOINT === 'string' ? env.OTEL_EXPORTER_OTLP_ENDPOINT : '';
  const on = env.CLAUDE_CODE_ENABLE_TELEMETRY === '1' && endpoint;
  const toRelay = on && endpoint.replace(/\/$/, '') === BASE;
  const telemetry = !on ? 'off'
    : toRelay ? `on, to the relay (${BASE})${mark && mark.telemetry ? '' : ', not set by setup'}`
    : `on, to ${endpoint} (not the relay on port ${PORT})`;
  const hooks = countOurs(settings);
  const found = await probeRelay(PORT);
  const v = found.version ? `, version ${found.version}` : '';
  const relay = found.state === 'plugin' ? `the plugin's relay${v}`
    : found.state === 'manual' ? `a relay started by hand${v || ' (version 1.2 or earlier)'}; it asks for its pairing code`
    : found.state === 'other' ? 'something other than the relay'
    : 'nothing (the plugin starts its relay when a session starts)';
  console.log(`
Settings file: ${SETTINGS}${note}
  Telemetry:              ${telemetry}
  Hooks that setup added: ${hooks ? `${hooks}${FROM_PLUGIN ? ': the plugin sends the same events, so each one arrives twice' : ''}` : 'none'}
Relay on port ${PORT}: ${relay}
`);
  if (FROM_PLUGIN) {
    console.log(`Turn telemetry ${on && toRelay ? 'off:  /agent-constellation:telemetry off' : 'on:   /agent-constellation:telemetry on'}`);
    if (hooks) console.log(`Remove the manual hooks:  ${PLUGIN_REMOVE_HOOKS}`);
    console.log('');
  }
}

// ---------------------------------------------------------------- the relay in the background

// The relay in plugin mode, detached from whoever starts it, with nothing attached to its input or
// output. If another one takes the port first, this one exits at once.
function spawnPluginRelay(port) {
  const args = [SELF, '--plugin', '--port', String(port)];
  for (const o of String(process.env[ENV_ORIGINS] || '').split(',').map(s => s.trim()).filter(Boolean)) args.push('--origin', o);
  let home;
  try { home = os.homedir(); } catch { home = undefined; }
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', cwd: home, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

/**
 * Makes sure a relay answers on the port, as the plugin's hooks do: when nothing listens there,
 * starts one in plugin mode and waits until it answers (at most `wait` ms). Resolves to what
 * answers then ({ state: "plugin" | "manual" | "other" | "none", version, started }). Used by the
 * plugin's /agent-constellation:open.
 */
export async function ensureRelay({ port = DEFAULT_PORT, wait = 3000 } = {}) {
  let found = await probeRelay(port);
  if (found.state !== 'none') return { ...found, started: false };
  spawnPluginRelay(port);
  const until = Date.now() + wait;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 100));
    found = await probeRelay(port, 500);
    if (found.state !== 'none') return { ...found, started: true };
  }
  return { ...found, started: true };
}

// ---------------------------------------------------------------- hook: the forwarder

// Claude Code runs this in the background for every hook event. It must never slow a session
// down or change what it does: it prints nothing, gives up after about 2 seconds and always
// exits 0, whether or not the relay is running.
//
// With --start (the plugin's hooks), a relay that isn't running is started first: in plugin
// mode, detached from Claude Code, with nothing attached to its input or output. Only when
// nothing at all accepts connections on the port: if another program holds it, nothing starts.
// Two hooks starting one at the same moment are fine: the second relay finds the port taken and
// exits.
function hookForward() {
  const done = () => process.exit(0);
  process.on('uncaughtException', done);
  process.on('unhandledRejection', done);
  const startedAt = Date.now();
  setTimeout(done, 2000).unref();
  const START = flag('--start');
  let port = DEFAULT_PORT;
  const envPort = Number(process.env[ENV_PORT]);
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536) port = envPort;
  // hook [--start] [--via plugin|settings] [<url>]
  let url;
  let via;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--via') via = argv[++i];
    else if (!argv[i].startsWith('-') && !url) url = argv[i];
  }
  let target;
  try { target = new URL(url || `http://127.0.0.1:${port}/hook`); } catch { return done(); }
  if (target.protocol !== 'http:' || !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(target.hostname)) return done();

  let started = false;
  function startRelayInBackground() {
    started = true;
    spawnPluginRelay(target.port || '80');
  }

  function post(body) {
    const req = http.request({
      hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 80, path: target.pathname, method: 'POST', timeout: 1500,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'X-Hook-Ts': String(startedAt) },
    }, res => { res.resume(); res.on('end', done); res.on('error', done); });
    req.on('timeout', () => { req.destroy(); done(); });
    req.on('error', err => {
      // No relay: start one (once), then try again until it listens or the 2 s are up.
      if (START && err && err.code === 'ECONNREFUSED' && target.hostname === '127.0.0.1') {
        if (!started) startRelayInBackground();
        setTimeout(() => post(body), 100);
        return;
      }
      done();
    });
    req.end(body);
  }

  const chunks = [];
  let size = 0;
  process.stdin.on('data', c => {
    size += c.length;
    if (size > 32 * HOOK_MAX_BYTES) done();
    chunks.push(c);
  });
  process.stdin.on('error', done);
  process.stdin.on('end', () => {
    let raw, payload;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      payload = stripHook(raw);
    } catch { return done(); }
    if (!payload) return done();
    // The transcript paths go to the relay, over loopback, so it can read the token numbers in
    // them. The relay never passes them on.
    for (const k of ['transcript_path', 'agent_transcript_path']) {
      if (typeof raw[k] === 'string' && raw[k].length < 4096) payload[k] = raw[k];
    }
    // Which hooks ran this (the plugin's, or the ones setup added): for the relay only, which
    // drops the second copy of an event when both are installed.
    if (via === 'plugin' || via === 'settings') payload.via = via;
    post(Buffer.from(JSON.stringify(payload)));
  });
}

// ---------------------------------------------------------------- main

let isMain = false;
try { isMain = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { isMain = false; }
if (isMain) {
  if (flag('--help') || flag('-h') || command === 'help') console.log(HELP);
  else if (command === 'start') startRelay();
  else if (command === 'setup') setup();
  else if (command === 'status') status();
  else if (command === 'hook') hookForward();
  else fail(`Unknown command "${command}". Run: node constellation-relay.mjs --help`);
}
