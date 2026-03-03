# Use existing built image as base to avoid re-pulling cloudflare/sandbox:0.7.0
# The 03f3a171 image already has: Node 22, rclone, pnpm, openclaw 2026.2.19-2
FROM moltbot-sandbox-sandbox:03f3a171

# Upgrade OpenClaw to 2026.3.1
RUN npm install -g openclaw@2026.3.1 \
    && npm cache clean --force \
    && rm -rf /tmp/* \
    && openclaw --version

# Copy updated startup script (fixes for 2026.2.26 compat)
COPY start-openclaw.sh /usr/local/bin/start-openclaw.sh
RUN chmod +x /usr/local/bin/start-openclaw.sh

# Copy custom skills and bot instructions
COPY skills/ /root/clawd/skills/
COPY CLAUDE.md /root/clawd/CLAUDE.md

# Deploy marker
RUN echo "deployed-2026-03-03b" > /root/.deploy-version

# Set working directory
WORKDIR /root/clawd

# Expose the gateway port
EXPOSE 18789
