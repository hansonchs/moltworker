#!/usr/bin/env node
// Movie6 App Store Monitor — Daily rating & review check
// Fetches iOS App Store (iTunes API + RSS) and Google Play Store data,
// compares with historical data, and posts a Slack report.
//
// Zero external dependencies — uses Node.js 22 built-in fetch().

import fs from 'node:fs';
import path from 'node:path';

const IOS_APP_ID = '303206353';
const ANDROID_PACKAGE = 'gt.farm.hkmovies';
const SLACK_CHANNEL_NAME = 'automation-testing';
const HISTORY_DIR = '/root/clawd/skills/app-store-monitor/data';
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');

// ============================================================
// iOS App Store — iTunes Lookup API
// ============================================================

async function fetchIOSData() {
  const url = `https://itunes.apple.com/lookup?id=${IOS_APP_ID}&country=hk`;
  console.log(`Fetching iOS data: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iTunes Lookup HTTP ${res.status}`);
  const data = await res.json();
  const app = data.results?.[0];
  if (!app) throw new Error('iOS app not found in iTunes Lookup');

  return {
    name: app.trackName,
    rating: app.averageUserRating ? Math.round(app.averageUserRating * 10) / 10 : null,
    ratingCount: app.userRatingCount || 0,
    version: app.version,
    developer: app.artistName,
  };
}

// ============================================================
// iOS App Store — RSS Reviews Feed
// ============================================================

async function fetchIOSReviews() {
  const url = `https://itunes.apple.com/hk/rss/customerreviews/id=${IOS_APP_ID}/sortBy=mostRecent/json`;
  console.log(`Fetching iOS reviews: ${url}`);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`iTunes RSS HTTP ${res.status}, skipping reviews`);
      return [];
    }
    const data = await res.json();
    const entries = data?.feed?.entry;
    if (!entries || !Array.isArray(entries)) return [];

    // First entry is sometimes the app metadata, skip it
    return entries
      .filter(e => e['im:rating'])
      .slice(0, 5)
      .map(e => ({
        rating: parseInt(e['im:rating']?.label || '0', 10),
        title: e.title?.label || '',
        content: (e.content?.label || '').slice(0, 100),
        author: e.author?.name?.label || '',
        date: e.updated?.label ? e.updated.label.split('T')[0] : '',
      }));
  } catch (e) {
    console.warn(`iOS reviews fetch failed: ${e.message}`);
    return [];
  }
}

// ============================================================
// Google Play Store — HTML Parse
// ============================================================

async function fetchAndroidData() {
  const url = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}&hl=zh-HK`;
  console.log(`Fetching Android data: ${url}`);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-HK,zh;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) {
      console.warn(`Play Store HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();

    // Extract app name from title
    const nameMatch = html.match(/<title>([^<]+)<\/title>/);
    const name = nameMatch ? nameMatch[1].replace(/ - Google Play 上的应用| - Apps on Google Play| - Google Play 應用程式/i, '').trim() : ANDROID_PACKAGE;

    // Extract rating from the structured data or aria labels
    // Play Store embeds rating in JSON-LD or in specific div patterns
    let rating = null;

    // Method 1: Look for JSON-LD aggregateRating
    const jsonLdMatch = html.match(/"aggregateRating"\s*:\s*\{[^}]*"ratingValue"\s*:\s*"?([\d.]+)"?/);
    if (jsonLdMatch) {
      rating = parseFloat(jsonLdMatch[1]);
    }

    // Method 2: Look for aria-label with rating pattern
    if (!rating) {
      const ariaMatch = html.match(/aria-label="Rated ([\d.]+) stars out of five/i);
      if (ariaMatch) rating = parseFloat(ariaMatch[1]);
    }

    // Method 3: Look for the rating display text
    if (!rating) {
      const ratingTextMatch = html.match(/itemprop="starRating"[^>]*>[\s\S]*?<div[^>]*>([\d.]+)<\/div>/);
      if (ratingTextMatch) rating = parseFloat(ratingTextMatch[1]);
    }

    if (rating) rating = Math.round(rating * 10) / 10;

    return { name, rating };
  } catch (e) {
    console.warn(`Android data fetch failed: ${e.message}`);
    return null;
  }
}

// ============================================================
// History management
// ============================================================

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn(`History load failed: ${e.message}`);
  }
  return { entries: [] };
}

function saveHistory(history) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  console.log(`History saved to ${HISTORY_FILE}`);
}

function getLastEntry(history) {
  return history.entries.length > 0 ? history.entries[history.entries.length - 1] : null;
}

function trendArrow(current, previous) {
  if (current == null || previous == null) return '';
  if (current > previous) return '↑';
  if (current < previous) return '↓';
  return '→';
}

function trendDiff(current, previous) {
  if (current == null || previous == null) return '';
  const diff = current - previous;
  if (diff === 0) return '不變';
  const sign = diff > 0 ? '+' : '';
  return `${sign}${Math.round(diff * 10) / 10}`;
}

// ============================================================
// Slack helpers (same pattern as movie-qa-check)
// ============================================================

