---
name: open
description: Opens the agent constellation lab in the user's browser, connected to this computer's Claude Code sessions, after making sure the plugin's relay is running. Only when the user runs it.
disable-model-invocation: true
allowed-tools:
  - 'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/open-lab.mjs")'
---

# Open the agent constellation lab

Run exactly this command with the Bash tool, and nothing else:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/open-lab.mjs"`

What it does: if no relay answers on 127.0.0.1:4318, it starts the plugin's relay there, as the
plugin's hooks do. Then it opens https://diegobianqui.com/lab/constellation?connect=claude-code in
the default browser; the page connects to the relay by itself. It prints one line saying what it
did.

Then show the user that line as it is, with nothing added before it. Don't run any other command,
don't open anything else, and don't retry if it fails: show its output and stop.
