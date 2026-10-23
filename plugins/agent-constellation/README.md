# agent-constellation

Shows your own Claude Code sessions in the agent constellation lab at
https://diegobianqui.com/lab/constellation. Install, start or continue a session, open the lab and
press **Connect Claude Code**.

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

Needs Node.js 18 or later as `node` on the PATH. Sessions in the cloud (Claude Code on the web)
can't be shown. Remove with `/plugin uninstall agent-constellation`.

Full documentation: https://github.com/diegobianqui/agent-constellation
