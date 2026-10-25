#!/bin/sh
# Runs the tests and the end-to-end test (e2e/e2e.mjs) in a clean Linux container, with Claude
# Code's CLI from npm. The checkout is mounted read-only and copied inside; nothing from your own
# ~/.claude is mounted, and the container has its own network, so the relay it starts on port 4318
# is not yours. The container is removed when it ends.
#
#   e2e/docker/linux.sh                                 node:22-bookworm-slim, this machine's arch
#   e2e/docker/linux.sh node:18-bookworm-slim
#   e2e/docker/linux.sh node:22-bookworm-slim linux/amd64
#   E2E_ARGS=--github e2e/docker/linux.sh               also install from GitHub
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${1:-node:22-bookworm-slim}"
PLATFORM="${2:-}"
VERSION="$(node -p "require('$ROOT/package.json').config.claudeCodeVersion")"
ARCH="${PLATFORM:-native}"
TAG="agent-constellation-e2e:$(echo "$IMAGE-$ARCH-cc$VERSION" | tr ':/' '--')"

echo "== building $TAG (Claude Code $VERSION on $IMAGE${PLATFORM:+, $PLATFORM})"
docker build -q ${PLATFORM:+--platform "$PLATFORM"} --build-arg NODE_IMAGE="$IMAGE" --build-arg CLAUDE_CODE_VERSION="$VERSION" -t "$TAG" "$ROOT/e2e/docker" >/dev/null

docker run --rm ${PLATFORM:+--platform "$PLATFORM"} -v "$ROOT:/src:ro" -e E2E_ARGS="${E2E_ARGS:-}" "$TAG" sh -c '
  set -e
  cp -r /src "$HOME/agent-constellation" && cd "$HOME/agent-constellation"
  git config --global --add safe.directory "$PWD" 2>/dev/null || true
  echo "== $(uname -sm), node $(node -v), $(claude --version)"
  echo "== npm test"
  npm test 2>&1 | grep -E "^(not ok|# (tests|pass|fail|skipped))" || true
  npm test >/dev/null 2>&1 || { echo "npm test FAILED"; npm test 2>&1 | grep -B2 -A30 "^not ok" | head -120; exit 1; }
  echo "== e2e"
  node e2e/e2e.mjs $E2E_ARGS
'
