---
name: movie-distributor-email
description: 監控 distributor emails，提取電影資訊後 cross-check hkmovie6.com（showing + upcoming），找出需要更新嘅內容並發送報告到 Slack #automation-testing。
---

## 使用方法

手動執行：
```bash
node /root/clawd/skills/movie-distributor-email/scripts/check.mjs
```

自動排程：每個工作天 09:00 HKT（01:00 UTC）透過 crontab 執行。

## 運作流程

1. 透過 gRPC API 獲取 hkmovie6.com 上映中 + 即將上映電影列表
2. 透過 IMAP 連接 movie6.agent@gmail.com，搜尋最近 N 日嘅電郵
3. 從電郵提取電影資訊：《》片名、Google Drive 海報連結、YouTube 預告片
4. Cross-check：比對電郵電影同網站電影
5. 只發送需要更新嘅項目到 Slack

## 報告內容

- **電影未在網站上** — 電郵提到但 showing/upcoming 都搵唔到
- **海報更新（網站缺少海報）** — 電郵有 Google Drive 連結，網站無海報
- **新海報/物料可用** — 電郵有新素材，網站已有海報但可能需要更新
- **新預告片** — 電郵有 YouTube 連結
- **網站缺少片長** — 需要補充

## 環境變數

- `EMAIL_USER` — Gmail 地址（預設: movie6.agent@gmail.com）
- `EMAIL_PASS` — App Password（預設已配置）
- `DAYS_BACK` — 掃描幾日內嘅電郵（預設: 3）
- `SLACK_BOT_TOKEN` — Slack Bot Token（可選，fallback 讀 openclaw.json）

## 前提

- movie.info@hkmovie6.com 嘅電郵 forward 去 movie6.agent@gmail.com
- Gmail App Password 已設定（非普通密碼）
- 零外部依賴（用 Node.js 內建 TLS 做 IMAP）
