# A clean Linux with Node.js and Claude Code's CLI from npm, for e2e/docker/linux.sh.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
ARG CLAUDE_CODE_VERSION
# git: the tests read an older relay from this repository's history, and `claude plugin
# marketplace add <owner>/<repo>` clones with it.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/*
RUN test -n "$CLAUDE_CODE_VERSION" && npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && claude --version
# Not root: as a user would run it.
USER node
WORKDIR /home/node
