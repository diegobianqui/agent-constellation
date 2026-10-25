---
name: telemetry
description: Turns Claude Code's telemetry (each model call's duration and estimated cost, and traces) on or off for the agent constellation lab, by editing the user's Claude Code settings. Only when the user runs it.
argument-hint: "[on|off]"
disable-model-invocation: true
allowed-tools:
  - 'Bash(node "${CLAUDE_PLUGIN_ROOT}/relay/constellation-relay.mjs" setup --no-hooks --plugin)'
  - 'Bash(node "${CLAUDE_PLUGIN_ROOT}/relay/constellation-relay.mjs" setup --remove --no-hooks --plugin)'
  - 'Bash(node "${CLAUDE_PLUGIN_ROOT}/relay/constellation-relay.mjs" status --plugin)'
  - 'PowerShell(node "${CLAUDE_PLUGIN_ROOT}/relay/constellation-relay.mjs" setup --no-hooks --plugin)'
  - 'PowerShell(node "${CLAUDE_PLUGIN_ROOT}/relay/constellation-relay.mjs" setup --remove --no-hooks --plugin)'
  - 'PowerShell(node "${CLAUDE_PLUGIN_ROOT}/relay/constellation-relay.mjs" status --plugin)'
---

# Telemetry for the agent constellation lab

The user typed: `/agent-constellation:telemetry $ARGUMENTS`

Run exactly one of these commands with the Bash tool (on Windows, the PowerShell tool works too: the
commands are the same in both), chosen by the first word the user typed, and nothing else. Copy it
exactly as written here.

- `on`: `node "${CLAUDE_PLUGIN_ROOT}/relay/constellation-relay.mjs" setup --no-hooks --plugin`
- `off`: `node "${CLAUDE_PLUGIN_ROOT}/relay/constellation-relay.mjs" setup --remove --no-hooks --plugin`
- no word, or any other word: `node "${CLAUDE_PLUGIN_ROOT}/relay/constellation-relay.mjs" status --plugin`

What the commands do: `on` adds Claude Code's OpenTelemetry settings to the user's Claude Code
settings file (`settings.json`), pointed at the plugin's relay on 127.0.0.1, after saving a backup.
It adds no hooks: the plugin's own hooks send the hook events. `off` takes out exactly what `on`
added and puts back any value it replaced. Hooks are left as they are either way. `status` changes
nothing.

Then show the user the command's output as it is, in a code block, with no summary of your own
before it. If the output says the file was updated, add one sentence after it: the change applies
to Claude Code sessions started from now on (a session that is already open keeps its old
settings; in the desktop app, quit and reopen it).

Don't edit any file yourself, don't run any other command, and don't retry with other flags if a
command fails: show its output and stop. If the output says the settings already send telemetry to
another address, tell the user that `on` stops there so their own telemetry keeps working, and that
they can decide to switch it by running `node constellation-relay.mjs setup --no-hooks --force`
themselves.
