# Agent constellation for Claude Code

[![test](https://github.com/diegobianqui/agent-constellation/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/diegobianqui/agent-constellation/actions/workflows/test.yml)

A Claude Code plugin that shows your own Claude Code sessions in the
[agent constellation lab](https://diegobianqui.com/lab/constellation): each session drawn as a
constellation of its main agent, the subagents it starts and the tools they use, with token
counts per agent and per model.

Only the shape of the activity leaves your computer's relay, and only to the lab page open in your
own browser. Never prompts, replies, commands, file paths, tool inputs or outputs.

Tested on macOS, Linux and Windows (Git Bash and PowerShell): CI runs the tests and an end-to-end
test with Claude Code's CLI on each (see [Windows, Linux and macOS](#windows-linux-and-macos)).

## Install

**Claude Code in a terminal.** In a session:

```
/plugin marketplace add diegobianqui/agent-constellation
/plugin install agent-constellation@agent-constellation
/reload-plugins
```

Choose a scope in the panel that opens (for you, on every project: "Install for you"). If the
install summary already says the plugin is active, `/reload-plugins` changes nothing.

**Desktop app.** Its plugin browser lists plugins only from marketplaces you already added. So
send this message in a Claude Code session in the desktop app. It carries one exact command, so
Claude has nothing to look for: the command finds Claude Code's command, checks for Node.js 18 or
newer, adds the marketplace and installs the plugin. Running it twice is harmless ("already
installed"). If Claude Code's command or Node.js is missing, it says so in one line, with what to
do.

Claude Code's command is `claude` on the PATH. A Mac with only the desktop app may have no `claude`
in Terminal: the app keeps its own copy under
`~/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude`
(seen on macOS, not documented), and the command uses it. On Windows and Linux there is no such
fallback: without `claude` on the PATH, the message says to install Claude Code for the terminal
(https://code.claude.com/docs/en/setup) and send it again. On Windows the command needs Claude
Code's Bash tool, which needs [Git for Windows](https://git-scm.com/downloads/win) (without it,
Claude Code runs commands in PowerShell, where this command doesn't run): otherwise use the two
`claude plugin` commands below in a terminal.

````
Install the agent-constellation plugin for Claude Code. Run this exact command once with Bash and nothing else (it finds Claude Code's own command even when `claude` isn't on the PATH; running it twice is harmless). Don't search for files or run other checks first. Reply with only the command's last line, then: "Start a new session, then run /agent-constellation:open." If the line is an error, show it and stop.

```
C="$(command -v claude || ls -dt "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -1)"; [ -n "$C" ] || { echo "Claude Code's command wasn't found on this computer: install Claude Code for the terminal (code.claude.com/docs/en/setup), then send this message again."; exit 1; }; node -e 'process.exit(parseInt(process.versions.node)<18?1:0)' 2>/dev/null || { echo "The plugin needs Node.js 18 or newer: nodejs.org"; exit 1; }; "$C" plugin marketplace add diegobianqui/agent-constellation >/dev/null && "$C" plugin install agent-constellation@agent-constellation 2>&1 | tail -1
```
````

Then start a new session (plugins and hooks load when a session starts) and run
`/agent-constellation:open` in it.

Where `claude` works in a terminal, the same in two commands, once:

```
claude plugin marketplace add diegobianqui/agent-constellation
claude plugin install agent-constellation@agent-constellation
```

With Claude Code 2.1.292 or later, one command does both:
`claude plugin install agent-constellation --marketplace diegobianqui/agent-constellation`.
The terminal, the desktop app's local sessions and the VS Code extension read the same settings,
so the plugin then appears on the desktop app's Plugins page and is on in the local sessions you
start next. These two commands are the same on macOS, Windows and Linux.

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
download, no settings to edit, no pairing code. That button is the only place the page connects
from; **Back to simulation** disconnects.

Needs Node.js 18 or newer, as `node` on the PATH that Claude Code runs hooks with: check with
`node -v`.

## Updating from an earlier version

In a terminal where `claude` works:

```
claude plugin marketplace update agent-constellation
claude plugin update agent-constellation@agent-constellation
```

Then type `/reload-plugins` in an open session, or start a new session.

On a Mac with only the desktop app, Claude Code's command is the desktop app's copy (above). The
install message above doesn't update a plugin that is already installed (it answers "already
installed"), so send this one in a Claude Code session in the desktop app instead. It is the same
message with the update commands:

````
Update the agent-constellation plugin for Claude Code. Run this exact command once with Bash and nothing else (it finds Claude Code's own command even when `claude` isn't on the PATH; running it twice is harmless). Don't search for files or run other checks first. Reply with only the command's last line, then: "Start a new session for the new version to load." If the line is an error, show it and stop.

```
C="$(command -v claude || ls -dt "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | head -1)"; [ -n "$C" ] || { echo "Claude Code's command wasn't found on this computer: install Claude Code for the terminal (code.claude.com/docs/en/setup), then send this message again."; exit 1; }; node -e 'process.exit(parseInt(process.versions.node)<18?1:0)' 2>/dev/null || { echo "The plugin needs Node.js 18 or newer: nodejs.org"; exit 1; }; "$C" plugin marketplace update agent-constellation >/dev/null && "$C" plugin update agent-constellation@agent-constellation 2>&1 | tail -1
```
````

Not installed yet? Send the install message above.

## What it does

The plugin adds background hooks (`async`, silent, at most about 2 seconds, always exit 0) for 16
hook events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure,
PermissionRequest, Notification, SubagentStart, SubagentStop, Stop, StopFailure, PreCompact,
PostCompact, TaskCreated, TaskCompleted and SessionEnd. Each one strips the hook payload and posts
what is left to a relay on `127.0.0.1:4318`. (On Windows, a hook that starts the relay may take up
to 6 seconds; see [Windows, Linux and macOS](#windows-linux-and-macos).)

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

### Token counts and costs without telemetry

Hook events don't carry token counts. When a hook event names the session's transcript (the
JSONL file Claude Code keeps on your computer), the relay reads the lines added since its last read
and keeps, for each model call, only: input, output, cache read and cache creation tokens (and how
many of those went to the 1-hour cache), the model name, the request id, and whether the call used
fast mode or US-only inference. The text stays in the file, and the transcript's path never leaves
the relay. Reads are incremental and bounded (a transcript seen for the first time: its last
32 MB; at most 8 MB per pass, then it continues), and a line still being written waits for the
next read. A subagent's calls are read from its own transcript and counted on its star.

The lab page estimates each of these calls' cost from its tokens at the Claude API's list prices,
and shows it with "≈". On a Pro or Max plan that is what the same use would cost on the API, not
what you pay. Calls of a model it has no price for show "no price for" that model.

## What leaves the relay

To the lab page in your browser, and nowhere else: event names, session, agent and tool use ids,
agent types and tool names, timings, success flags, permission modes, model names, request ids
and token counts, and two names so you can tell your sessions apart: the project folder's name (never its
path) and the session's title.

Never: prompts, replies, commands, file paths, tool inputs or outputs, error messages, your email,
account or organization ids. Nothing is sent to diegobianqui.com or to any other server: the page
talks to the relay from your browser, over your computer's loopback interface. The relay keeps the
last events in memory only and forgets them when it stops.

"Scan sessions" on the page lists your sessions from the last 24 hours, from the file names and
times in `~/.claude/projects`. Then the relay reads those sessions' token numbers (as above, the
same limits), so sessions that were already running when you installed the plugin, which send no
hook events until they restart, show their tokens and estimated costs too.

Sessions that run in the cloud (Claude Code on the web) can't reach your computer, so they can't
be shown.

## Security: no pairing code

The relay has no pairing code, whether the plugin starts it or you start it by hand (relay 1.5 and
later). What protects it instead:

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
than the stream does.

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

Telemetry is counted per session. A session whose telemetry reaches the relay has each call
counted from its own events, with Claude Code's own cost estimate; its transcript fills in only the
calls from before its telemetry started (a session that was running when you turned telemetry on,
or a relay started later), and each call is counted once, by its request id. Sessions without
telemetry keep their token counts from the transcripts, whatever other sessions do.

## Without the plugin

The relay also runs by hand, with the same protections and no pairing code:

```
curl -fO https://diegobianqui.com/relay/constellation-relay.mjs
node constellation-relay.mjs setup      # telemetry and hooks; a backup is saved first
node constellation-relay.mjs            # then open the lab and press Connect Claude Code
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

### An older relay holds port 4318

The plugin starts nothing when another program listens on 4318: its hooks post to that program.
A relay from 1.5 on, started by hand, works with the lab as the plugin's does. An older one started
by hand (1.4 or earlier) asks for a pairing code, which the lab no longer takes: the lab says it
found one and how to stop it, so the plugin can start its own:

```
lsof -nP -iTCP:4318 -sTCP:LISTEN
kill <PID>
```

## Windows, Linux and macOS

[CI](https://github.com/diegobianqui/agent-constellation/actions/workflows/test.yml) runs on every
push and pull request, on GitHub's Ubuntu, macOS and Windows runners:

- `npm test`, with Node.js 18 and 22.
- An end-to-end test, `e2e/e2e.mjs`, with Claude Code's own CLI from npm (the version in
  `package.json`) and Node.js 22, in a temp `HOME` and `CLAUDE_CONFIG_DIR`, with no account and no
  model: a dummy API key, and Claude Code pointed at a closed port or at a stand-in for the Claude
  API (`e2e/mock-api.mjs`) that runs the plugin's commands as a model would. It installs the plugin
  (from the checkout, and from GitHub), runs `claude plugin validate --strict`, and runs real
  `claude -p` sessions. It checks that the hooks fire and start the relay on port 4318 in plugin
  mode, in the background, and that it keeps running after the session ends; that only
  `https://diegobianqui.com` and `https://www.diegobianqui.com` can read it (other origins and no
  origin: 403); that no text from the prompt reaches the stream; that the token numbers of the
  session's model calls come out of its own transcript; that `/agent-constellation:open`,
  `/agent-constellation:telemetry` (alone, `on`, `off`) and `/agent-constellation:remove-manual-hooks`
  run their command with no permission prompt; that hooks added by `setup` fire next to the
  plugin's and their copies are dropped; that `scripts/open-lab.mjs` starts the relay or finds it
  and opens the lab's address; and the desktop install message's command (no `claude`: the one-line
  error; with `claude`: installs, and a second time says "already installed").
- On Windows, three ways: started from Git Bash; started from PowerShell, with the commands run by
  Claude Code's PowerShell tool next to Git Bash (`CLAUDE_CODE_USE_POWERSHELL_TOOL=1`; some accounts
  have it on by default); and with Git for Windows hidden, where Claude Code runs the hooks and the
  commands with PowerShell. All of the
  above passes in each, and `start` opens the runner's default browser at the lab's address (the
  test points it at a local page and sees the browser ask for it, `&` and all). The desktop install
  message is a POSIX shell command, so it needs Git Bash: without it, use the two `claude plugin`
  commands.
- Linux also in Docker on your own computer: `e2e/docker/linux.sh` runs `npm test` and the
  end-to-end test on Debian with Node.js 18 or 22, on arm64 or x64 (see [Tests](#tests)).

What CI can't show: the Claude desktop app on Windows and Linux (its local sessions use the same
settings and plugins as the CLI, but they aren't tested); a real browser on the lab page, which
asks before a public page reaches `127.0.0.1` (Chrome's local network access prompt) and then
connects; that no window shows when the relay starts on a Windows desktop (it is started hidden,
with `windowsHide`); `xdg-open` and `open` opening a real browser on a Linux or macOS desktop (the
test stubs them and checks what they are given); and WSL. Report what you find at
https://github.com/diegobianqui/agent-constellation/issues.

What the plugin relies on there:

- The hooks run `node "<plugin folder>/relay/constellation-relay.mjs" hook …`, which works the same
  in `sh`, Git Bash and PowerShell (the shells Claude Code runs hooks with). Node.js 18 or newer
  must be on the PATH Claude Code runs hooks with.
- The relay starts in the background, detached and with no window (`windowsHide`). On Windows a
  connection to a port where nothing listens is refused only after about 2 seconds, so a hook that
  starts the relay waits up to 6 seconds there (in the background; sessions never wait for it).
- `/agent-constellation:open` opens the browser with `open` (macOS), `start` (Windows) or
  `xdg-open` (Linux). Where none works (for example WSL without a browser bridge), it says so and
  prints the address to open yourself.
- The plugin's commands (`/agent-constellation:open`, `:telemetry`, `:remove-manual-hooks`) run
  one `node` command with Claude Code's Bash tool or, on Windows, its PowerShell tool: the command
  is the same in both, and each is pre-approved for both.
- The hooks `setup` adds (without the plugin) start with Node's absolute path on macOS and Linux,
  and with `node` on Windows (relay 1.5.1 and later), so they run in PowerShell too. Ran setup on
  Windows with an older relay? Run it again: it updates them.
- Transcripts are found where Claude Code keeps them (`~/.claude/projects`, or
  `$CLAUDE_CONFIG_DIR/projects`), with Windows paths too. The relay never reads a transcript
  through a symbolic link, on Windows too (relay 1.5.1 and later).

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

The end-to-end test needs port 4318 free (it starts the plugin's relay there, as a session does),
so run it in a container or on a CI runner rather than next to a relay you use. On Linux in Docker,
with nothing from your own `~/.claude` (the container has its own network, so its port 4318 isn't
yours, and it is removed when it ends):

```
e2e/docker/linux.sh                                  # node:22-bookworm-slim, this computer's arch
e2e/docker/linux.sh node:18-bookworm-slim            # Node.js 18
e2e/docker/linux.sh node:22-bookworm-slim linux/amd64
E2E_ARGS=--github e2e/docker/linux.sh                # also install from GitHub
```

Elsewhere, with Claude Code's CLI on the PATH: `node e2e/e2e.mjs` (it refuses to run while
anything listens on port 4318).

## License

MIT. See [LICENSE](LICENSE).
