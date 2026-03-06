---
name: google-rank-tracker
description: 每日追蹤 hkmovie6.com 喺 Google 搜尋結果嘅排名位置，用 Cloudflare Browser Rendering (CDP) 渲染搜尋頁面，對比歷史變化並發送報告到 Slack #automation-testing。
---

## 使用方法

手動執行：
```bash
node /root/clawd/skills/google-rank-tracker/scripts/check.mjs
```

自動排程：每個工作天 13:00 HKT（05:00 UTC）透過 crontab 執行。

## 追蹤關鍵字

- `香港電影`
- `電影場次`
- `香港戲院`
- `movie6`
- `hkmovie6`

## 工作原理

1. 透過 CDP WebSocket 連接 Cloudflare Browser Rendering
2. 每個關鍵字：導航到 `google.com.hk/search?q=...` → 等待渲染 → 提取搜尋結果
3. 搵 hkmovie6.com 喺結果中嘅位置
4. 對比歷史數據，顯示排名變化

## 前提條件

- `CDP_SECRET` — Cloudflare Browser Rendering secret（必須）
- `WORKER_URL` — Cloudflare Worker endpoint（必須）
- `SLACK_BOT_TOKEN` — 用嚟發送報告到 Slack（必須，fallback 讀 openclaw.json）
