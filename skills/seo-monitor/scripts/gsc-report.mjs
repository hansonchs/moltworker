#!/usr/bin/env node
// Google Search Console Report — Zero dependencies
// Queries GSC Search Analytics API for keyword rankings, top pages, and device breakdown.
//
// Usage: node gsc-report.mjs [site] [days]
//   site  — GSC site URL (default: sc-domain:hkmovie6.com)
//   days  — Number of days to query (default: 28)
//
// Output: Plain text for AI consumption

import { getAccessToken } from './google-auth.mjs';

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GSC_API = 'https://searchconsole.googleapis.com/webmasters/v3/sites';

// GSC data has ~3 day delay
const DATA_DELAY_DAYS = 3;

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

async function queryGSC(token, siteUrl, params) {
  const encodedSite = encodeURIComponent(siteUrl);
  const url = `${GSC_API}/${encodedSite}/searchAnalytics/query`;
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
    throw new Error(`GSC API error (HTTP ${res.status}): ${body}`);
  }
  return res.json();
}

// ============================================================
// Report functions
// ============================================================

export async function getTopKeywords(token, siteUrl, days = 28, limit = 20) {
  const range = getDateRange(days);
  const prevRange = getPreviousDateRange(days);

  const [current, previous] = await Promise.all([
    queryGSC(token, siteUrl, {
      ...range,
      dimensions: ['query'],
      rowLimit: limit,
      dataState: 'final',
    }),
    queryGSC(token, siteUrl, {
      ...prevRange,
      dimensions: ['query'],
      rowLimit: 1000,
      dataState: 'final',
    }),
  ]);

  const prevMap = new Map();
  for (const row of previous.rows || []) {
    prevMap.set(row.keys[0], row);
  }

  const lines = [`=== Top ${limit} Keywords (${range.startDate} ~ ${range.endDate}) ===`];
  lines.push(`${'#'.padStart(3)} ${'Keyword'.padEnd(40)} ${'Clicks'.padStart(8)} ${'Impr'.padStart(8)} ${'CTR'.padStart(7)} ${'Pos'.padStart(6)} ${'Δ Pos'.padStart(7)}`);
  lines.push('-'.repeat(85));

  for (const [i, row] of (current.rows || []).entries()) {
    const keyword = row.keys[0];
    const prev = prevMap.get(keyword);
    const posChange = prev ? prev.position - row.position : 0;
    const posArrow = posChange > 0.5 ? `↑${posChange.toFixed(1)}` : posChange < -0.5 ? `↓${Math.abs(posChange).toFixed(1)}` : '—';

    lines.push(
      `${String(i + 1).padStart(3)} ${keyword.padEnd(40)} ${String(Math.round(row.clicks)).padStart(8)} ${String(Math.round(row.impressions)).padStart(8)} ${(row.ctr * 100).toFixed(1).padStart(6)}% ${row.position.toFixed(1).padStart(6)} ${posArrow.padStart(7)}`
    );
  }

  if (!current.rows?.length) {
    lines.push('  No data available for this period.');
  }

  return lines.join('\n');
}

export async function getTopPages(token, siteUrl, days = 28, limit = 20) {
  const range = getDateRange(days);
  const prevRange = getPreviousDateRange(days);

  const [current, previous] = await Promise.all([
    queryGSC(token, siteUrl, {
      ...range,
      dimensions: ['page'],
      rowLimit: limit,
      dataState: 'final',
    }),
    queryGSC(token, siteUrl, {
      ...prevRange,
      dimensions: ['page'],
      rowLimit: 1000,
      dataState: 'final',
    }),
  ]);

  const prevMap = new Map();
  for (const row of previous.rows || []) {
    prevMap.set(row.keys[0], row);
  }

  const lines = [`=== Top ${limit} Pages (${range.startDate} ~ ${range.endDate}) ===`];
  lines.push(`${'#'.padStart(3)} ${'Page'.padEnd(60)} ${'Clicks'.padStart(8)} ${'Impr'.padStart(8)} ${'CTR'.padStart(7)}`);
  lines.push('-'.repeat(90));

  for (const [i, row] of (current.rows || []).entries()) {
    const page = row.keys[0].replace('https://hkmovie6.com', '').replace('https://www.hkmovie6.com', '') || '/';
    const prev = prevMap.get(row.keys[0]);
    const clickChange = prev ? row.clicks - prev.clicks : 0;
    const arrow = clickChange > 0 ? '↑' : clickChange < 0 ? '↓' : '';

    lines.push(
      `${String(i + 1).padStart(3)} ${page.padEnd(60)} ${String(Math.round(row.clicks)).padStart(7)}${arrow} ${String(Math.round(row.impressions)).padStart(8)} ${(row.ctr * 100).toFixed(1).padStart(6)}%`
    );
  }

  if (!current.rows?.length) {
    lines.push('  No data available for this period.');
  }

  return lines.join('\n');
}

