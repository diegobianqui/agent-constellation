---
name: remove-manual-hooks
description: Removes the constellation relay hooks that were added by hand to the user's Claude Code settings (node constellation-relay.mjs setup), so that only the plugin's hooks send events and each event is not sent twice. Only when the user runs it.
disable-model-invocation: true
allowed-tools:
  - 'Bash(node "${CLAUDE_PLUGIN_ROOT}/relay/constellation-relay.mjs" setup --remove --no-telemetry --plugin)'
---

# Remove the manual constellation hooks

Run exactly this command with the Bash tool, and nothing else:

`node "${CLAUDE_PLUGIN_ROOT}/relay/constellation-relay.mjs" setup --remove --no-telemetry --plugin`

What it does: it takes out of the user's Claude Code settings file (`settings.json`) the hooks
that `node constellation-relay.mjs setup` added there, after saving a backup. It leaves the
telemetry settings and every other hook as they are. The plugin's own hooks are not in that file,
so they stay and keep sending the events.

Then show the user the command's output as it is, in a code block, with no summary of your own
before it. If the output says the file was updated, add one sentence after it: the change applies
to Claude Code sessions started from now on (in the desktop app, quit and reopen it).

Don't edit any file yourself, don't run any other command, and don't retry with other flags if the
command fails: show its output and stop.
