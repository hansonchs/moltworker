#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox (v2)
# This script:
# 1. Restores config/workspace/skills from R2 via rclone (if configured)
# 2. Runs openclaw onboard --non-interactive to configure from env vars
# 3. Patches config for features onboard doesn't cover (channels, gateway auth)
# 4. Starts a background sync loop (rclone, watches for file changes)
# 5. Starts the gateway

set -e

if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "OpenClaw gateway is already running, exiting."
    exit 0
fi

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
WORKSPACE_DIR="/root/clawd"
SKILLS_DIR="/root/clawd/skills"
RCLONE_CONF="/root/.config/rclone/rclone.conf"
LAST_SYNC_FILE="/tmp/.last-sync"

echo "Config directory: $CONFIG_DIR"

mkdir -p "$CONFIG_DIR"

# ============================================================
# RCLONE SETUP
# ============================================================

r2_configured() {
    [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ] && [ -n "$CF_ACCOUNT_ID" ]
}

R2_BUCKET="${R2_BUCKET_NAME:-moltbot-data}"

setup_rclone() {
    mkdir -p "$(dirname "$RCLONE_CONF")"
    cat > "$RCLONE_CONF" << EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_ACCESS_KEY_ID
secret_access_key = $R2_SECRET_ACCESS_KEY
endpoint = https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF
    touch /tmp/.rclone-configured
    echo "Rclone configured for bucket: $R2_BUCKET"
}

RCLONE_FLAGS="--transfers=16 --fast-list --s3-no-check-bucket"

# ============================================================
# RESTORE FROM R2
# ============================================================

if r2_configured; then
    setup_rclone

    echo "Checking R2 for existing backup..."
    # Check if R2 has an openclaw config backup
    # Only copy openclaw.json directly (avoid listing thousands of polluted objects)
    echo "Restoring openclaw.json from R2..."
    rclone copyto "r2:${R2_BUCKET}/openclaw/openclaw.json" "$CONFIG_FILE" $RCLONE_FLAGS 2>&1 \
        && echo "Config restored from R2" \
        || echo "No config in R2 (or copy failed), will onboard fresh"

    # Restore workspace in background (non-blocking, exclude node_modules)
    # This runs in background so gateway can start immediately
    mkdir -p "$WORKSPACE_DIR"
    (
        echo "Background: restoring workspace from R2 (excluding node_modules)..."
        rclone copy "r2:${R2_BUCKET}/workspace/" "$WORKSPACE_DIR/" $RCLONE_FLAGS \
            --exclude='node_modules/**' --exclude='.git/**' -v 2>&1 \
            || echo "WARNING: workspace restore failed with exit code $?"
        echo "Background: workspace restore complete"
    ) &
    echo "Workspace restore started in background (PID: $!)"

    # Restore cron jobs (small, fast, blocking)
    mkdir -p "$CONFIG_DIR/cron"
    rclone copy "r2:${R2_BUCKET}/openclaw-cron/" "$CONFIG_DIR/cron/" $RCLONE_FLAGS 2>&1 \
        && echo "Cron jobs restored from R2" \
        || echo "No cron jobs in R2 (or copy failed)"

    # Restore skills
    REMOTE_SK_COUNT=$(rclone ls "r2:${R2_BUCKET}/skills/" $RCLONE_FLAGS 2>/dev/null | wc -l)
    if [ "$REMOTE_SK_COUNT" -gt 0 ]; then
        echo "Restoring skills from R2 ($REMOTE_SK_COUNT files)..."
        mkdir -p "$SKILLS_DIR"
        rclone copy "r2:${R2_BUCKET}/skills/" "$SKILLS_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: skills restore failed with exit code $?"
        echo "Skills restored"
    fi

    # Restore doctor marker (skip doctor if version unchanged)
    rclone copyto "r2:${R2_BUCKET}/openclaw/.doctor-done" "$CONFIG_DIR/.doctor-done" $RCLONE_FLAGS 2>/dev/null \
        && echo "Doctor marker restored from R2" \
        || echo "No doctor marker in R2"

    # Restore identity + paired devices (blocking — required for Slack pairing to survive restarts)
    for SUBDIR in identity devices; do
        mkdir -p "$CONFIG_DIR/$SUBDIR"
        rclone copy "r2:${R2_BUCKET}/openclaw/$SUBDIR/" "$CONFIG_DIR/$SUBDIR/" $RCLONE_FLAGS 2>&1 \
            && echo "$SUBDIR restored from R2" \
            || echo "No $SUBDIR in R2 (or copy failed)"
    done

    # Restore sessions (blocking — critical for conversation continuity)
    SESSIONS_DIR="$CONFIG_DIR/agents"
    REMOTE_SESS_COUNT=$(rclone ls "r2:${R2_BUCKET}/openclaw/agents/" $RCLONE_FLAGS 2>/dev/null | wc -l)
    if [ "$REMOTE_SESS_COUNT" -gt 0 ]; then
        echo "Restoring sessions from R2 ($REMOTE_SESS_COUNT files)..."
        mkdir -p "$SESSIONS_DIR"
        rclone copy "r2:${R2_BUCKET}/openclaw/agents/" "$SESSIONS_DIR/" $RCLONE_FLAGS -v 2>&1 \
            || echo "WARNING: sessions restore failed with exit code $?"
        echo "Sessions restored"
    else
        echo "No sessions in R2"
    fi

    # Restore cron logs (non-critical, best effort)
    rclone copyto "r2:${R2_BUCKET}/logs/movie-qa.log" /tmp/movie-qa.log $RCLONE_FLAGS 2>/dev/null \
        && echo "Cron log restored from R2" \
        || echo "No cron log in R2"