async function findSlackChannel(token, name) {
  const clean = name.replace(/^#/, '');
  let cursor = '';
  do {
    const params = new URLSearchParams({ types: 'public_channel,private_channel', limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`https://slack.com/api/conversations.list?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`conversations.list: ${data.error}`);
    const ch = data.channels.find(c => c.name === clean);
    if (ch) return ch.id;
    cursor = data.response_metadata?.next_cursor || '';
  } while (cursor);
  throw new Error(`Channel #${clean} not found`);
}

async function postToSlack(token, channelId, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channelId, text, unfurl_links: false }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`chat.postMessage: ${data.error}`);
}

// ============================================================
// Report formatting
// ============================================================

function formatSlackMessage(date, ios, iosReviews, android, lastEntry) {
  const lines = [];
  lines.push(`📱 Movie6 App Store 每日報告（${date}）`);
  lines.push('');

  // iOS section
  lines.push(`🍎 iOS — ${ios.name}`);
  if (ios.rating != null) {
    lines.push(`⭐ 評分：${ios.rating} / 5`);
  } else {
    lines.push(`⭐ 評分：暫無`);
  }

  const countStr = ios.ratingCount.toLocaleString();
  const countDiff = lastEntry?.ios?.ratingCount != null
    ? `（${trendDiff(ios.ratingCount, lastEntry.ios.ratingCount)}）`
    : '';
  lines.push(`📊 評價數：${countStr}${countDiff}`);

  if (iosReviews.length > 0) {
    lines.push(`📝 最新評論：`);
    for (const r of iosReviews.slice(0, 3)) {
      const stars = '⭐'.repeat(r.rating);
      const text = r.title || r.content || '(無文字)';
      const dateStr = r.date ? ` — ${r.date}` : '';
      lines.push(`  ${stars} "${text}"${dateStr}`);
    }
  }

  lines.push('');

  // Android section
  if (android) {
    lines.push(`🤖 Android — ${android.name}`);
    if (android.rating != null) {
      lines.push(`⭐ 評分：${android.rating} / 5`);
    } else {
      lines.push(`⭐ 評分：暫無數據`);
    }
  } else {
    lines.push('🤖 Android — 數據獲取失敗');
  }

  lines.push('');

  // Trend summary
  const trends = [];
  if (lastEntry) {
    const iosArrow = trendArrow(ios.rating, lastEntry.ios?.rating);
    const iosDiff = trendDiff(ios.rating, lastEntry.ios?.rating);
    trends.push(`iOS ${iosArrow === '→' ? '不變' : `${iosArrow}${iosDiff}`}`);

    if (android?.rating != null && lastEntry.android?.rating != null) {
      const androidArrow = trendArrow(android.rating, lastEntry.android.rating);
      const androidDiff = trendDiff(android.rating, lastEntry.android.rating);
      trends.push(`Android ${androidArrow === '→' ? '不變' : `${androidArrow}${androidDiff}`}`);
    }
  }
  if (trends.length > 0) {
    lines.push(`📈 變化：${trends.join('，')}`);
  }

  return lines.join('\n');
}

// ============================================================
// Main
// ============================================================

async function main() {
  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];
  console.log(`=== App Store Monitor — ${today} ===\n`);

  // 1. Fetch data
  const [ios, iosReviews, android] = await Promise.all([
    fetchIOSData(),
    fetchIOSReviews(),
    fetchAndroidData(),
  ]);

  console.log(`\niOS: ${ios.name} — ${ios.rating}/5 (${ios.ratingCount} ratings)`);
  if (android) console.log(`Android: ${android.name} — ${android.rating}/5`);

  // 2. Load history & compare
  const history = loadHistory();
  const lastEntry = getLastEntry(history);
  if (lastEntry) {
    console.log(`Last check: ${lastEntry.date}`);
  }

  // 3. Save today's entry
  const todayEntry = {
    date: today,
    ios: { rating: ios.rating, ratingCount: ios.ratingCount },
    android: android ? { rating: android.rating } : null,
  };
  history.entries.push(todayEntry);
  // Keep last 90 days
  if (history.entries.length > 90) {
    history.entries = history.entries.slice(-90);
  }
  saveHistory(history);

  // 4. Format report
  const message = formatSlackMessage(today, ios, iosReviews, android, lastEntry);
  console.log('\n--- Slack Message ---');
  console.log(message);
  console.log('--- End ---\n');

  // 5. Post to Slack
  let slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    try {
      const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
      slackToken = cfg?.channels?.slack?.botToken;
      if (slackToken) console.log('Using Slack token from openclaw.json');
    } catch (_) { /* ignore */ }
  }
  if (!slackToken) {
    console.error('SLACK_BOT_TOKEN not set, skipping Slack post');
    console.log(`Completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    return;
  }

  try {
    const channelId = await findSlackChannel(slackToken, SLACK_CHANNEL_NAME);
    console.log(`Posting to #${SLACK_CHANNEL_NAME} (${channelId})...`);
    await postToSlack(slackToken, channelId, message);
    console.log('Slack message posted successfully');
  } catch (e) {
    console.error(`Slack posting failed: ${e.message}`);
    process.exitCode = 1;
  }

  console.log(`Completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
