# Movie6 OpenClaw 部署管理

## 項目概述

Moltbot Sandbox — 基於 [hansonchs/moltworker](https://github.com/hansonchs/moltworker)（fork from [cloudflare/moltworker](https://github.com/cloudflare/moltworker)）嘅 OpenClaw AI 助手部署，運行喺 Cloudflare Workers + Sandbox Containers 上。

> **重要**：用 fork 而唔係 upstream，防止 upstream auto-deploy 覆蓋我哋嘅自訂設定。Fork 嘅 GitHub Actions 已 disable。

## 基礎設施

| 項目 | 值 |
|---|---|
| Worker 名稱 | `moltbot-sandbox` |
| Worker URL | https://moltbot-sandbox.movie6.workers.dev |
| Cloudflare Account ID | `d1b8c375039b7037b7516a2b66d95c04` |
| R2 Bucket | `moltbot-data`（created 2026-02-10）|
| Durable Object | `Sandbox`（DO ID: `070187a35f4a74b19340d26a24fe9179cd43fab4b1a55a62e1db327b3486d845`）|
| Docker Base Image | `cloudflare/sandbox:0.7.0`（只有 amd64）|
| Container Registry | `registry.cloudflare.com/d1b8c375039b7037b7516a2b66d95c04/moltbot-sandbox-sandbox` |

## Moltworker 本地路徑

```
/tmp/moltworker/           # Clone from github.com/hansonchs/moltworker (fork)
├── Dockerfile             # 自訂 Docker image（Node 22 + rclone + openclaw）
├── start-openclaw.sh      # 啟動腳本（R2 restore → onboard → config patch → sync loop → gateway）
├── wrangler.jsonc          # Worker 設定
├── skills/                # 自訂 skills
└── src/                   # Moltworker source
```

## Git Repo vs 本地路徑

- **Git repo（文檔）**：`/Users/hanson/Projects/movie6/movie6-openclaw/`（GitHub: hansonchs/movie6-openclaw）
- **Moltworker fork**：`/tmp/moltworker/`（GitHub: hansonchs/moltworker，fork from cloudflare/moltworker）
  - `origin` = `hansonchs/moltworker`（我哋嘅 fork）
  - `upstream` = `cloudflare/moltworker`（原始 repo，唔好直接 push）
- **部署檔案**（Dockerfile、start-openclaw.sh、skills/）直接 commit 到 fork
- **Commit 後**：同步 cp 到 movie6-openclaw repo 做備份
- **拉 upstream 更新**：`git fetch upstream && git merge upstream/main`（小心 review 先 merge）

## 部署指令

⚠️ `npm run deploy`（包含 `vite build`）需要 client source files。如果 source 唔齊但 `dist/` 仲在，直接用 wrangler：

```bash
# 完整 build + deploy（需要 client source）
cd /tmp/moltworker && CLOUDFLARE_ACCOUNT_ID=d1b8c375039b7037b7516a2b66d95c04 npm run deploy

# 只 deploy（跳過 vite build，用現有 dist/）
cd /tmp/moltworker && CLOUDFLARE_ACCOUNT_ID=d1b8c375039b7037b7516a2b66d95c04 npx wrangler deploy
```

## 版本歷史

| 日期 | OpenClaw 版本 | Deploy Version | 備註 |
|---|---|---|---|
| 2026-02-12 | 2026.2.3 | — | 初始部署 |
| 2026-02-21 | 2026.2.19-2 | a1206c26 | 升級到最新版 |
| 2026-02-22 | 2026.2.19-2 | f7383afc | Slack streaming fix + cron backup + stale key cleanup |
| 2026-02-23 | 2026.2.19-2 | 25bf3845 | Sessions restore/sync 修復 |
| 2026-02-23 | 2026.2.19-2 | 674e5328 | Identity/devices 持久化 + stale lock 清理 + Slack DM open policy + meta version 清除 |
| 2026-02-25 | 2026.2.19-2 | e56c42f9 | Dockerfile layer 優化（合併 pnpm+openclaw layer + npm cache clean）解決 registry push 卡住 |
| 2026-02-26 | 2026.2.19-2 | 03f3a171 | Cron log persistence 到 R2 |
| 2026-03-02 | 2026.2.26 | 3ae08b7f | 升級到 2026.2.26 + config schema migration（dm→dmPolicy, controlUi origins）+ doctor --fix |
| 2026-03-02 | 2026.3.1 | db55bdf9 | 升級到最新版 2026.3.1 |
| 2026-03-03 | 2026.3.1 | 205b13ad | upstream auto-deploy 修復 + fork moltworker repo |

> **注意**：Dockerfile 改用 `FROM moltbot-sandbox-sandbox:03f3a171` 避免 Docker Hub pull timeout。升級 openclaw 從 2026.2.19-2 到 2026.2.26 需要 config migration。

## Worker Secrets

| Secret | 用途 |
|---|---|
| OPENAI_API_KEY | 火山引擎 Volcengine API Key |
| OPENAI_BASE_URL | 火山引擎 API endpoint |
| MOLTBOT_GATEWAY_TOKEN | Gateway 認證 token |
| CF_ACCOUNT_ID | Cloudflare Account ID |
| R2_ACCESS_KEY_ID | R2 存取 key |
| R2_SECRET_ACCESS_KEY | R2 存取 secret |
| SLACK_APP_TOKEN | Slack App Token |
| SLACK_BOT_TOKEN | Slack Bot Token |
| DEBUG_ROUTES | Debug 路由設定 |
| DEV_MODE | `true` — 繞過 CF Access 驗證（暫時需要） |

**未設定**：`CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`（移除 DEV_MODE 前需要先設定）

## 重要注意事項

### Secret 變更會觸發 DO 重啟
- 每次 `wrangler secret put/delete` 都會創建新 deployment version
- DO 會進入 reset loop，**不會自動恢復**
- 必須立即執行 `npm run deploy` 重新部署

### Docker Push 經常卡住
- Cloudflare Container Registry 無法處理大 layer upload（>~200MB 會卡住）
- **根本解決**：合併 Dockerfile RUN 指令 + 清理 cache，減少 layer 大小
  - `npm install -g pnpm && npm install -g openclaw@... && npm cache clean --force && rm -rf /tmp/*`
  - 合併後 export 時間 113s → 34.8s，所有 layer 都能 push
- **應急方法**：kill deploy → `docker rmi` 所有相關 images → `docker builder prune -af` → 重新 deploy
  - 新 layer digest 可以繞過 registry 上損壞嘅 partial upload
- `~/.docker/daemon.json` 已設定 `"max-concurrent-uploads": 1`
- ⚠️ 改 Dockerfile layer 順序會令所有後續 layer 重建，可能再卡住

### Container 啟動需時
- Deploy 完成後 container 需要 60-90 秒先會 ready
- 用 `curl https://moltbot-sandbox.movie6.workers.dev/api/status` 檢查
- `{"ok":true,"status":"running"}` = 正常

### R2 數據同步
- **啟動時**：從 R2 restore 到 container
  - Config: `rclone copyto r2:moltbot-data/openclaw/openclaw.json`
  - Workspace: `rclone copy r2:moltbot-data/workspace/`（background）
  - Cron: `rclone copy r2:moltbot-data/openclaw-cron/`
  - Skills: `rclone copy r2:moltbot-data/skills/`
  - Sessions: `rclone copy r2:moltbot-data/openclaw/agents/`（blocking）
  - Identity: `rclone copy r2:moltbot-data/openclaw/identity/`
  - Devices: `rclone copy r2:moltbot-data/openclaw/devices/`
  - Cron log: `rclone copyto r2:moltbot-data/logs/movie-qa.log`
- **啟動後清理**：刪除所有 `*.lock` 檔案（防止 stale lock 導致 session locked 錯誤）
- **運行中**：每 30 秒從 container sync 到 R2
  - Config/Cron/Workspace/Skills: `rclone sync`（覆蓋式）
  - Sessions: `rclone copy`（只新增，排除 `*.lock`）
  - Identity/Devices: `rclone copy`
- **Cron 執行後**：check.mjs log 自動 upload 到 `r2:moltbot-data/logs/movie-qa.log`
- Session 檔案儲存在 `openclaw/agents/main/sessions/*.jsonl`
- `sessions.json` 係 session 索引

### LLM Provider（待遷移）
- **現用**：火山引擎（Volcengine）via OpenAI-compatible API — 速度慢、output 質量差
  - Provider: `openai-compat`
  - Model: `ark-code-latest`
- **計劃遷移到**：OpenRouter（`https://openrouter.ai/api/v1`）
  - Provider type 仍然係 `openai-compat`（OpenRouter 兼容 OpenAI API）
  - 推薦預設 model：`anthropic/claude-3-5-haiku-20241022`（平，$0.80/$4 per 1M tokens）
  - 高質量 model：`anthropic/claude-sonnet-4`（$3/$15 per 1M tokens）
  - OpenRouter dashboard 可設 monthly spending limit
  - 遷移時需要：設定 `OPENROUTER_API_KEY` secret，更新 config patcher

### LLM 使用策略（推薦）

兩階段模式：Opus planning + Haiku execution，利用 Claude Code 訂閱已包嘅 Opus 4.6 做高質量 planning，再交俾平嘅 Haiku 執行。

| 場景 | 做法 | 成本 |
|---|---|---|
| 日常對話 / 簡單問題 | Haiku 直接答 | ~$0.02/次 |
| 需要執行嘅 task | Claude Code (Opus) 寫 plan → Haiku 執行 | ~$0.20/次（Opus 訂閱包） |
| 重要一次性任務 | 手動切 Sonnet 4 | ~$0.75/次 |
| 固定 script（check.mjs） | 系統 crontab 直接行 | $0 |

**月費估算**（10 task/日）：
- Haiku 預設 + Opus planning：~$44/月
- 對比 Sonnet 做晒：~$165/月（貴 4x）

**OpenClaw model 切換方法**：
- CLI：`openclaw models set <provider/model>`（需要 gateway pairing）
- Config：`openclaw config set agents.defaults.model.primary <provider/model>`
- Via Slack：叫 bot 自己行 `openclaw models set ...`
- ⚠️ 切換係全域，冇 per-message 選擇

### Cron 排程
- **用系統 crontab**（唔用 OpenClaw cron）— 零 LLM 成本、可靠
- `0 3 * * 1-5` = 星期一至五 03:00 UTC（11:00 HKT）
- 行 `/root/clawd/skills/movie-qa-check/scripts/check.mjs`
- 行完後 `rclone copyto` log 到 R2
- Crontab 由 `start-openclaw.sh` 每次啟動時設定（唔會因 container restart 消失）
- Log 位置：container `/tmp/movie-qa.log`，R2 `logs/movie-qa.log`
- **OpenClaw cron**（`jobs.json`）係空嘅，唔用，因為需要 gateway pairing + 每次行都要燒 API token

### OpenClaw Cron vs 系統 Crontab 決定
- 固定 script → **系統 crontab**（零成本、穩定）
- 需要 AI 判斷嘅任務 → **OpenClaw cron**（要 API token）
- OpenClaw `cron list/add` 需要 gateway pairing（目前未設定）

## Allowed Permissions

以下操作可以直接執行，唔需要逐次確認：

```
# 部署到 Cloudflare
cd /tmp/moltworker && CLOUDFLARE_ACCOUNT_ID=d1b8c375039b7037b7516a2b66d95c04 npm run deploy

# Docker 操作（build, push, rmi, prune）
docker build / docker rmi / docker builder prune -af

# Container debug 操作
curl https://moltbot-sandbox.movie6.workers.dev/debug/*

# R2 操作（rclone）
rclone copy/copyto/sync/ls r2:moltbot-data/*

# Wrangler secret 操作
wrangler secret put/delete/list

# Kill gateway process（透過 debug endpoint）
curl .../debug/cli?cmd=pkill+-f+"openclaw+gateway"

# 打開 URL
open https://*
```

## Debug Endpoints

| Endpoint | 用途 |
|---|---|
| `/debug/health` | 健康檢查 |
| `/debug/container-config` | 查看運行中嘅 config（包含 raw JSON） |
| `/debug/cli?cmd=...` | 執行 container 內 CLI 指令 |
| `/api/status` | Gateway 狀態 |
| `/_admin/` | Control UI |

## Slack Bot

| 項目 | 值 |
|---|---|
| App ID | `A0ADUF9JLBZ` |
| Bot Name | Clapper（場記）|
| Icon | `clapper-icon.png`（本 repo 內）|
| App Dashboard | https://api.slack.com/apps/A0ADUF9JLBZ/general |
| Bot Name 設定 | https://api.slack.com/apps/A0ADUF9JLBZ/app-home |
| Streaming | `false`（workaround for OpenClaw #20337）|

## start-openclaw.sh 架構

```
啟動流程：
1. R2 Restore（config → workspace → cron → skills → sessions → identity → devices → cron log）
2. Clean stale .lock files
3. Onboard（如果無 config，從 env vars 生成）
4. Config Patch（Node.js script）
   - 清理 stale keys（ownerDisplay, restart, meta.lastTouchedVersion）
   - 設定 thinkingDefault: off
   - 設定 ackReactionScope: direct
   - 設定 gateway auth + trustedProxies
   - 設定 Slack streaming: false + dm open policy
   - 設定 channels（Telegram/Discord/Slack from env vars）
5. System Crontab（movie-qa-check，工作天 03:00 UTC，行完 upload log 到 R2）
6. Background Sync Loop（每 30 秒）
   - 偵測 changed files
   - Sync config + cron + workspace + skills + sessions + identity + devices 到 R2
7. Start Gateway（exec openclaw gateway）
```

## 已知問題 / Workarounds

| 問題 | Workaround | 相關 Issue |
|---|---|---|
| Slack thread 回覆唔到 | `streaming: false` | OpenClaw #20337 |
| OpenClaw 升級 layer 太大 | 用舊 image 做 base（`FROM moltbot-sandbox-sandbox:03f3a171`）避免 Docker Hub pull timeout | Cloudflare registry 502 |
| Docker Hub pull timeout（ARM Mac） | Dockerfile 用本地 image 做 base，避免 cross-platform pull | BuildKit metadata resolve 卡住 |
| 2026.2.26 config schema 變更 | `openclaw doctor --fix` + config patcher 更新 dm→dmPolicy | dm.policy→dmPolicy, controlUi.allowedOrigins |
| Config stale keys crash | start-openclaw.sh 自動清理 | ownerDisplay/restart from 2026.2.21-2 |
| Bot token 無法改名/icon | 需要去 Slack App Dashboard 手動改 | Slack API 限制 |
| ackReactionScope "none" crash | 改為 "direct" | OpenClaw config validation |
| thinkingDefault 必須 "off" | 非 thinking model 唔支援 | Volcengine ark-code-latest |
| Config version warning | 清除 `meta.lastTouchedVersion` | R2 config 被 2026.2.21-2 寫過 |
| Session file locked after restart | 啟動時 `find -name '*.lock' -delete` | Stale lock from previous container |
| Identity/devices 丟失 | R2 backup/restore identity + devices | Container restart 產生新 keys |
| 火山引擎速度慢 + output 質量差 | 計劃遷移到 OpenRouter（Anthropic models） | 待設定 OpenRouter API key |
| OpenClaw gateway 容易死 | Cloudflare container infra 問題，非 OOM（4GB RAM 只用 566MB） | 暫無 fix，靠 container auto-restart |
| Upstream auto-deploy 覆蓋自訂 image | Fork moltworker repo（`hansonchs/moltworker`），disable Actions | cloudflare/moltworker PR #254 |
| Wrangler skip push 唔更新 image tag | Dockerfile 加 `RUN echo "deployed-日期"` 強制新 layer | sha256 相同時 wrangler 唔會更新 container |
| `npm run deploy` vite build 失敗 | Client source files 唔齊時用 `npx wrangler deploy` 跳過 build | `Could not resolve entry module "index.html"` |

## 維護記錄

### 2026-02-21
**問題**：
1. OpenClaw DO 進入 reset loop（因 secret 變更觸發）
2. Docker push 反覆卡住（layer partial upload 問題）
3. DEV_MODE 刪除導致 missing CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD
4. 對話記錄「消失」（sessions.json 索引只有最新 session）

**解決**：
1. 清除所有 Docker images + build cache → 重新 build → 成功 push
2. OpenClaw 從 `2026.2.3` 升級到 `2026.2.19-2`
3. DEV_MODE 加返 `true`
4. 手動修改 sessions.json 加入 3 個舊 session reference → 上傳到 R2 → redeploy
5. R2 確認保留咗所有 4 個 session JSONL 檔案（共 ~3.1MB）

### 2026-02-22
**問題**：
1. Slack channel @mention 回覆唔到（UI 有 response 但 Slack thread 無反應）
2. 嘗試升級 OpenClaw 到 2026.2.21-2 失敗（Docker layer 502）
3. Container restart 後 config validation crash（`commands.ownerDisplay` unrecognized）
4. Workspace/session/cron 喺 container restart 後消失

**解決**：
1. 發現 OpenClaw #20337 — `chat.stopStream` 需要 `recipient_team_id`，設定 `streaming: false` 解決
2. Revert 返 2026.2.19-2（cached layer 可以 push）
3. Config patcher 加入 stale key cleanup（delete ownerDisplay/restart）
4. 從 R2 `openclaw/` prefix 手動 restore workspace + sessions
5. start-openclaw.sh 加入 cron backup/restore 邏輯
6. Deploy version `f7383afc` 包含所有 fix
7. Slack bot 改名為 Clapper（場記），icon 已生成

### 2026-02-23
**問題**：
1. Container restart 後 sessions 完全冇 restore（`/root/.openclaw/agents/main/sessions/` 為空）
2. Sync loop 只 sync config/cron/workspace/skills，唔包括 sessions
3. R2 上嘅 session 檔案係之前手動上傳，無自動備份機制

**解決**：
1. `start-openclaw.sh` 加入 sessions restore 步驟（blocking，確保 gateway 啟動前完成）
2. Sync loop 加入 sessions backup（用 `rclone copy` 而非 `sync`，防止誤刪）
3. Deploy version `25bf3845`，確認 17 個 session 檔案成功 restore
4. 加入 identity + devices 嘅 R2 restore/sync（防止 pairing 丟失）
5. 啟動時自動清除 stale `*.lock` 檔案
6. Sync 排除 `*.lock` 檔案（`--exclude='*.lock'`）
7. Config patcher 清除 `meta.lastTouchedVersion`（防止版本 warning）
8. Slack config 加入 `dm: { policy: 'open', allowFrom: ['*'] }`
9. Deploy version `674e5328` 包含所有 fix

### 2026-02-25
**問題**：
1. Docker push 卡住（layer `1944f30f498d` 一直 "Waiting"，其餘 18 層已 push）
2. 改 Dockerfile 加 `apt-get clean` 後，新 layer push 到，但 openclaw layer `4df73116e54f` 又卡住
3. Container shell 行完 check.mjs 後死亡（"shell has died"）

**解決**：
1. 根本原因：Cloudflare registry 無法處理大 layer（>~200MB）
2. 合併 Dockerfile 嘅 pnpm + openclaw install 成一個 RUN + `npm cache clean --force && rm -rf /tmp/*`
3. Layer export 時間 113s → 34.8s，所有 layer 成功 push
4. Deploy version `e56c42f9`
5. 部署檔案（Dockerfile、start-openclaw.sh、skills/）commit 到 movie6-openclaw repo

### 2026-02-26
**問題**：
1. Cron log（`/tmp/movie-qa.log`）container restart 後消失
2. 火山引擎 LLM 速度慢 + output 質量差

**解決**：
1. `start-openclaw.sh` 加入 cron log R2 persistence：
   - 啟動時 restore：`rclone copyto r2:moltbot-data/logs/movie-qa.log /tmp/movie-qa.log`
   - Crontab 行完後 upload：`;rclone copyto /tmp/movie-qa.log r2:moltbot-data/logs/movie-qa.log`
2. Deploy version `03f3a171`（只改 start-openclaw.sh，大 layer 全部 cached）
3. LLM 遷移決定：OpenRouter + Anthropic models（待用戶提供 API key）
   - 預設推薦 Haiku 3.5（$0.80/$4，日常夠用）
   - 高質量用 Sonnet 4（$3/$15）
   - 系統 crontab 唔經 LLM，零 API 成本

**成本估算**：
- Haiku 3.5 預設：~$15-30/月（含 task 執行）
- Sonnet 4 預設：~$50-150/月（含 task 執行）
- OpenRouter 可設 monthly spending limit 封頂

### 2026-03-02
**問題**：
1. OpenClaw 自動升級到 2026.2.26，gateway crash（`non-loopback Control UI requires gateway.controlUi.allowedOrigins`）
2. Config schema 變更：`channels.slack.dm.policy` → `channels.slack.dmPolicy`
3. Docker Hub pull `cloudflare/sandbox:0.7.0` timeout（ARM Mac cross-platform pull 卡住）
4. Docker Desktop 反覆重啟不穩定

**解決**：
1. R2 config 手動修正：加入 `controlUi.dangerouslyAllowHostHeaderOriginFallback: true`
2. `start-openclaw.sh` 更新：
   - 加入 `openclaw doctor --fix` 步驟（gateway 啟動前自動 migrate config）
   - Slack config 改用新 schema（`dmPolicy` 取代 `dm.policy`）
   - `controlUi` 加入 `dangerouslyAllowHostHeaderOriginFallback`
3. Dockerfile 改用 `FROM moltbot-sandbox-sandbox:03f3a171`（本地已有 image）避免 Docker Hub pull
4. OpenClaw 升級到 `2026.2.26`（`npm install -g openclaw@2026.2.26`）
5. Deploy version `3ae08b7f`，container 約 100 秒後 ready
6. 隨即升級到 `2026.3.1`（`npm install -g openclaw@2026.3.1`）
7. Deploy version `db55bdf9`，所有 layer cached（只有 openclaw upgrade layer 新增）

### 2026-03-03
**問題**：
1. Gateway 又死咗，container 用緊錯誤嘅 image `3982fbb8`（OpenClaw `2026.2.3`）
2. R2 config 被覆蓋（provider 變成 `zai/glm-5`，Slack schema 變成 `groupPolicy`）
3. 原因：upstream `cloudflare/moltworker` 合併 PR #254 觸發 auto-deploy，覆蓋咗我哋嘅自訂 image 同 config
4. Wrangler deploy 如果 image sha256 相同會 skip push 且唔更新 container image tag

**解決**：
1. R2 config 手動修正返正確嘅 provider（`openai-compat/ark-code-latest`）同 Slack schema
2. 刪除舊 container（`wrangler containers delete`）→ 重新 deploy 確保用新 image
3. Dockerfile 加入 `RUN echo "deployed-2026-03-03"` 強制新 layer（解決 sha256 相同 skip push 問題）
4. Deploy version `205b13ad`，container 正確跑 OpenClaw `2026.3.1`
5. **Fork moltworker repo**（`hansonchs/moltworker`）防止 upstream auto-deploy 再覆蓋
6. Fork 嘅 GitHub Actions 已 disable
7. 本地 `/tmp/moltworker/` remote 已更新：`origin` = fork, `upstream` = cloudflare
