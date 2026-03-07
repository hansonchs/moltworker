---
name: seo-monitor
description: 定期監控 hkmovie6.com 喺 Google Search Console 同 GA4 嘅 SEO 數據（搜尋排名、點擊、流量），對比歷史變化並發送報告到 Slack #automation-testing。
---

## 使用方法

手動執行各個報告：
```bash
# Google Search Console 報告
node /root/clawd/skills/seo-monitor/scripts/gsc-report.mjs

# Google Analytics 4 報告
node /root/clawd/skills/seo-monitor/scripts/ga4-report.mjs

# 綜合 SEO 報告（GSC + GA4 + Slack 發送）
node /root/clawd/skills/seo-monitor/scripts/seo-report.mjs daily
node /root/clawd/skills/seo-monitor/scripts/seo-report.mjs weekly
```

自動排程：
- **Daily**：每個工作天 14:00 HKT（06:00 UTC）透過 crontab 執行 daily report
- **Weekly**：每週一 15:00 HKT（07:00 UTC）執行 weekly trend report（包含 4 週趨勢分析）

## 監控項目

1. **GSC 搜尋表現** — 關鍵字排名、點擊、曝光、CTR
2. **GSC 熱門頁面** — 各頁面搜尋流量
3. **GA4 流量概覽** — sessions、用戶、pageviews
4. **GA4 流量來源** — organic / direct / referral / social 分佈
5. **期間對比** — 同上一期比較，顯示升跌趨勢

## 設定

### 憑證
- Service Account JSON：`/root/clawd/credentials/gcp-service-account.json`
- 透過 R2 sync 持久化（上傳一次即可）

### Google Cloud 設定
1. 啟用 Search Console API + Analytics Data API
2. 建立 Service Account → 下載 JSON
3. 喺 GSC 加入 SA email 做 viewer
4. 喺 GA4 加入 SA email 做 viewer

### 站點設定
- GSC 站點：`sc-domain:hkmovie6.com`（可改）
- GA4 Property ID：需要喺 `seo-report.mjs` 設定

## 環境變數

- `SLACK_BOT_TOKEN` — 用嚟發送報告到 Slack（必須，fallback 讀 openclaw.json）
- `GA4_PROPERTY_ID` — GA4 Property ID（可選，fallback 用 script 內嘅默認值）