else
    echo "R2 not configured, starting fresh"
fi

# Clean up stale session lock files from previous container instances
find "$CONFIG_DIR" -name '*.lock' -type f -delete 2>/dev/null && echo "Stale lock files cleaned" || true

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, running openclaw onboard..."

    AUTH_ARGS=""
    if [ -n "$CLOUDFLARE_AI_GATEWAY_API_KEY" ] && [ -n "$CF_AI_GATEWAY_ACCOUNT_ID" ] && [ -n "$CF_AI_GATEWAY_GATEWAY_ID" ]; then
        AUTH_ARGS="--auth-choice cloudflare-ai-gateway-api-key \
            --cloudflare-ai-gateway-account-id $CF_AI_GATEWAY_ACCOUNT_ID \
            --cloudflare-ai-gateway-gateway-id $CF_AI_GATEWAY_GATEWAY_ID \
            --cloudflare-ai-gateway-api-key $CLOUDFLARE_AI_GATEWAY_API_KEY"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        AUTH_ARGS="--auth-choice apiKey --anthropic-api-key $ANTHROPIC_API_KEY"
    elif [ -n "$OPENAI_API_KEY" ]; then
        AUTH_ARGS="--auth-choice openai-api-key --openai-api-key $OPENAI_API_KEY"
    fi

    openclaw onboard --non-interactive --accept-risk \
        --mode local \
        $AUTH_ARGS \
        --gateway-port 18789 \
        --gateway-bind lan \
        --skip-channels \
        --skip-skills \
        --skip-health

    echo "Onboard completed"
else
    echo "Using existing config"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, trusted proxies)
# ============================================================
# openclaw onboard handles provider/model config, but we need to patch in:
# - Channel config (Telegram, Discord, Slack)
# - Gateway token auth
# - Trusted proxies for sandbox networking
# - Base URL override for legacy AI Gateway path
node << 'EOFPATCH'
const fs = require('fs');