export async function getDeviceBreakdown(token, siteUrl, days = 28) {
  const range = getDateRange(days);

  const result = await queryGSC(token, siteUrl, {
    ...range,
    dimensions: ['device'],
    dataState: 'final',
  });

  const lines = [`=== Device Breakdown (${range.startDate} ~ ${range.endDate}) ===`];
  const totalClicks = (result.rows || []).reduce((sum, r) => sum + r.clicks, 0);

  for (const row of result.rows || []) {
    const pct = totalClicks > 0 ? ((row.clicks / totalClicks) * 100).toFixed(1) : '0.0';
    lines.push(`  ${row.keys[0].padEnd(10)} — ${String(Math.round(row.clicks)).padStart(8)} clicks (${pct}%), avg pos ${row.position.toFixed(1)}`);
  }

  if (!result.rows?.length) {
    lines.push('  No data available.');
  }

  return lines.join('\n');
}

export async function getSummaryMetrics(token, siteUrl, days = 28) {
  const range = getDateRange(days);
  const prevRange = getPreviousDateRange(days);

  const [current, previous] = await Promise.all([
    queryGSC(token, siteUrl, { ...range, dataState: 'final' }),
    queryGSC(token, siteUrl, { ...prevRange, dataState: 'final' }),
  ]);

  const cur = current.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const prev = previous.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };

  const clicksDelta = cur.clicks - prev.clicks;
  const clicksPct = prev.clicks > 0 ? ((clicksDelta / prev.clicks) * 100).toFixed(1) : 'N/A';
  const imprDelta = cur.impressions - prev.impressions;
  const imprPct = prev.impressions > 0 ? ((imprDelta / prev.impressions) * 100).toFixed(1) : 'N/A';
  const posDelta = prev.position - cur.position; // positive = improved

  return {
    period: `${range.startDate} ~ ${range.endDate}`,
    clicks: Math.round(cur.clicks),
    clicksDelta: Math.round(clicksDelta),
    clicksPct,
    impressions: Math.round(cur.impressions),
    impressionsDelta: Math.round(imprDelta),
    impressionsPct: imprPct,
    ctr: (cur.ctr * 100).toFixed(2),
    prevCtr: (prev.ctr * 100).toFixed(2),
    position: cur.position.toFixed(1),
    positionDelta: posDelta.toFixed(1),
  };
}

// ============================================================
// CLI entry point
// ============================================================

async function main() {
  const siteUrl = process.argv[2] || 'sc-domain:hkmovie6.com';
  const days = parseInt(process.argv[3] || '28', 10);

  console.log(`=== GSC Report — ${siteUrl} — Last ${days} days ===\n`);

  let token;
  try {
    token = await getAccessToken(GSC_SCOPE);
  } catch (e) {
    console.error(`Auth failed: ${e.message}`);
    process.exit(1);
  }

  const summary = await getSummaryMetrics(token, siteUrl, days);
  console.log(`Period: ${summary.period}`);
  console.log(`Clicks: ${summary.clicks} (${summary.clicksDelta >= 0 ? '+' : ''}${summary.clicksDelta}, ${summary.clicksPct}%)`);
  console.log(`Impressions: ${summary.impressions} (${summary.impressionsDelta >= 0 ? '+' : ''}${summary.impressionsDelta}, ${summary.impressionsPct}%)`);
  console.log(`CTR: ${summary.ctr}% (prev: ${summary.prevCtr}%)`);
  console.log(`Avg Position: ${summary.position} (${parseFloat(summary.positionDelta) >= 0 ? '↑' : '↓'}${Math.abs(parseFloat(summary.positionDelta))})`);
  console.log('');

  console.log(await getTopKeywords(token, siteUrl, days));
  console.log('');
  console.log(await getTopPages(token, siteUrl, days));
  console.log('');
  console.log(await getDeviceBreakdown(token, siteUrl, days));
}

if (process.argv[1]?.endsWith('gsc-report.mjs')) {
  main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
}
