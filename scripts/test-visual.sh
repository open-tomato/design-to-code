#!/usr/bin/env bash
# Visual regression suite, run natively (no Docker).
# Baselines are per-environment and untracked: a machine only diffs against
# baselines it generated itself.
#
# The suite runs the shared harness (harness/.storybook) for the project
# D2C_PROJECT names; harness/.storybook/test-runner.ts keeps its snapshots
# and diffs under that project's baselineDir.
#
# Usage:
#   scripts/test-visual.sh            # assert against this env's baselines
#   scripts/test-visual.sh --update   # (re)generate this env's baselines
set -euo pipefail
cd "$(dirname "$0")/.."

# 6016, not 6006 — must not collide with a `storybook dev` session.
PORT="${VISUAL_PORT:-6016}"

# Jest args after `--`: always write the JSON report to visual-report.json.
# --update adds -u to overwrite existing baselines.
JEST_ARGS="--json --outputFile=visual-report.json"
if [[ "${1:-}" == "--update" ]]; then
  JEST_ARGS="$JEST_ARGS -u"
fi

# The harness config directory; `bun run build:storybook` builds the same one.
CONFIG_DIR="harness/.storybook"

# `bun x`, the subcommand form of `bunx`, is used throughout.
# Browsers for the pinned playwright version (no-op when already installed).
bun x playwright install chromium

bun run build:storybook

# CI and GITHUB_ACTIONS are cleared for the jest child on purpose: when jest
# detects CI (it checks both variables) it refuses to write missing snapshots
# and fails them instead. The suite protects existing baselines: changed
# pixels still fail, and a new story writes its baseline and passes.
bun x concurrently -k -s first \
  "bun scripts/serve-static.ts storybook-static ${PORT}" \
  "bun x wait-on tcp:127.0.0.1:${PORT} && CI= GITHUB_ACTIONS= bun x test-storybook --config-dir ${CONFIG_DIR} --url http://127.0.0.1:${PORT} -- ${JEST_ARGS}"