const configPath = '/root/.openclaw/openclaw.json';
console.log('Patching config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Clean stale keys from R2 backups that may have been written by newer OpenClaw versions
// and would fail strict config validation on the pinned version (see #47)
if (config.commands) {
    delete config.commands.ownerDisplay;
    delete config.commands.restart;
}

// Reset meta.lastTouchedVersion to avoid "config was written by newer version" warning
if (config.meta) {
    delete config.meta.lastTouchedVersion;
    delete config.meta.lastTouchedAt;
}

// Agent defaults (thinkingDefault must be 'off' for models that don't support thinking)
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
if (!config.agents.defaults.thinkingDefault) {
    config.agents.defaults.thinkingDefault = 'off';
}

// Message settings (ackReactionScope 'direct' limits reaction attempts to DMs only,
// avoiding missing_scope errors on channel messages where reactions:write is needed)
config.messages = config.messages || {};
config.messages.ackReactionScope = 'direct';

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
    // 2026.2.26 requires allowedOrigins for non-loopback controlUi
    config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
}

// Legacy AI Gateway base URL override:
// ANTHROPIC_BASE_URL is picked up natively by the Anthropic SDK,
// so we don't need to patch the provider config. Writing a provider
// entry without a models array breaks OpenClaw's config validation.

// AI Gateway model override (CF_AI_GATEWAY_MODEL=provider/model-id)
// Adds a provider entry for any AI Gateway provider and sets it as default model.
// Examples:
//   workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
//   openai/gpt-4o
//   anthropic/claude-sonnet-4-5
if (process.env.CF_AI_GATEWAY_MODEL) {
    const raw = process.env.CF_AI_GATEWAY_MODEL;
    const slashIdx = raw.indexOf('/');
    const gwProvider = raw.substring(0, slashIdx);
    const modelId = raw.substring(slashIdx + 1);

    const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
    const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
    const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

    let baseUrl;
    if (accountId && gatewayId) {
        baseUrl = 'https://gateway.ai.cloudflare.com/v1/' + accountId + '/' + gatewayId + '/' + gwProvider;
        if (gwProvider === 'workers-ai') baseUrl += '/v1';
    } else if (gwProvider === 'workers-ai' && process.env.CF_ACCOUNT_ID) {
        baseUrl = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID + '/ai/v1';
    }

    if (baseUrl && apiKey) {
        const api = gwProvider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
        const providerName = 'cf-ai-gw-' + gwProvider;

        config.models = config.models || {};
        config.models.providers = config.models.providers || {};
        config.models.providers[providerName] = {
            baseUrl: baseUrl,
            apiKey: apiKey,
            api: api,
            models: [{ id: modelId, name: modelId, contextWindow: 131072, maxTokens: 8192 }],
        };
        config.agents = config.agents || {};
        config.agents.defaults = config.agents.defaults || {};
        config.agents.defaults.model = { primary: providerName + '/' + modelId };
        console.log('AI Gateway model override: provider=' + providerName + ' model=' + modelId + ' via ' + baseUrl);
    } else {
        console.warn('CF_AI_GATEWAY_MODEL set but missing required config (account ID, gateway ID, or API key)');
    }
}

// Telegram configuration
// Overwrite entire channel object to drop stale keys from old R2 backups
// that would fail OpenClaw's strict config validation (see #47)
if (process.env.TELEGRAM_BOT_TOKEN) {
    const dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
    config.channels.telegram = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        enabled: true,
        dmPolicy: dmPolicy,
    };
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (dmPolicy === 'open') {
        config.channels.telegram.allowFrom = ['*'];
    }
}

// Discord configuration
// Discord uses a nested dm object: dm.policy, dm.allowFrom (per DiscordDmConfig)
if (process.env.DISCORD_BOT_TOKEN) {
    const dmPolicy = process.env.DISCORD_DM_POLICY || 'pairing';
    const dm = { policy: dmPolicy };
    if (dmPolicy === 'open') {
        dm.allowFrom = ['*'];
    }
    config.channels.discord = {
        token: process.env.DISCORD_BOT_TOKEN,
        enabled: true,
        dm: dm,
    };
}

