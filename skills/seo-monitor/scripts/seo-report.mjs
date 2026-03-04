#!/usr/bin/env node
// Combined SEO Report — GSC + GA4 → Slack
// Generates daily or weekly SEO reports and posts to Slack #automation-testing.
//
// Usage: node seo-report.mjs [daily|weekly]
//
// Zero external dependencies.

import fs from 'node:fs';
import path from 'node:path';

import { getAccessToken } from './google-auth.mjs';
import { getSummaryMetrics, getTopKeywords, getTopPages } from './gsc-report.mjs';
import { getTrafficOverview, getTopLandingPages, getTrafficSources } from './ga4-report.mjs';

// ============================================================
// Configuration
// ============================================================

const GSC_SITE = 'https://hkmovie6.com/';
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID || '173415787';
const SLACK_CHANNEL_NAME = 'automation-testing';
const HISTORY_DIR = '/root/clawd/skills/seo-monitor/data';
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

// ============================================================
// History management (same pattern as other skills)
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

// ============================================================
// Trend helpers
// ============================================================

function trendArrow(current, previous) {
  if (current == null || previous == null) return '';
  if (current > previous) return '↑';
  if (current < previous) return '↓';
  return '→';
}

function pctChange(current, previous) {
  if (!previous || previous === 0) return 'N/A';
  const delta = ((current - previous) / Math.abs(previous)) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

function formatNumber(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

// ============================================================
// Slack helpers (same pattern as app-store-monitor)
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
    if (!data.ok) throw new Error(`Slack conversations.list: ${data.error}`);
    const ch = data.channels?.find(c => c.name === clean);
    if (ch) return ch.id;
    cursor = data.response_metadata?.next_cursor || '';
  } while (cursor);
  throw new Error(`Slack channel #${clean} not found`);
}

