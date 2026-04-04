#!/usr/bin/env bash
set -euo pipefail

mkdir -p /root/.openclaw/workspace /root/.mcporter

if [ ! -f /root/.openclaw/workspace/mcporter.json ]; then
  cp /opt/rosclaw/mcporter.json /root/.openclaw/workspace/mcporter.json
fi

if [ ! -L /root/.mcporter/mcporter.json ] && [ ! -f /root/.mcporter/mcporter.json ]; then
  ln -sf /root/.openclaw/workspace/mcporter.json /root/.mcporter/mcporter.json
fi

# OpenClaw uses openclaw-mcp-bridge directly for robot runtime access.
# The mcporter config above is kept only for manual diagnostics.

exec "$@"
