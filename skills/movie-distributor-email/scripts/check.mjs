#!/usr/bin/env node
// Movie Distributor Email Cross-Check (v2)
// 1. Fetches distributor emails via IMAP (zero-dep, raw TLS)
// 2. Extracts movie info (titles, posters, trailers)
// 3. Cross-checks against hkmovie6.com gRPC API (showing + upcoming)
// 4. Reports discrepancies to Slack
//
// Zero external dependencies — uses Node.js 22 built-in fetch + tls.

import tls from 'node:tls';
import fs from 'node:fs';

// Config
const EMAIL_USER = process.env.EMAIL_USER || 'movie6.agent@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS || 'cdqc jftk rvbm hfce';
const DAYS_BACK = parseInt(process.env.DAYS_BACK || '3'); // scan emails from last N days
const SLACK_CHANNEL_NAME = 'automation-testing';
const BASE_URL = 'https://hkmovie6.com';
const GRPC_BASE = `${BASE_URL}/m6-api`;

// ============================================================
// Protobuf codec (from movie-qa-check, minimal zero-dep)
// ============================================================

function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0;
  while (v > 0x7f) { bytes.push((v & 0x7f) | 0x80); v >>>= 7; }
  bytes.push(v & 0x7f);
  return bytes;
}

function readVarint(buf, offset) {
  let result = 0, shift = 0, pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 63) throw new Error('varint too long');
  }
  throw new Error('unexpected end of varint');
}

function decodeFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = readVarint(buf, pos);
    pos = p1;
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (wireType === 0) { const [value, p2] = readVarint(buf, pos); fields.push({ f: fieldNum, v: value }); pos = p2; }
    else if (wireType === 1) { pos += 8; }
    else if (wireType === 2) { const [len, p2] = readVarint(buf, pos); fields.push({ f: fieldNum, b: buf.subarray(p2, p2 + len) }); pos = p2 + len; }
    else if (wireType === 5) { pos += 4; }
    else break;
  }
  return fields;
}

function encodeGrpcFrame(protobufBytes) {
  const frame = new Uint8Array(5 + protobufBytes.length);
  frame[0] = 0x00;
  new DataView(frame.buffer).setUint32(1, protobufBytes.length, false);
  frame.set(protobufBytes, 5);
  return frame;
}

function decodeGrpcFrame(buf) {
  if (buf.length < 5) throw new Error('gRPC response too short');
  const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1, false);
  return buf.subarray(5, 5 + len);
}

function encodeStringField(fieldNum, str) {
  const bytes = new TextEncoder().encode(str);
  const tag = (fieldNum << 3) | 2;
  return new Uint8Array([...encodeVarint(tag), ...encodeVarint(bytes.length), ...bytes]);
}

// ============================================================
// Movie6 gRPC API
// ============================================================

const GRPC_HEADERS = {
  'Content-Type': 'application/grpc-web+proto',
  'Accept': 'application/grpc-web+proto',
  'X-Grpc-Web': '1',
  'language': 'zhHK',
  'Type': 'application/grpc',
};

