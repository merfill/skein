#!/usr/bin/env bash
# Render the Harbor config and run it with the RouterAI key forwarded to the
# container as OPENAI_API_KEY. Key resolution order: $ROUTERAI_API_KEY,
# $OPENAI_API_KEY, $SKEIN_API_KEY, then ~/.config/opencode/opencode.json.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

node "$here/prepare.mjs"

key="${ROUTERAI_API_KEY:-${OPENAI_API_KEY:-${SKEIN_API_KEY:-}}}"
if [ -z "$key" ] && [ -f "$HOME/.config/opencode/opencode.json" ]; then
  key="$(node -e "const p=process.env.HOME+'/.config/opencode/opencode.json';const j=require(p);process.stdout.write(j?.provider?.routerai?.options?.apiKey ?? '')")"
fi
if [ -z "$key" ]; then
  echo "no RouterAI key (set ROUTERAI_API_KEY or configure ~/.config/opencode/opencode.json)" >&2
  exit 1
fi

cd "$repo"
OPENAI_API_KEY="$key" exec harbor run --config "$here/skein.yaml" -y "$@"
