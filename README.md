# Agent constellation for Claude Code

A Claude Code plugin that shows your own Claude Code sessions in the
[agent constellation lab](https://diegobianqui.com/lab/constellation): each session drawn as a
constellation of its main agent, the subagents it starts and the tools they use, with token
counts per agent and per model.

Only the shape of the activity leaves your computer's relay, and only to the lab page open in your
own browser. Never prompts, replies, commands, file paths, tool inputs or outputs.

## Install

**Claude Code in a terminal.** In a session:

```
/plugin marketplace add diegobianqui/agent-constellation
/plugin install agent-constellation@agent-constellation
/reload-plugins
```

Choose a scope in the panel that opens (for you, on every project: "Install for you"). If the
install summary already says the plugin is active, `/reload-plugins` changes nothing.

**Desktop app.** Its plugin browser lists plugins only from marketplaces you already added, so
add this one from a terminal, once:

```
claude plugin marketplace add diegobianqui/agent-constellation
claude plugin install agent-constellation@agent-constellation
```

With Claude Code 2.1.292 or later, one command does both:
`claude plugin install agent-constellation --marketplace diegobianqui/agent-constellation`.
The terminal, the desktop app's local sessions and the VS Code extension read the same settings,
so the plugin then appears on the desktop app's Plugins page and is on in the local sessions you
start next.

**VS Code.** Type `/plugins` in the Claude Code panel to open **Manage plugins**. On the
**Marketplaces** tab, add `diegobianqui/agent-constellation`; on the **Plugins** tab, click
**Install** on agent-constellation and choose **Install for you**. Or open this link, which asks
before it adds anything:

```
vscode://anthropic.claude-code/install-plugin?plugin=agent-constellation&marketplace=diegobianqui/agent-constellation
```

Then, in a Claude Code session on this computer, run:

```
/agent-constellation:open
```

It starts the plugin's relay if none is running and opens
https://diegobianqui.com/lab/constellation?connect=claude-code in your default browser (`open` on
macOS, `xdg-open` on Linux, `start` on Windows); the page connects by itself. Or open the lab
yourself, after a session started or sent a prompt, and press **Connect Claude Code**. No
download, no settings to edit, no pairing code.

Needs Node.js 18 or later, as `node` on the PATH that Claude Code runs hooks with.

## What it does

The plugin adds background hooks (`async`, silent, at most about 2 seconds, always exit 0) for 16
hook events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure,
PermissionRequest, Notification, SubagentStart, SubagentStop, Stop, StopFailure, PreCompact,
PostCompact, TaskCreated, TaskCompleted and SessionEnd. Each one strips the hook payload and posts
what is left to a relay on `127.0.0.1:4318`.

On SessionStart and UserPromptSubmit, if nothing listens on port 4318, the hook starts the relay
in the background (detached from Claude Code, nothing attached to its input or output). One relay
serves every session on the computer. It stops by itself after 30 minutes with no hook events and
no page connected; the next session or prompt starts it again. If another program holds port
4318 (for example a relay you started by hand), the plugin starts nothing and posts its events to
that program.

It also adds three commands, which run only when you type them (Claude never runs them on its
own): `/agent-constellation:open` (above), `/agent-constellation:telemetry` (on, off, or alone to
see what is set) and `/agent-constellation:remove-manual-hooks` (below). Nothing opens a browser
from a hook or on install: only `/agent-constellation:open` does, when you run it.

The relay is one file with no dependencies, `plugins/agent-constellation/relay/constellation-relay.mjs`.
Read it before you install: the comment at the top says exactly what it does.

### Token counts without telemetry

Hook events don't carry token counts. When a hook event names the session's transcript (the
JSONL file Claude Code keeps on your computer), the relay reads the lines added since its last read
and keeps, for each model call, only: input, output, cache read and cache creation tokens, the model
name and the request id. The text stays in the file, and the transcript's path never leaves the
relay. Reads are incremental, bounded, and a line still being written waits for the next read. A
subagent's calls are read from its own transcript and counted on its star.

## What leaves the relay

To the lab page in your browser, and nowhere else: event names, session, agent and tool use ids,
agent types and tool names, timings, success flags, permission modes, model names and token
counts, and two names so you can tell your sessions apart: the project folder's name (never its
path) and the session's title.

Never: prompts, replies, commands, file paths, tool inputs or outputs, error messages, your email,
account or organization ids. Nothing is sent to diegobianqui.com or to any other server: the page
talks to the relay from your browser, over your computer's loopback interface. The relay keeps the
last events in memory only and forgets them when it stops.

"Scan sessions" on the page lists your sessions from the last 24 hours: the relay reads only the
file names and times in `~/.claude/projects` for that, never their contents.

