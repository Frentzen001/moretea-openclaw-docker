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

# Install OpenClaw and mcporter globally
RUN npm install -g openclaw mcporter

# Set up OpenClaw config directories
RUN mkdir -p /root/.openclaw/workspace /root/.openclaw/agents/main/agent /root/robot

# Copy OpenClaw config
COPY openclaw.json /root/.openclaw/openclaw.json

# Copy API key auth profiles
COPY auth-profiles.json /root/.openclaw/agents/main/agent/auth-profiles.json

# Install the MCP bridge used by the direct robot runtime
RUN openclaw plugins install @aiwerk/openclaw-mcp-bridge

# Surgical fix for openai-responses-shared.js (@mariozechner/pi-ai):
# Bug 1 — mimeType is undefined when MCP ImageContent arrives → "image/jpeg" fallback
# Bug 2 — item.data may be a Buffer (JS MCP SDK decodes base64 to binary on parse)
#          so ${item.data} in a template literal produces garbage; re-encode to base64.
RUN sed -i \
    -e 's/${item\.mimeType}/${item.mimeType || "image\/jpeg"}/g' \
    -e 's/${block\.mimeType}/${block.mimeType || "image\/jpeg"}/g' \
    -e 's/${item\.data}/${typeof item.data==="string"?item.data:Buffer.from(item.data).toString("base64")}/g' \
    -e 's/${block\.data}/${typeof block.data==="string"?block.data:Buffer.from(block.data).toString("base64")}/g' \
    /usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js

# SKILL.md goes into openclaw skills registry so it gets discovered and loaded
RUN mkdir -p /root/.openclaw/skills/community-robot
COPY skills/SKILL.md /root/.openclaw/skills/community-robot/SKILL.md

# Store canonical config and initial memory seeds at /root/config/ (outside the workspace
# volume). The entrypoint copies SOUL.md and HEARTBEAT.md to the workspace on every start
# so that image rebuilds take effect immediately, and seeds corrections.md / experience.md
# on first run only so that accumulated memories are preserved across container recreations.
RUN mkdir -p /root/config
COPY workspace-soul.md /root/config/SOUL.md
COPY HEARTBEAT.md /root/config/HEARTBEAT.md
COPY skills/experience.md /root/config/experience.md
RUN touch /root/config/corrections.md

# Knowledge base files go into ~/robot/ where SKILL.md tells the LLM to read from
COPY skills/memory.md /root/robot/memory.md
COPY skills/about.md /root/robot/about.md
COPY skills/ambassadors.md /root/robot/ambassadors.md
COPY skills/events.md /root/robot/events.md
COPY skills/facilities.md /root/robot/facilities.md
COPY skills/projects.md /root/robot/projects.md
COPY skills/programmes.md /root/robot/programmes.md
RUN touch /root/robot/log.md

# Install an entrypoint that seeds the workspace volume with the optional
# mcporter config if the mounted volume does not already contain one.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /root

# Expose isolated gateway port (18790 — does not conflict with host 18789)
EXPOSE 18790

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["openclaw", "gateway"]
