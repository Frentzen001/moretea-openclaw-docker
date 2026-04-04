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

# SKILL.md goes into openclaw skills registry so it gets discovered and loaded
RUN mkdir -p /root/.openclaw/skills/community-robot
COPY skills/SKILL.md /root/.openclaw/skills/community-robot/SKILL.md

# Override SOUL.md with robot identity so it's always active regardless of skill detection
COPY workspace-soul.md /root/.openclaw/workspace/SOUL.md

# Heartbeat instructions for background memory consolidation
COPY HEARTBEAT.md /root/.openclaw/workspace/HEARTBEAT.md

# Keep a template mcporter config outside the mounted workspace volume.
# It is retained only as an optional diagnostic artifact; OpenClaw runtime
# access to the robot comes from the MCP bridge configured in openclaw.json.
COPY mcporter.json /opt/rosclaw/mcporter.json

# Knowledge base files go into ~/robot/ where SKILL.md tells the LLM to read from
COPY skills/memory.md /root/robot/memory.md
COPY skills/about.md /root/robot/about.md
COPY skills/ambassadors.md /root/robot/ambassadors.md
COPY skills/events.md /root/robot/events.md
COPY skills/facilities.md /root/robot/facilities.md
COPY skills/projects.md /root/robot/projects.md
COPY skills/programmes.md /root/robot/programmes.md
RUN touch /root/robot/corrections.md /root/robot/log.md
COPY skills/experience.md /root/robot/experience.md

# Install an entrypoint that seeds the workspace volume with the optional
# mcporter config if the mounted volume does not already contain one.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /root/.mcporter \
    && ln -s /root/.openclaw/workspace/mcporter.json /root/.mcporter/mcporter.json

WORKDIR /root

# Expose isolated gateway port (18790 — does not conflict with host 18789)
EXPOSE 18790

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["openclaw", "gateway"]
