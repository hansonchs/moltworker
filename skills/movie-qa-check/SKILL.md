---
name: movie-qa-check
description: 檢查 hkmovie6.com 上映中同即將上映電影嘅數據質素（重複、缺少海報/片長/分類），並發送報告到 Slack #automation-testing。
---

## 使用方法

手動執行：
```bash
node /root/clawd/skills/movie-qa-check/scripts/check.mjs
```

自動排程：每個工作天 11:00 HKT（03:00 UTC）透過 crontab 執行。

## 檢查項目

1. **重複電影** — 同一 UUID 同時出現在上映中同即將上映
2. **缺少海報** — 無 og:image 或使用 placeholder
3. **缺少片長** — 無 video:duration meta tag
4. **缺少分類** — 無 video:tag meta tag

## 環境變數

- `SLACK_BOT_TOKEN` — 用嚟發送報告到 Slack（必須）
