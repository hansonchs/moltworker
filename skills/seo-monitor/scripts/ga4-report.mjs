#!/usr/bin/env node
// Google Analytics 4 Report — Zero dependencies
// Queries GA4 Data API for traffic overview, top landing pages, and traffic sources.
//
// Usage: node ga4-report.mjs [propertyId] [days]
//   propertyId — GA4 property ID (default: from env GA4_PROPERTY_ID)
//   days       — Number of days to query (default: 28)
//
// Output: Plain text for AI consumption

import { getAccessToken } from './google-auth.mjs';

const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const GA4_API = 'https://analyticsdata.googleapis.com/v1beta/properties';

// GA4 data has ~1 day delay
const DATA_DELAY_DAYS = 1;

function dateStr(date) {
  return date.toISOString().split('T')[0];
}

function getDateRange(days) {
  const end = new Date();
  end.setDate(end.getDate() - DATA_DELAY_DAYS);
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return { startDate: dateStr(start), endDate: dateStr(end) };
}

function getPreviousDateRange(days) {
  const end = new Date();
  end.setDate(end.getDate() - DATA_DELAY_DAYS - days);
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return { startDate: dateStr(start), endDate: dateStr(end) };
}

async function runGA4Report(token, propertyId, params) {
  const url = `${GA4_API}/${propertyId}:runReport`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GA4 API error (HTTP ${res.status}): ${body}`);
  }
  return res.json();
}

function getMetricValue(row, index) {
  return parseInt(row.metricValues?.[index]?.value || '0', 10);
}

function getMetricFloat(row, index) {
  return parseFloat(row.metricValues?.[index]?.value || '0');
}

// ============================================================
// Report functions
// ============================================================

export async function getTrafficOverview(token, propertyId, days = 28) {
  const range = getDateRange(days);
  const prevRange = getPreviousDateRange(days);

  const reportParams = {
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'screenPageViews' },
      { name: 'bounceRate' },
      { name: 'averageSessionDuration' },
      { name: 'newUsers' },
    ],
    dateRanges: [
      { startDate: range.startDate, endDate: range.endDate },
      { startDate: prevRange.startDate, endDate: prevRange.endDate },
    ],
  };

  const result = await runGA4Report(token, propertyId, reportParams);
  const rows = result.rows || [];

  // First row = current period, second row (if exists via dateRange comparison) = previous
  // GA4 returns rows per dateRange when using multiple dateRanges
  const cur = rows[0] || { metricValues: [] };
  const prev = rows[1] || { metricValues: [] };

  const metrics = [
    { label: 'Sessions', cur: getMetricValue(cur, 0), prev: getMetricValue(prev, 0) },
    { label: 'Users', cur: getMetricValue(cur, 1), prev: getMetricValue(prev, 1) },
    { label: 'Pageviews', cur: getMetricValue(cur, 2), prev: getMetricValue(prev, 2) },
    { label: 'Bounce Rate', cur: getMetricFloat(cur, 3), prev: getMetricFloat(prev, 3), pct: true },
    { label: 'Avg Duration', cur: getMetricFloat(cur, 4), prev: getMetricFloat(prev, 4), duration: true },
    { label: 'New Users', cur: getMetricValue(cur, 5), prev: getMetricValue(prev, 5) },
  ];

  const lines = [`=== Traffic Overview (${range.startDate} ~ ${range.endDate}) ===`];

  for (const m of metrics) {
    let curStr, delta;
    if (m.duration) {
      curStr = `${m.cur.toFixed(0)}s`;
      delta = m.cur - m.prev;
    } else if (m.pct) {
      curStr = `${(m.cur * 100).toFixed(1)}%`;
      delta = (m.cur - m.prev) * 100;
    } else {
      curStr = String(m.cur);
      delta = m.cur - m.prev;
    }
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
    const deltaStr = m.pct ? `${Math.abs(delta).toFixed(1)}pp` : m.duration ? `${Math.abs(delta).toFixed(0)}s` : String(Math.abs(Math.round(delta)));
    const pctChange = m.prev > 0 && !m.pct ? ` (${((delta / (m.pct ? 1 : m.prev)) * 100).toFixed(1)}%)` : '';

    lines.push(`  ${m.label.padEnd(16)} ${curStr.padStart(10)}  ${arrow} ${deltaStr}${pctChange}`);
  }

  return {
    text: lines.join('\n'),
    sessions: getMetricValue(cur, 0),
    sessionsDelta: getMetricValue(cur, 0) - getMetricValue(prev, 0),
    users: getMetricValue(cur, 1),
    usersDelta: getMetricValue(cur, 1) - getMetricValue(prev, 1),
    pageviews: getMetricValue(cur, 2),
    pageviewsDelta: getMetricValue(cur, 2) - getMetricValue(prev, 2),
    period: `${range.startDate} ~ ${range.endDate}`,
  };
}

export async function getTopLandingPages(token, propertyId, days = 28, limit = 15) {
  const range = getDateRange(days);

  const result = await runGA4Report(token, propertyId, {
    dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
    dimensions: [{ name: 'landingPagePlusQueryString' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'bounceRate' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit,
  });

  const lines = [`=== Top ${limit} Landing Pages (${range.startDate} ~ ${range.endDate}) ===`];
  lines.push(`${'#'.padStart(3)} ${'Page'.padEnd(55)} ${'Sessions'.padStart(10)} ${'Users'.padStart(8)} ${'Bounce'.padStart(8)}`);
  lines.push('-'.repeat(90));

  for (const [i, row] of (result.rows || []).entries()) {
    const page = row.dimensionValues[0].value || '/';
    const sessions = getMetricValue(row, 0);
    const users = getMetricValue(row, 1);
    const bounce = (getMetricFloat(row, 2) * 100).toFixed(1);

    lines.push(
      `${String(i + 1).padStart(3)} ${page.slice(0, 55).padEnd(55)} ${String(sessions).padStart(10)} ${String(users).padStart(8)} ${bounce.padStart(7)}%`
    );
  }

  if (!result.rows?.length) {
    lines.push('  No data available.');
  }

  return lines.join('\n');
}

export async function getTrafficSources(token, propertyId, days = 28) {
  const range = getDateRange(days);
  const prevRange = getPreviousDateRange(days);

  const params = {
    dateRanges: [
      { startDate: range.startDate, endDate: range.endDate },
    ],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 10,
  };

  const [current, previous] = await Promise.all([
    runGA4Report(token, propertyId, params),
    runGA4Report(token, propertyId, {
      ...params,
      dateRanges: [{ startDate: prevRange.startDate, endDate: prevRange.endDate }],
    }),
  ]);

  const prevMap = new Map();
  for (const row of previous.rows || []) {
    prevMap.set(row.dimensionValues[0].value, getMetricValue(row, 0));
  }

  const totalSessions = (current.rows || []).reduce((sum, r) => sum + getMetricValue(r, 0), 0);

  const lines = [`=== Traffic Sources (${range.startDate} ~ ${range.endDate}) ===`];
  lines.push(`${'Channel'.padEnd(30)} ${'Sessions'.padStart(10)} ${'Share'.padStart(8)} ${'Change'.padStart(10)}`);
  lines.push('-'.repeat(62));

  for (const row of current.rows || []) {
    const channel = row.dimensionValues[0].value;
    const sessions = getMetricValue(row, 0);
    const share = totalSessions > 0 ? ((sessions / totalSessions) * 100).toFixed(1) : '0.0';
    const prevSessions = prevMap.get(channel) || 0;
    const delta = sessions - prevSessions;
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
    const pctChange = prevSessions > 0 ? `${((delta / prevSessions) * 100).toFixed(1)}%` : 'new';

    lines.push(
      `${channel.padEnd(30)} ${String(sessions).padStart(10)} ${share.padStart(7)}% ${arrow} ${pctChange.padStart(8)}`
    );
  }

  if (!current.rows?.length) {
    lines.push('  No data available.');
  }

  return lines.join('\n');
}

// ============================================================
// CLI entry point
// ============================================================

async function main() {
  const propertyId = process.argv[2] || process.env.GA4_PROPERTY_ID;
  const days = parseInt(process.argv[3] || '28', 10);

  if (!propertyId) {
    console.error('GA4 Property ID required. Usage: node ga4-report.mjs <propertyId> [days]');
    console.error('Or set GA4_PROPERTY_ID environment variable.');
    process.exit(1);
  }

  console.log(`=== GA4 Report — Property ${propertyId} — Last ${days} days ===\n`);

  let token;
  try {
    token = await getAccessToken(GA4_SCOPE);
  } catch (e) {
    console.error(`Auth failed: ${e.message}`);
    process.exit(1);
  }

  const overview = await getTrafficOverview(token, propertyId, days);
  console.log(overview.text);
  console.log('');
  console.log(await getTopLandingPages(token, propertyId, days));
  console.log('');
  console.log(await getTrafficSources(token, propertyId, days));
}

if (process.argv[1]?.endsWith('ga4-report.mjs')) {
  main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
}