async function postToSlack(token, channelId, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: channelId,
      text,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack chat.postMessage: ${data.error}`);
}

function getSlackToken() {
  let token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    try {
      const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
      token = cfg?.channels?.slack?.botToken;
      if (token) console.log('Using Slack token from openclaw.json');
    } catch (_) { /* ignore */ }
  }
  return token;
}

// ============================================================
// Report formatting
// ============================================================

function formatDailyReport(gscSummary, ga4Overview, lastEntry) {
  const today = new Date().toISOString().split('T')[0];
  const lines = [];

  lines.push(`📊 *SEO Daily Report — ${today}*`);
  lines.push(`Site: hkmovie6.com`);
  lines.push('');

  // GSC section
  if (gscSummary) {
    lines.push('*🔍 Google Search Console*');
    const clicksArrow = trendArrow(gscSummary.clicks, lastEntry?.gsc?.clicks);
    const imprArrow = trendArrow(gscSummary.impressions, lastEntry?.gsc?.impressions);

    lines.push(`  Clicks: ${formatNumber(gscSummary.clicks)} ${clicksArrow} (${pctChange(gscSummary.clicks, lastEntry?.gsc?.clicks)} vs prev report)`);
    lines.push(`  Impressions: ${formatNumber(gscSummary.impressions)} ${imprArrow}`);
    lines.push(`  CTR: ${gscSummary.ctr}%`);
    lines.push(`  Avg Position: ${gscSummary.position} (${parseFloat(gscSummary.positionDelta) >= 0 ? '↑' : '↓'}${Math.abs(parseFloat(gscSummary.positionDelta))} vs prev period)`);
    lines.push('');
  }

  // GA4 section
  if (ga4Overview) {
    lines.push('*📈 Google Analytics 4*');
    const sessArrow = trendArrow(ga4Overview.sessions, lastEntry?.ga4?.sessions);
    const usersArrow = trendArrow(ga4Overview.users, lastEntry?.ga4?.users);
    const pvArrow = trendArrow(ga4Overview.pageviews, lastEntry?.ga4?.pageviews);

    lines.push(`  Sessions: ${formatNumber(ga4Overview.sessions)} ${sessArrow} (${pctChange(ga4Overview.sessions, lastEntry?.ga4?.sessions)} vs prev report)`);
    lines.push(`  Users: ${formatNumber(ga4Overview.users)} ${usersArrow}`);
    lines.push(`  Pageviews: ${formatNumber(ga4Overview.pageviews)} ${pvArrow}`);
    lines.push('');
  }

  // Anomaly detection
  const anomalies = [];
  if (gscSummary && lastEntry?.gsc) {
    const clicksDrop = lastEntry.gsc.clicks > 0
      ? ((gscSummary.clicks - lastEntry.gsc.clicks) / lastEntry.gsc.clicks) * 100
      : 0;
    if (clicksDrop < -20) anomalies.push(`⚠️ GSC clicks dropped ${Math.abs(clicksDrop).toFixed(0)}% vs last report`);
    if (parseFloat(gscSummary.positionDelta) < -2) anomalies.push(`⚠️ Avg search position worsened by ${Math.abs(parseFloat(gscSummary.positionDelta))} positions`);
  }
  if (ga4Overview && lastEntry?.ga4) {
    const sessDrop = lastEntry.ga4.sessions > 0
      ? ((ga4Overview.sessions - lastEntry.ga4.sessions) / lastEntry.ga4.sessions) * 100
      : 0;
    if (sessDrop < -20) anomalies.push(`⚠️ GA4 sessions dropped ${Math.abs(sessDrop).toFixed(0)}% vs last report`);
  }

  if (anomalies.length > 0) {
    lines.push('*⚠️ Anomalies*');
    for (const a of anomalies) lines.push(`  ${a}`);
    lines.push('');
  }

  lines.push(`_Period: ${gscSummary?.period || ga4Overview?.period || 'N/A'}_`);

  return lines.join('\n');
}

function formatWeeklyReport(gscSummary, ga4Overview, gscKeywords, gscPages, ga4Landing, ga4Sources) {
  const today = new Date().toISOString().split('T')[0];
  const lines = [];

  lines.push(`📊 *SEO Weekly Report — ${today}*`);
  lines.push(`Site: hkmovie6.com | Period: ${gscSummary?.period || ga4Overview?.period || 'N/A'}`);
  lines.push('');

  // Summary
  if (gscSummary) {
    lines.push('*🔍 Search Console Summary*');
    lines.push(`  Clicks: ${formatNumber(gscSummary.clicks)} (${gscSummary.clicksPct}% vs prev period)`);
    lines.push(`  Impressions: ${formatNumber(gscSummary.impressions)} (${gscSummary.impressionsPct}%)`);
    lines.push(`  CTR: ${gscSummary.ctr}% | Avg Pos: ${gscSummary.position}`);
    lines.push('');
  }

  if (ga4Overview) {
    lines.push('*📈 Analytics Summary*');
    lines.push(`  Sessions: ${formatNumber(ga4Overview.sessions)} (${ga4Overview.sessionsDelta >= 0 ? '+' : ''}${formatNumber(ga4Overview.sessionsDelta)})`);
    lines.push(`  Users: ${formatNumber(ga4Overview.users)} | Pageviews: ${formatNumber(ga4Overview.pageviews)}`);
    lines.push('');
  }

  // Detailed sections (truncated for Slack readability)
  if (gscKeywords) {
    const keywordLines = gscKeywords.split('\n').slice(0, 12); // header + top 10
    lines.push('*🔑 Top Keywords*');
    lines.push('```');
    lines.push(...keywordLines);
    lines.push('```');
    lines.push('');
  }

  if (ga4Sources) {
    lines.push('*🌐 Traffic Sources*');
    lines.push('```');
    lines.push(...ga4Sources.split('\n').slice(0, 12));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================
// Main
// ============================================================

async function main() {
  const mode = process.argv[2] || 'daily';
  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];
  const days = mode === 'weekly' ? 7 : 28;

  console.log(`=== SEO ${mode === 'weekly' ? 'Weekly' : 'Daily'} Report — ${today} ===\n`);

  // Auth
  const scopes = [GSC_SCOPE];
  if (GA4_PROPERTY_ID) scopes.push(GA4_SCOPE);

  let token;
  try {
    token = await getAccessToken(scopes);
  } catch (e) {
    console.error(`Auth failed: ${e.message}`);
    process.exit(1);
  }

  // Fetch GSC data
  let gscSummary = null;
  let gscKeywords = null;
  let gscPages = null;
  try {
    console.log('Fetching GSC data...');
    [gscSummary, gscKeywords, gscPages] = await Promise.all([
      getSummaryMetrics(token, GSC_SITE, days),
      mode === 'weekly' ? getTopKeywords(token, GSC_SITE, days, 10) : null,
      mode === 'weekly' ? getTopPages(token, GSC_SITE, days, 10) : null,
    ]);
    console.log(`GSC: ${gscSummary.clicks} clicks, ${gscSummary.impressions} impressions`);
  } catch (e) {
    console.error(`GSC fetch failed: ${e.message}`);
  }

  // Fetch GA4 data (skip if no property ID)
  let ga4Overview = null;
  let ga4Landing = null;
  let ga4Sources = null;
  if (GA4_PROPERTY_ID) {
    try {
      console.log('Fetching GA4 data...');
      [ga4Overview, ga4Landing, ga4Sources] = await Promise.all([
        getTrafficOverview(token, GA4_PROPERTY_ID, days),
        mode === 'weekly' ? getTopLandingPages(token, GA4_PROPERTY_ID, days, 10) : null,
        mode === 'weekly' ? getTrafficSources(token, GA4_PROPERTY_ID, days) : null,
      ]);
      console.log(`GA4: ${ga4Overview.sessions} sessions, ${ga4Overview.users} users`);
    } catch (e) {
      console.error(`GA4 fetch failed: ${e.message}`);
    }
  } else {
    console.log('GA4_PROPERTY_ID not set, skipping GA4 data');
  }

  if (!gscSummary && !ga4Overview) {
    console.error('No data fetched from either GSC or GA4. Exiting.');
    process.exit(1);
  }

  // Load history & compare
  const history = loadHistory();
  const lastEntry = getLastEntry(history);
  if (lastEntry) {
    console.log(`Last report: ${lastEntry.date}`);
  }

  // Save today's entry
  const todayEntry = {
    date: today,
    mode,
    gsc: gscSummary ? {
      clicks: gscSummary.clicks,
      impressions: gscSummary.impressions,
      ctr: parseFloat(gscSummary.ctr),
      position: parseFloat(gscSummary.position),
    } : null,
    ga4: ga4Overview ? {
      sessions: ga4Overview.sessions,
      users: ga4Overview.users,
      pageviews: ga4Overview.pageviews,
    } : null,
  };
  history.entries.push(todayEntry);
  if (history.entries.length > 90) {
    history.entries = history.entries.slice(-90);
  }
  saveHistory(history);

  // Format report
  let message;
  if (mode === 'weekly') {
    message = formatWeeklyReport(gscSummary, ga4Overview, gscKeywords, gscPages, ga4Landing, ga4Sources);
  } else {
    message = formatDailyReport(gscSummary, ga4Overview, lastEntry);
  }

  console.log('\n--- Slack Message ---');
  console.log(message);
  console.log('--- End ---\n');

  // Post to Slack
  const slackToken = getSlackToken();
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