// Slack configuration
// streaming: false works around openclaw/openclaw#20337 where chat.stopStream
// fails with missing_recipient_team_id on group channel threads
// 2026.2.26: dm.policy → dmPolicy, dm.allowFrom → allowFrom (flat keys)
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true,
        streaming: false,
        dmPolicy: 'open',
        allowFrom: ['*'],
        channels: {
            '*': {
                allow: true,
                requireMention: true,
            },
        },
    };
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');
EOFPATCH

# ============================================================
# CRON: Movie QA Check (workdays 11:00 HKT = 03:00 UTC)
# ============================================================
MOVIE_QA_SCRIPT="/root/clawd/skills/movie-qa-check/scripts/check.mjs"
if [ -f "$MOVIE_QA_SCRIPT" ]; then
    # Install cron at runtime if not present (avoids large Docker layer rebuild)
    if ! command -v cron &>/dev/null; then
        echo "Installing cron..."
        apt-get update -qq && apt-get install -y -qq cron >/dev/null 2>&1
    fi
    RCLONE_CRON_FLAGS="--s3-no-check-bucket --config /root/.config/rclone/rclone.conf"
    echo "0 3 * * 1-5 /usr/local/bin/node $MOVIE_QA_SCRIPT >> /tmp/movie-qa.log 2>&1; rclone copyto /tmp/movie-qa.log r2:${R2_BUCKET}/logs/movie-qa.log $RCLONE_CRON_FLAGS 2>/dev/null" | crontab -
    cron
    echo "Movie QA cron job installed (workdays 03:00 UTC / 11:00 HKT)"
fi

# ============================================================
# BACKGROUND SYNC LOOP
# ============================================================
if r2_configured; then
    echo "Starting background R2 sync loop..."
    (
        MARKER=/tmp/.last-sync-marker
        LOGFILE=/tmp/r2-sync.log
        touch "$MARKER"

        while true; do
            sleep 30

            CHANGED=/tmp/.changed-files
            {
                find "$CONFIG_DIR" -newer "$MARKER" -type f -printf '%P\n' 2>/dev/null
                find "$WORKSPACE_DIR" -newer "$MARKER" \
                    -not -path '*/node_modules/*' \
                    -not -path '*/.git/*' \
                    -type f -printf '%P\n' 2>/dev/null
            } > "$CHANGED"

            COUNT=$(wc -l < "$CHANGED" 2>/dev/null || echo 0)

            if [ "$COUNT" -gt 0 ]; then
                echo "[sync] Uploading changes ($COUNT files) at $(date)" >> "$LOGFILE"
                rclone copyto "$CONFIG_FILE" "r2:${R2_BUCKET}/openclaw/openclaw.json" \
                    $RCLONE_FLAGS 2>> "$LOGFILE"
                # Sync doctor marker
                if [ -f "$CONFIG_DIR/.doctor-done" ]; then
                    rclone copyto "$CONFIG_DIR/.doctor-done" "r2:${R2_BUCKET}/openclaw/.doctor-done" \
                        $RCLONE_FLAGS 2>> "$LOGFILE"
                fi
                # Sync cron jobs and sessions (small files, critical for persistence)
                if [ -d "$CONFIG_DIR/cron" ]; then
                    rclone copy "$CONFIG_DIR/cron/" "r2:${R2_BUCKET}/openclaw-cron/" \
                        $RCLONE_FLAGS 2>> "$LOGFILE"
                fi
                if [ -d "$WORKSPACE_DIR" ]; then
                    rclone sync "$WORKSPACE_DIR/" "r2:${R2_BUCKET}/workspace/" \
                        $RCLONE_FLAGS --exclude='skills/**' --exclude='.git/**' --exclude='node_modules/**' 2>> "$LOGFILE"
                fi
                if [ -d "$SKILLS_DIR" ]; then
                    rclone sync "$SKILLS_DIR/" "r2:${R2_BUCKET}/skills/" \
                        $RCLONE_FLAGS 2>> "$LOGFILE"
                fi
                # Sync sessions to R2 (use copy, not sync, to avoid deleting
                # R2 files if container restarted before restore completed)
                if [ -d "$CONFIG_DIR/agents" ]; then
                    rclone copy "$CONFIG_DIR/agents/" "r2:${R2_BUCKET}/openclaw/agents/" \
                        $RCLONE_FLAGS --exclude='*.lock' 2>> "$LOGFILE"
                fi
                # Sync identity + paired devices to R2 (persist pairing across restarts)
                for SUBDIR in identity devices; do
                    if [ -d "$CONFIG_DIR/$SUBDIR" ]; then
                        rclone copy "$CONFIG_DIR/$SUBDIR/" "r2:${R2_BUCKET}/openclaw/$SUBDIR/" \
                            $RCLONE_FLAGS 2>> "$LOGFILE"
                    fi
                done
                date -Iseconds > "$LAST_SYNC_FILE"
                touch "$MARKER"
                echo "[sync] Complete at $(date)" >> "$LOGFILE"
            fi
        done
    ) &
    echo "Background sync loop started (PID: $!)"