Sessions that run in the cloud (Claude Code on the web) can't reach your computer, so they can't
be shown.

## Security: no pairing code

The relay the plugin starts has no pairing code. What protects it instead:

- It listens on `127.0.0.1` only: nothing on your network can reach it.
- Its stream (`/events`, `/health`, `/sessions`) answers only requests whose `Origin` is exactly
  `https://diegobianqui.com` or `https://www.diegobianqui.com`, and only those get the CORS header
  that lets a page read the answer. Other websites can't read it, and a request with no `Origin`
  at all (an image tag, a script that doesn't say where it comes from) is refused.
- It refuses requests addressed to any other host name than `127.0.0.1`, `localhost` or `[::1]`, so
  a site can't reach it by pointing its own domain at your computer (DNS rebinding).
- It refuses any event posted from a web page (a browser always sends `Origin` on a POST; Claude
  Code's hooks never do), so no website can feed it fake activity.

The trade-off: programs running on your computer as you can read the stream, since they can send
any `Origin` they like. They could already read the transcripts themselves, which hold far more
than the stream does. If you want a pairing code anyway, start the relay by hand (below): the
plugin then posts to it and starts nothing.

## Advanced: telemetry (model calls, costs)

Claude Code's OpenTelemetry adds each model call's duration and estimated cost, and traces. With the
plugin installed, type in a Claude Code session:

```
/agent-constellation:telemetry on
```

It runs the bundled relay's `setup --no-hooks`, which adds the telemetry settings to your Claude
Code settings (`~/.claude/settings.json`, a backup is saved first) and adds no hooks, since the
plugin sends the hook events. It shows what changed; start a new session for it to apply.
`/agent-constellation:telemetry off` takes out exactly what `on` added and puts back any value it
replaced; `/agent-constellation:telemetry` alone shows what is set. Neither touches any hook.
Claude never runs these commands on its own (`disable-model-invocation`): only when you type them.

When telemetry arrives, its own events are the source of token counts and the transcripts are not
counted again.

Without the plugin, use the relay by hand, with a pairing code:

```
curl -fO https://diegobianqui.com/relay/constellation-relay.mjs
node constellation-relay.mjs setup      # telemetry and hooks; a backup is saved first
node constellation-relay.mjs            # prints the pairing code to paste in the lab
```

`node constellation-relay.mjs setup --remove` undoes exactly what setup added (`--no-hooks`: only
the telemetry; `--no-telemetry`: only the hooks). Running setup again with nothing to change
changes nothing and saves no backup. `node constellation-relay.mjs status` shows what is set and
what answers on port 4318.

### Hooks installed twice

If you ran `setup` without `--no-hooks` before installing the plugin, each event is sent twice:
by the hooks in your settings and by the plugin's. Each copy says which hooks sent it, and the
relay passes on one copy of each pair (same event, session, tool use, agent and task, within
5 seconds) and drops the other, so nothing is counted twice. Copies from one kind of hooks are
never dropped. The lab page then says so, once; remove the manual hooks with:

```
/agent-constellation:remove-manual-hooks
```

It takes out the hooks `setup` added and leaves the telemetry settings and your other hooks as
they are.

### A relay started by hand holds port 4318

The plugin starts nothing when another program listens on 4318: its hooks post to that program.
A relay you started by hand (or an older one) asks for its pairing code, and the lab says which
one it found. Paste its code, or stop it so the plugin can start its own:

```
lsof -nP -iTCP:4318 -sTCP:LISTEN
kill <PID>
```

## Remove

If you turned telemetry on, turn it off first (otherwise Claude Code keeps sending it to a port
where nothing listens):

```
/agent-constellation:telemetry off
/plugin uninstall agent-constellation
/plugin marketplace remove agent-constellation
```

A running relay stops by itself within 30 minutes, or stop it now: it is the `node` process running
`constellation-relay.mjs --plugin`. The plugin writes nothing to disk, except the settings that
`/agent-constellation:telemetry on` and `/agent-constellation:remove-manual-hooks` change when you
run them (each saves a backup first).

## The relay's source

The relay has one source of truth: the file the lab serves at
https://diegobianqui.com/relay/constellation-relay.mjs. The copy in this repository is that file,
byte for byte. To update it:

```
node scripts/sync-relay.mjs            # copy the published file here
node scripts/sync-relay.mjs --check    # exit 1 if the copy differs from it
```

Pass a path instead of the default URL to sync from a local checkout of the site.

## Tests

```
npm test
```

Runs the relay on free ports other than 4318, with `HOME` and `CLAUDE_CONFIG_DIR` in a temp folder,
and setup on temp settings files only. `claude plugin validate --strict .` and
`claude plugin validate --strict plugins/agent-constellation` check the manifests.

## License

MIT. See [LICENSE](LICENSE).
