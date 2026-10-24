# agent-constellation

Shows your own Claude Code sessions in the agent constellation lab at
https://diegobianqui.com/lab/constellation. Install, then run `/agent-constellation:open` in a
session (or open the lab and press **Connect Claude Code**).

- `hooks/hooks.json`: 16 background hooks. Each strips its hook payload and posts the rest to a
  relay on `127.0.0.1:4318`. On SessionStart and UserPromptSubmit they start the relay if nothing
  listens there.
- `relay/constellation-relay.mjs`: the relay, one file, no dependencies. It passes the lab page in
  your browser only the shape of the activity (agents, tools, timings, models, token counts, the
  project folder's name and the session title), never prompts, replies, commands, paths, tool
  inputs or outputs. Token counts come from the session transcripts on your computer: only the
  numbers are kept. It stops by itself after 30 minutes unused.
- No pairing code: only `https://diegobianqui.com` (exact origin) may read the relay. Programs on
  your computer could read it, as they could read the transcripts themselves.
- `skills/open`: `/agent-constellation:open` starts the relay if none runs and opens the lab in
  your browser, connected (`scripts/open-lab.mjs`).
- `skills/telemetry`: `/agent-constellation:telemetry on` (or `off`) adds (or takes out) Claude
  Code's telemetry settings, for model call durations and estimated costs. It runs the relay's
  `setup --no-hooks`, saves a backup first and adds no hooks.
- `skills/remove-manual-hooks`: `/agent-constellation:remove-manual-hooks` takes out the hooks a
  manual `node constellation-relay.mjs setup` added, so events aren't sent twice.
- These commands run only when you type them: Claude never runs them on its own, and no hook
  opens a browser.

Needs Node.js 18 or later as `node` on the PATH. Sessions in the cloud (Claude Code on the web)
can't be shown. Remove with `/plugin uninstall agent-constellation` (run `/agent-constellation:telemetry off` first if
you turned telemetry on).

Full documentation: https://github.com/diegobianqui/agent-constellation
