---
name: storellet-app-monitor
description: 每日監控 Storellet App 喺 iOS App Store 同 Google Play Store 嘅評分、評價數同最新評論，對比歷史變化並發送報告到 Slack #automation-testing。
---

## 使用方法

手動執行：
```bash
node /root/clawd/skills/storellet-app-monitor/scripts/check.mjs
```

自動排程：每個工作天 12:30 HKT（04:30 UTC）透過 crontab 執行。

## 監控項目

1. **iOS 評分 + 評價數** — iTunes Lookup API
2. **iOS 最新評論** — iTunes RSS Feed
3. **Android 評分** — Google Play Store HTML parse
4. **歷史對比** — 同上次數據比較，顯示升跌趨勢

## 數據源

- iOS Lookup: `https://itunes.apple.com/lookup?id=936066838&country=hk`
- iOS Reviews RSS: `https://itunes.apple.com/hk/rss/customerreviews/id=936066838/sortBy=mostRecent/json`
- Android: `https://play.google.com/store/apps/details?id=com.crozz.storellet&hl=zh-HK`

## 環境變數

- `SLACK_BOT_TOKEN` — 用嚟發送報告到 Slack（必須，fallback 讀 openclaw.json）
