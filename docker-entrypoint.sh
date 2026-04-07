#!/usr/bin/env bash
set -euo pipefail

mkdir -p /root/.openclaw/workspace

# Always refresh config files from the baked-in image copies so that rebuilding
# the image takes effect immediately (the workspace is a persistent volume and
# would otherwise keep stale versions of these files indefinitely).
cp /root/config/SOUL.md      /root/.openclaw/workspace/SOUL.md
cp /root/config/HEARTBEAT.md /root/.openclaw/workspace/HEARTBEAT.md

# Seed unified memory file on first run only — preserve accumulated data on
# subsequent container recreations.
[ -f /root/.openclaw/workspace/MEMORY.md ] || cp /root/config/MEMORY.md /root/.openclaw/workspace/MEMORY.md

exec "$@"