fi

# ============================================================
# DOCTOR FIX (only on version upgrade — saves 3-4 min + 1GB RAM)
# ============================================================
DOCTOR_MARKER="$CONFIG_DIR/.doctor-done"
CURRENT_VERSION=$(openclaw --version 2>/dev/null || echo "unknown")
LAST_DOCTOR_VERSION=$(cat "$DOCTOR_MARKER" 2>/dev/null || echo "none")

if [ "$CURRENT_VERSION" != "$LAST_DOCTOR_VERSION" ]; then
    echo "Version changed ($LAST_DOCTOR_VERSION -> $CURRENT_VERSION), running doctor --fix..."
    openclaw doctor --fix 2>&1 || echo "Doctor fix completed (or no changes needed)"
    echo "$CURRENT_VERSION" > "$DOCTOR_MARKER"
    echo "Doctor marker saved for version $CURRENT_VERSION"
else
    echo "Skipping doctor --fix (already ran for $CURRENT_VERSION)"
fi

# ============================================================
# START GATEWAY (restart loop — auto-recover from crashes)
# ============================================================
echo "Starting OpenClaw Gateway (with auto-restart)..."
echo "Gateway will be available on port 18789"

GATEWAY_ARGS="--port 18789 --verbose --allow-unconfigured --bind lan"
if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    GATEWAY_ARGS="$GATEWAY_ARGS --token $OPENCLAW_GATEWAY_TOKEN"
    echo "Auth: token"
else
    echo "Auth: device pairing"
fi

echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}"

RESTART_COUNT=0
MAX_FAST_RESTARTS=5
FAST_RESTART_WINDOW=30

while true; do
    rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
    rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

    START_TIME=$(date +%s)
    echo "[gateway] Starting (restart #$RESTART_COUNT) at $(date)"

    openclaw gateway $GATEWAY_ARGS 2>&1 || true

    END_TIME=$(date +%s)
    RUNTIME=$((END_TIME - START_TIME))
    RESTART_COUNT=$((RESTART_COUNT + 1))

    echo "[gateway] Exited after ${RUNTIME}s (restart #$RESTART_COUNT) at $(date)"

    # If gateway ran for a while, reset the fast restart counter
    if [ "$RUNTIME" -gt "$FAST_RESTART_WINDOW" ]; then
        RESTART_COUNT=0
    fi

    # Prevent crash loop: if it keeps dying within 30s, back off
    if [ "$RESTART_COUNT" -ge "$MAX_FAST_RESTARTS" ]; then
        echo "[gateway] Too many fast restarts ($MAX_FAST_RESTARTS), waiting 60s..."
        sleep 60
        RESTART_COUNT=0
    else
        echo "[gateway] Restarting in 5s..."
        sleep 5
    fi
done
