FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install base dependencies
RUN apt-get update && apt-get install -y \
    curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install OpenClaw globally
RUN npm install -g openclaw

# Set up OpenClaw config directories
RUN mkdir -p /root/.openclaw/workspace /root/.openclaw/agents/main/agent /root/robot

# Copy OpenClaw config
COPY openclaw.json /root/.openclaw/openclaw.json

# Copy API key auth profiles
COPY auth-profiles.json /root/.openclaw/agents/main/agent/auth-profiles.json

# Install the MCP bridge used by the direct robot runtime
RUN openclaw plugins install @aiwerk/openclaw-mcp-bridge

# Patch openai-responses-shared.js to handle image content from all sources:
# - Anthropic SDK wrapped: { source: { type:"base64", data:"...", media_type:"..." } }
# - Raw MCP ImageContent:  { data:"...", mimeType:"..." }
# - mcp-bridge stripped:   { text: JSON.stringify(originalItem) }  ← root cause of the original bug
COPY patch-openai-responses.js /tmp/patch-openai-responses.js
RUN node /tmp/patch-openai-responses.js && rm /tmp/patch-openai-responses.js

# SKILL.md goes into openclaw skills registry so it gets discovered and loaded
RUN mkdir -p /root/.openclaw/skills/community-robot
COPY garage_knowledge/SKILL.md /root/.openclaw/skills/community-robot/SKILL.md

# Store canonical config at /root/config/ (outside the workspace volume).
# The entrypoint copies SOUL.md and HEARTBEAT.md to the workspace on every start
# so that image rebuilds take effect immediately.
RUN mkdir -p /root/config
COPY workspace/SOUL.md /root/config/SOUL.md
COPY workspace/HEARTBEAT.md /root/config/HEARTBEAT.md
RUN touch /root/config/corrections.md /root/config/experience.md

# Knowledge base files are served via bind mount (./skills:/root/robot) at runtime.
# No COPY needed — the bind mount gives the container direct access to the host files,
# so edits to skills/ take effect without rebuilding the image.
RUN mkdir -p /root/robot

# Install an entrypoint that seeds the workspace volume on first start.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /root

# Expose isolated gateway port (18790 — does not conflict with host 18789)
EXPOSE 18790

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["openclaw", "gateway"]
