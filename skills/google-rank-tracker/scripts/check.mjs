#!/usr/bin/env node
// Movie6 Google Rank Tracker — Daily search ranking check
// Uses Cloudflare Browser Rendering (CDP over WebSocket) to render Google
// search results, finds hkmovie6.com position, compares with history.
//
// Zero external dependencies — uses Node.js 22 built-in fetch() and WebSocket.

import fs from 'node:fs';
import path from 'node:path';

const TARGET_DOMAIN = 'hkmovie6.com';
const KEYWORDS = ['香港電影', '電影場次', '香港戲院', 'movie6', 'hkmovie6'];
const SLACK_CHANNEL_NAME = 'automation-testing';
const HISTORY_DIR = '/root/clawd/skills/google-rank-tracker/data';
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');
const PAGE_WAIT_MS = 3000;
const CDP_TIMEOUT_MS = 30000;

// ============================================================
// CDP WebSocket client (Node.js 22 built-in WebSocket)
// ============================================================

function createCDPClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let messageId = 1;
    const pending = new Map();
    let targetId = null;
    let targetResolve;
    const targetReady = new Promise(r => { targetResolve = r; });

    function send(method, params = {}) {
      return new Promise((res, rej) => {
        const id = messageId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`CDP timeout: ${method}`));
        }, CDP_TIMEOUT_MS);
        pending.set(id, { resolve: res, reject: rej, timeout: timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());

      if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo?.type === 'page') {
        targetId = msg.params.targetInfo.targetId;
        targetResolve(targetId);
      }

      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject, timeout: timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });

    ws.addEventListener('error', (e) => reject(new Error(`WebSocket error: ${e.message || 'unknown'}`)));

    ws.addEventListener('open', async () => {
      try {
        await Promise.race([
          targetReady,
          new Promise((_, rej) => setTimeout(() => rej(new Error('No CDP target created within 10s')), 10000)),
        ]);

        resolve({
          ws,
          targetId,
          send,
          async navigate(url, waitMs = PAGE_WAIT_MS) {
            await send('Page.navigate', { url });
            await new Promise(r => setTimeout(r, waitMs));
          },
          async evaluate(expression) {
            return send('Runtime.evaluate', { expression, returnByValue: true });
          },
          close() {
            ws.close();
          },
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ============================================================
// Google search result extraction
// ============================================================

const EXTRACT_RESULTS_JS = `
(() => {
  const results = [];
  // Standard organic results
  const items = document.querySelectorAll('#search .g, #rso .g');
  items.forEach((el, i) => {
    const linkEl = el.querySelector('a[href]');
    if (!linkEl) return;
    const href = linkEl.getAttribute('href') || '';
    if (!href.startsWith('http')) return;
    const titleEl = el.querySelector('h3');
    const title = titleEl ? titleEl.textContent.trim() : '';
    results.push({ position: results.length + 1, url: href, title });
  });
  return JSON.stringify(results);
})()
`;

async function searchKeyword(client, keyword) {
  const searchUrl = `https://www.google.com.hk/search?q=${encodeURIComponent(keyword)}&hl=zh-TW&gl=hk&num=20`;
  console.log(`  Searching: "${keyword}" → ${searchUrl}`);

  await client.navigate(searchUrl, PAGE_WAIT_MS);

  const evalResult = await client.evaluate(EXTRACT_RESULTS_JS);
  const rawValue = evalResult?.result?.value;
  if (!rawValue) {
    console.warn(`  No results extracted for "${keyword}"`);
    return { keyword, rank: null, url: null, totalResults: 0 };
  }

  let results;
  try {
    results = JSON.parse(rawValue);
  } catch {
    console.warn(`  Failed to parse results for "${keyword}"`);
    return { keyword, rank: null, url: null, totalResults: 0 };
  }

  console.log(`  Found ${results.length} organic results`);

  // Find hkmovie6.com in results
  for (const r of results) {
    try {
      const hostname = new URL(r.url).hostname;
      if (hostname === TARGET_DOMAIN || hostname.endsWith(`.${TARGET_DOMAIN}`)) {
        console.log(`  ✓ Found at #${r.position}: ${r.url}`);
        return { keyword, rank: r.position, url: r.url, totalResults: results.length };
      }
    } catch { /* invalid URL, skip */ }
  }

  console.log(`  ✗ ${TARGET_DOMAIN} not found in top ${results.length}`);
  return { keyword, rank: null, url: null, totalResults: results.length };
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

function formatSlackMessage(date, results, lastEntry) {
  const lines = [];
  lines.push(`🔍 Google 排名追蹤（${date}）`);
  lines.push('');

  for (const r of results) {
    const lastRank = lastEntry?.rankings?.[r.keyword];
    let trend = '';

    if (r.rank == null) {
      trend = lastRank != null ? `（上次 #${lastRank}，今次未上榜 ⚠️）` : '（未上榜）';
      lines.push(`  "${r.keyword}"  → 未上榜${trend}`);
    } else if (lastRank != null) {
      if (r.rank < lastRank) trend = ` ⬆️`;
      else if (r.rank > lastRank) trend = ` ⬇️`;
      else trend = ` ➡️`;
      lines.push(`  "${r.keyword}"  → #${r.rank}（上次 #${lastRank}${trend}）`);
    } else {
      lines.push(`  "${r.keyword}"  → #${r.rank}（首次追蹤）`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// Main
// ============================================================

async function main() {
  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];
  console.log(`=== Google Rank Tracker — ${today} ===\n`);

  // 1. Check prerequisites
  const cdpSecret = process.env.CDP_SECRET;
  const workerUrl = process.env.WORKER_URL;

  if (!cdpSecret || !workerUrl) {
    console.error('CDP_SECRET and WORKER_URL must be set. Skipping Google rank check.');
    console.error(`  CDP_SECRET: ${cdpSecret ? 'set' : 'NOT SET'}`);
    console.error(`  WORKER_URL: ${workerUrl ? 'set' : 'NOT SET'}`);
    return;
  }

  // 2. Connect to Cloudflare Browser Rendering
  const cleanWorkerUrl = workerUrl.replace(/^https?:\/\//, '');
  const wsUrl = `wss://${cleanWorkerUrl}/cdp?secret=${encodeURIComponent(cdpSecret)}`;
  console.log(`Connecting to CDP: wss://${cleanWorkerUrl}/cdp?secret=***`);

  let client;
  try {
    client = await createCDPClient(wsUrl);
    console.log(`CDP connected (targetId: ${client.targetId})\n`);
  } catch (e) {
    console.error(`CDP connection failed: ${e.message}`);
    console.error('Skipping Google rank check.');
    return;
  }

  // 3. Search each keyword
  const results = [];
  try {
    for (const keyword of KEYWORDS) {
      const result = await searchKeyword(client, keyword);
      results.push(result);
      // Small delay between searches to be polite
      await new Promise(r => setTimeout(r, 1000));
    }
  } finally {
    client.close();
    console.log('\nCDP connection closed');
  }

  // 4. Load history & compare
  const history = loadHistory();
  const lastEntry = getLastEntry(history);
  if (lastEntry) {
    console.log(`Last check: ${lastEntry.date}`);
  }

  // 5. Save today's entry
  const rankings = {};
  for (const r of results) {
    if (r.rank != null) rankings[r.keyword] = r.rank;
  }
  const todayEntry = { date: today, rankings };
  history.entries.push(todayEntry);
  // Keep last 90 days
  if (history.entries.length > 90) {
    history.entries = history.entries.slice(-90);
  }
  saveHistory(history);

  // 6. Format report
  const message = formatSlackMessage(today, results, lastEntry);
  console.log('\n--- Slack Message ---');
  console.log(message);
  console.log('--- End ---\n');

  // 7. Post to Slack
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
