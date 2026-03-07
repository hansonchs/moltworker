#!/usr/bin/env node
// Shared Slack helpers for OpenClaw skills.
// Extracted from seo-report.mjs and movie-distributor-email/check.mjs.
//
// Zero external dependencies.

import fs from 'node:fs';

/**
 * Get Slack bot token from env or openclaw.json fallback.
 */
export function getSlackToken() {
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

/**
 * Find a Slack channel ID by name (paginated).
 */
export async function findSlackChannel(token, name) {
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

/**
 * Post a text message to a Slack channel.
 */
export async function postToSlack(token, channelId, text) {
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