async function grpcCall(path, body, token) {
  const headers = { ...GRPC_HEADERS };
  if (token) headers['authorization'] = token;
  const res = await fetch(`${GRPC_BASE}/${path}`, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`gRPC ${path}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function getAnonymousToken() {
  const raw = await grpcCall('userpb.API/Anonymous', encodeGrpcFrame(new Uint8Array(0)));
  const msg = decodeGrpcFrame(raw);
  const fields = decodeFields(msg);
  const decoder = new TextDecoder();
  for (const f of fields) {
    if (f.b) {
      try {
        for (const inf of decodeFields(f.b)) {
          if (inf.b) { const str = decoder.decode(inf.b); if (str.startsWith('eyJ') && str.length > 100) return str; }
        }
      } catch (_) {}
    }
  }
  const text = decoder.decode(msg);
  const match = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (match) return match[0];
  throw new Error('No JWT token found');
}

function encodePageRequest(page, size) {
  const parts = [];
  if (page > 0) parts.push(0x08, ...encodeVarint(page));
  parts.push(0x10, ...encodeVarint(size));
  return new Uint8Array(parts);
}

function decodeMovieList(buf) {
  const fields = decodeFields(buf);
  const movies = [];
  const decoder = new TextDecoder();
  for (const f of fields) {
    if (f.f === 1 && f.b) {
      const mFields = decodeFields(f.b);
      const movie = { uuid: '', name: '', poster: '', duration: 0 };
      for (const mf of mFields) {
        if (mf.f === 1 && mf.b) movie.uuid = decoder.decode(mf.b);
        else if (mf.f === 2 && mf.b) movie.name = decoder.decode(mf.b);
        else if (mf.f === 4 && mf.b) movie.poster = decoder.decode(mf.b);
        else if (mf.f === 9 && mf.v !== undefined) movie.duration = mf.v;
      }
      if (movie.uuid) movies.push(movie);
    }
  }
  return movies;
}

async function fetchAllMovies(token) {
  const [showingRaw, comingRaw] = await Promise.all([
    grpcCall('mvpb.MovieX/ListShowing', encodeGrpcFrame(encodePageRequest(0, 200)), token),
    grpcCall('mvpb.MovieX/ListComing', encodeGrpcFrame(encodePageRequest(0, 200)), token),
  ]);
  const showing = decodeMovieList(decodeGrpcFrame(showingRaw));
  const upcoming = decodeMovieList(decodeGrpcFrame(comingRaw));
  return { showing, upcoming };
}

// ============================================================
// Minimal IMAP client (raw TLS, zero-dep)
// ============================================================

class SimpleIMAP {
  constructor(host, port, user, pass) {
    this.host = host; this.port = port;
    this.user = user; this.pass = pass;
    this.tagNum = 0; this.buffer = '';
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false }, () => {});
      this.socket.setEncoding('utf8');
      this.socket.once('error', reject);
      // Wait for server greeting
      this.socket.once('data', (data) => {
        if (data.startsWith('* OK')) resolve();
        else reject(new Error('IMAP greeting failed: ' + data.trim()));
      });
    });
  }

  async command(cmd) {
    const tag = `A${++this.tagNum}`;
    return new Promise((resolve, reject) => {
      let response = '';
      const onData = (chunk) => {
        response += chunk;
        // Check if we got the tagged response
        if (response.includes(`${tag} OK`) || response.includes(`${tag} NO`) || response.includes(`${tag} BAD`)) {
          this.socket.removeListener('data', onData);
          if (response.includes(`${tag} NO`) || response.includes(`${tag} BAD`)) {
            reject(new Error(`IMAP error: ${response.trim()}`));
          } else {
            resolve(response);
          }
        }
      };
      this.socket.on('data', onData);
      this.socket.write(`${tag} ${cmd}\r\n`);
    });
  }

  async login() {
    await this.command(`LOGIN "${this.user}" "${this.pass}"`);
  }

  async selectInbox() {
    const res = await this.command('SELECT INBOX');
    const match = res.match(/\* (\d+) EXISTS/);
    return match ? parseInt(match[1]) : 0;
  }

  async search(criteria) {
    const res = await this.command(`SEARCH ${criteria}`);
    const match = res.match(/\* SEARCH ([\d ]*)/);
    if (!match || !match[1].trim()) return [];
    return match[1].trim().split(/\s+/).map(Number);
  }

  async fetchHeaders(uid) {
    const res = await this.command(`FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`);
    return res;
  }

  async fetchBody(uid) {
    const res = await this.command(`FETCH ${uid} (BODY.PEEK[TEXT])`);
    return res;
  }

  async logout() {
    try { await this.command('LOGOUT'); } catch (_) {}
    this.socket.destroy();
  }
}

// ============================================================
// Email parsing
// ============================================================

function decodeQuotedPrintable(text) {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeMimeHeader(str) {
  // Decode =?UTF-8?B?...?= and =?UTF-8?Q?...?=
  return str.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, charset, encoding, data) => {
    if (encoding.toUpperCase() === 'B') {
      return Buffer.from(data, 'base64').toString('utf8');
    } else {
      return decodeQuotedPrintable(data.replace(/_/g, ' '));
    }
  });
}

function extractMovieInfo(headerRaw, bodyRaw) {
  const header = decodeMimeHeader(headerRaw);
  const body = decodeQuotedPrintable(bodyRaw);
  const fullText = header + '\n' + body;

  // Extract subject
  const subjectMatch = header.match(/Subject:\s*(.+?)(?:\r?\n(?!\s)|$)/s);
  const subject = subjectMatch ? subjectMatch[1].replace(/\r?\n\s*/g, ' ').trim() : '';

  // Extract from
  const fromMatch = header.match(/From:\s*(.+?)(?:\r?\n(?!\s)|$)/s);
  const from = fromMatch ? fromMatch[1].replace(/\r?\n\s*/g, ' ').trim() : '';

  // Extract date
  const dateMatch = header.match(/Date:\s*(.+?)(?:\r?\n(?!\s)|$)/s);
  const date = dateMatch ? dateMatch[1].trim() : '';

  // Extract movie titles in 《》
  const titlePattern = /[《]([^》]+)[》]/g;
  const movieTitles = new Set();
  let m;
  while ((m = titlePattern.exec(fullText)) !== null) {
    const title = m[1].trim();
    if (title.length >= 2) movieTitles.add(title);
  }

  // Extract Google Drive links (poster/trailer materials)
  const drivePattern = /https:\/\/drive\.google\.com\/[^\s"<>)\]]+/g;
  const driveLinks = [];
  while ((m = drivePattern.exec(fullText)) !== null) {
    const url = m[0].replace(/[&;].*$/, '');
    if (!driveLinks.includes(url)) driveLinks.push(url);
  }

  // Extract YouTube links
  const ytPatterns = [
    /https?:\/\/(?:www\.)?youtu\.be\/[a-zA-Z0-9_-]+/g,
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/g,
  ];
  const ytLinks = [];
  for (const pattern of ytPatterns) {
    while ((m = pattern.exec(fullText)) !== null) {
      if (!ytLinks.includes(m[0])) ytLinks.push(m[0]);
    }
  }

  // Extract hkmovie6.com movie links
  const movieLinkPattern = /https?:\/\/hkmovie6\.com\/movie\/([a-f0-9-]+)/g;
  const movieLinks = [];
  while ((m = movieLinkPattern.exec(fullText)) !== null) {
    movieLinks.push({ uuid: m[1], url: m[0] });
  }

  // Extract release dates mentioned (格式: 2026年3月20日, 3月20日, 20/3/2026)
  const releaseDatePattern = /(\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日(?:上映)?|\d{1,2}\/\d{1,2}\/\d{4})/g;
  const dates = [];
  while ((m = releaseDatePattern.exec(fullText)) !== null) {
    dates.push(m[1]);
  }

  return {
    subject, from, date,
    movieTitles: Array.from(movieTitles),
    driveLinks, ytLinks, movieLinks, dates,
  };
}

// ============================================================
// Fuzzy matching
// ============================================================

function normalizeForMatch(name) {
  return name
    .replace(/[《》「」\[\]()（）\s]/g, '')
    .replace(/[：:·・—–\-]/g, '')
    .toLowerCase();
}

function findMovieOnWebsite(emailTitle, websiteMovies) {
  const normEmail = normalizeForMatch(emailTitle);
  // Exact match
  let match = websiteMovies.find(m => normalizeForMatch(m.name) === normEmail);
  if (match) return match;

  // Partial match: website name contains email title or vice versa
  match = websiteMovies.find(m => {
    const normWeb = normalizeForMatch(m.name);
    return normWeb.includes(normEmail) || normEmail.includes(normWeb);
  });
  return match || null;
}

// ============================================================
// Slack helpers
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
// Main
// ============================================================

async function main() {
  console.log('=== Movie Distributor Email Cross-Check v2 ===\n');
  const startTime = Date.now();

  // 1. Fetch website movies via gRPC
  console.log('1. Fetching movie lists from hkmovie6.com...');
  let token, showing, upcoming;
  try {
    token = await getAnonymousToken();
    const movies = await fetchAllMovies(token);
    showing = movies.showing;
    upcoming = movies.upcoming;
    console.log(`   Showing: ${showing.length}, Upcoming: ${upcoming.length}\n`);
  } catch (e) {
    console.error('Failed to fetch website movies:', e.message);
    process.exit(1);
  }

  const allWebsiteMovies = [...showing, ...upcoming];

  // 2. Connect to IMAP and fetch recent emails
  console.log('2. Connecting to email...');
  const imap = new SimpleIMAP('imap.gmail.com', 993, EMAIL_USER, EMAIL_PASS);

  let emails = [];
  try {
    await imap.connect();
    await imap.login();
    console.log('   IMAP connected');

    const totalMessages = await imap.selectInbox();
    console.log(`   Inbox: ${totalMessages} emails`);

    // Search for recent emails (last N days)
    const since = new Date();
    since.setDate(since.getDate() - DAYS_BACK);
    const sinceStr = since.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })
      .replace(',', ''); // "06 Mar 2026"
    // IMAP date format: DD-Mon-YYYY
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const imapDate = `${since.getDate()}-${months[since.getMonth()]}-${since.getFullYear()}`;

    console.log(`\n3. Searching emails since ${imapDate}...`);
    const uids = await imap.search(`SINCE ${imapDate}`);
    console.log(`   Found ${uids.length} recent emails`);

    // Fetch each email
    for (const uid of uids) {
      try {
        const headerRaw = await imap.fetchHeaders(uid);
        const bodyRaw = await imap.fetchBody(uid);
        const info = extractMovieInfo(headerRaw, bodyRaw);

        // Only keep emails that mention movies or have relevant content
        if (info.movieTitles.length > 0 || info.driveLinks.length > 0 ||
            info.ytLinks.length > 0 || info.movieLinks.length > 0) {
          emails.push(info);
        }
      } catch (e) {
        // Skip individual email errors
        continue;
      }
    }

    await imap.logout();
  } catch (e) {
    console.error('IMAP error:', e.message);
    try { await imap.logout(); } catch (_) {}
  }

  console.log(`   Movie-related emails: ${emails.length}\n`);

  if (emails.length === 0) {
    console.log('No movie update emails found. Exiting.');
    return;
  }

  // 3. Cross-check: compare email movie info with website
  console.log('4. Cross-checking email content against website...\n');

  const updates = []; // actionable updates to report

  for (const email of emails) {
    for (const title of email.movieTitles) {
      const webMovie = findMovieOnWebsite(title, allWebsiteMovies);
      const isShowing = webMovie ? showing.some(m => m.uuid === webMovie.uuid) : false;
      const isUpcoming = webMovie ? upcoming.some(m => m.uuid === webMovie.uuid) : false;

      const update = {
        emailTitle: title,
        emailSubject: email.subject,
        emailFrom: email.from,
        emailDate: email.date,
        webMovie,
        status: isShowing ? 'showing' : isUpcoming ? 'upcoming' : 'not_found',
        actions: [],
      };

      if (!webMovie) {
        // Movie in email but not on website at all
        update.actions.push('not_on_website');
      } else {
        // Check if email has poster links and website is missing poster
        if (email.driveLinks.length > 0) {
          if (!webMovie.poster || webMovie.poster.includes('moviePosterPH') || webMovie.poster.length < 10) {
            update.actions.push('has_poster_update');
          } else {
            update.actions.push('poster_available'); // website has it, but email has new version
          }
        }

        // Check if email has trailer links
        if (email.ytLinks.length > 0) {
          update.actions.push('has_trailer');
        }

        // Check website missing duration
        if (webMovie.duration === 0) {
          update.actions.push('website_missing_duration');
        }
      }

      // Attach links
      update.driveLinks = email.driveLinks;
      update.ytLinks = email.ytLinks;
      update.movieLinks = email.movieLinks;
      update.dates = email.dates;

      if (update.actions.length > 0) {
        updates.push(update);
      }
    }
  }

  // Deduplicate by movie title
  const seen = new Set();
  const uniqueUpdates = updates.filter(u => {
    const key = normalizeForMatch(u.emailTitle);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`   Actionable updates: ${uniqueUpdates.length}\n`);

  // 4. Format and send Slack report (always send summary)
  const dateStr = new Date().toLocaleDateString('zh-HK', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' });

  const lines = [
    '\u{1f4e7} Distributor Email Cross-Check',
    `\u{1f4c5} ${dateStr}`,
    `\u{1f4e8} ${emails.length} \u5c01\u76f8\u95dc\u90f5\u4ef6\uff08\u904e\u53bb ${DAYS_BACK} \u65e5\uff09`,
    '',
  ];

  if (uniqueUpdates.length === 0) {
    lines.push('\u2705 \u6240\u6709\u96fb\u90f5\u63d0\u53ca\u7684\u96fb\u5f71\u5df2\u5728\u7db2\u7ad9\u4e0a\uff0c\u7121\u9700\u66f4\u65b0');
  }

  // Group by action type
  const notOnWebsite = uniqueUpdates.filter(u => u.actions.includes('not_on_website'));
  const needsPoster = uniqueUpdates.filter(u => u.actions.includes('has_poster_update'));
  const hasPosterUpdate = uniqueUpdates.filter(u => u.actions.includes('poster_available'));
  const hasTrailer = uniqueUpdates.filter(u => u.actions.includes('has_trailer'));
  const missingDuration = uniqueUpdates.filter(u => u.actions.includes('website_missing_duration'));

  if (notOnWebsite.length > 0) {
    lines.push(`\u26a0\ufe0f \u96fb\u5f71\u672a\u5728\u7db2\u7ad9\u4e0a\uff08${notOnWebsite.length} \u90e8\uff09`);
    for (const u of notOnWebsite) {
      lines.push(`\u2022 \u300a${u.emailTitle}\u300b`);
      lines.push(`  \u4f86\u6e90\uff1a${u.emailFrom}`);
      if (u.dates.length > 0) lines.push(`  \u65e5\u671f\uff1a${u.dates.join(', ')}`);
    }
    lines.push('');
  }

  if (needsPoster.length > 0) {
    lines.push(`\u{1f5bc}\ufe0f \u6d77\u5831\u66f4\u65b0\uff08\u7db2\u7ad9\u7f3a\u5c11\u6d77\u5831\uff0c${needsPoster.length} \u90e8\uff09`);
    for (const u of needsPoster) {
      lines.push(`\u2022 \u300a${u.emailTitle}\u300b \u2014 ${u.status === 'showing' ? '\u4e0a\u6620\u4e2d' : '\u5373\u5c07\u4e0a\u6620'}`);
      lines.push(`  ${BASE_URL}/movie/${u.webMovie.uuid}`);
      for (const link of u.driveLinks) lines.push(`  \u{1f4ce} ${link}`);
    }
    lines.push('');
  }

  if (hasPosterUpdate.length > 0) {
    lines.push(`\u{1f4f7} \u65b0\u6d77\u5831/\u7269\u6599\u53ef\u7528\uff08${hasPosterUpdate.length} \u90e8\uff09`);
    for (const u of hasPosterUpdate) {
      lines.push(`\u2022 \u300a${u.emailTitle}\u300b \u2014 ${u.status === 'showing' ? '\u4e0a\u6620\u4e2d' : '\u5373\u5c07\u4e0a\u6620'}`);
      lines.push(`  ${BASE_URL}/movie/${u.webMovie.uuid}`);
      for (const link of u.driveLinks) lines.push(`  \u{1f4ce} ${link}`);
    }
    lines.push('');
  }

  if (hasTrailer.length > 0) {
    lines.push(`\u{1f3ac} \u65b0\u9810\u544a\u7247\uff08${hasTrailer.length} \u90e8\uff09`);
    for (const u of hasTrailer) {
      const loc = u.webMovie ? `${BASE_URL}/movie/${u.webMovie.uuid}` : '(not on website)';
      lines.push(`\u2022 \u300a${u.emailTitle}\u300b`);
      if (u.webMovie) lines.push(`  ${loc}`);
      for (const link of u.ytLinks) lines.push(`  \u{1f3a5} ${link}`);
    }
    lines.push('');
  }

  if (missingDuration.length > 0) {
    lines.push(`\u23f1\ufe0f \u7db2\u7ad9\u7f3a\u5c11\u7247\u9577\uff08${missingDuration.length} \u90e8\uff09`);
    for (const u of missingDuration) {
      lines.push(`\u2022 \u300a${u.emailTitle}\u300b \u2014 ${BASE_URL}/movie/${u.webMovie.uuid}`);
    }
    lines.push('');
  }

  // Summary
  lines.push(`\u2139\ufe0f \u7db2\u7ad9\u73fe\u6709\uff1a${showing.length} \u90e8\u4e0a\u6620\u4e2d\u3001${upcoming.length} \u90e8\u5373\u5c07\u4e0a\u6620`);

  const message = lines.join('\n');
  console.log('--- Slack Message ---');
  console.log(message);
  console.log('--- End ---\n');

  // Post to Slack
  let slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    try {
      const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
      slackToken = cfg?.channels?.slack?.botToken;
      if (slackToken) console.log('Using Slack token from openclaw.json');
    } catch (_) {}
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
