#!/usr/bin/env node
// Movie6 Daily Data Quality Check (v6 — gRPC Detail + wmoov cross-ref)
// Uses the Movie6 gRPC-web API to fetch ALL movies, then uses gRPC Detail
// to get rating (I/IIA/IIB/III) + duration for each showing movie.
// Cross-references with wmoov.com for movies still missing rating/duration.
// Classifies special screenings separately from regular movies.
//
// Zero external dependencies — uses Node.js 22 built-in fetch().

const BASE_URL = 'https://hkmovie6.com';
const GRPC_BASE = `${BASE_URL}/m6-api`;
const PAGE_SIZE = 200; // Fetch all movies in one request
const CONCURRENCY = 8;
const BATCH_DELAY_MS = 150;
const SLACK_CHANNEL_NAME = 'automation-testing';

// ============================================================
// Protobuf codec (minimal, zero-dependency)
// ============================================================

function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0; // ensure unsigned 32-bit
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return bytes;
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
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

    if (wireType === 0) { // varint
      const [value, p2] = readVarint(buf, pos);
      fields.push({ f: fieldNum, v: value });
      pos = p2;
    } else if (wireType === 1) { // 64-bit fixed
      pos += 8; // skip (we don't need doubles)
    } else if (wireType === 2) { // length-delimited
      const [len, p2] = readVarint(buf, pos);
      const data = buf.subarray(p2, p2 + len);
      fields.push({ f: fieldNum, b: data });
      pos = p2 + len;
    } else if (wireType === 5) { // 32-bit fixed
      pos += 4;
    } else {
      break; // unknown wire type, stop
    }
  }
  return fields;
}

function encodeGrpcFrame(protobufBytes) {
  const frame = new Uint8Array(5 + protobufBytes.length);
  frame[0] = 0x00; // data frame
  const view = new DataView(frame.buffer);
  view.setUint32(1, protobufBytes.length, false); // big-endian length
  frame.set(protobufBytes, 5);
  return frame;
}

function decodeGrpcFrame(buf) {
  if (buf.length < 5) throw new Error('gRPC response too short');
  const view = new DataView(buf.buffer, buf.byteOffset);
  const len = view.getUint32(1, false);
  return buf.subarray(5, 5 + len);
}

function encodeStringField(fieldNum, str) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  const tag = (fieldNum << 3) | 2; // wire type 2 = length-delimited
  return new Uint8Array([...encodeVarint(tag), ...encodeVarint(bytes.length), ...bytes]);
}

// ============================================================
// Movie6 gRPC-web API
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
  const res = await fetch(`${GRPC_BASE}/${path}`, {
    method: 'POST',
    headers,
    body,
  });
  if (!res.ok) throw new Error(`gRPC ${path}: HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

async function getAnonymousToken() {
  const frame = encodeGrpcFrame(new Uint8Array(0));
  const raw = await grpcCall('userpb.API/Anonymous', frame);
  const msg = decodeGrpcFrame(raw);
  const fields = decodeFields(msg);
  const decoder = new TextDecoder();

  for (const f of fields) {
    if (f.b) {
      try {
        const inner = decodeFields(f.b);
        for (const inf of inner) {
          if (inf.b) {
            const str = decoder.decode(inf.b);
            if (str.startsWith('eyJ') && str.length > 100) return str;
          }
        }
      } catch (_) { /* not a nested message, try next */ }
    }
  }

  const text = decoder.decode(msg);
  const match = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (match) return match[0];

  throw new Error('No JWT token found in Anonymous response');
}

function encodePageRequest(page, size) {
  const parts = [];
  if (page > 0) {
    parts.push(0x08, ...encodeVarint(page)); // field 1: page
  }
  parts.push(0x10, ...encodeVarint(size)); // field 2: size
  return new Uint8Array(parts);
}

function decodeMovieList(buf) {
  const fields = decodeFields(buf);
  const movies = [];
  let totalElements = 0;
  let totalPages = 0;

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
    } else if (f.f === 4 && f.v !== undefined) {
      totalElements = f.v;
    } else if (f.f === 5 && f.v !== undefined) {
      totalPages = f.v;
    }
  }

  return { movies, totalElements, totalPages };
}

async function fetchMovieList(token, method) {
  const reqMsg = encodePageRequest(0, PAGE_SIZE);
  const frame = encodeGrpcFrame(reqMsg);
  const raw = await grpcCall(`mvpb.MovieX/${method}`, frame, token);
  const msg = decodeGrpcFrame(raw);
  return decodeMovieList(msg);
}

// HK film rating: field 18 enum → display string
const RATING_MAP = { 0: 'TBC', 1: 'I', 2: 'IIA', 3: 'IIB', 4: 'III' };

// Decode gRPC Detail response → { rating: string, duration: number }
function decodeMovieDetail(buf) {
  const outerFields = decodeFields(buf);
  const result = { rating: 'TBC', duration: 0 };

  // Detail response wraps movie in field 1
  let movieFields = outerFields;
  const f1 = outerFields.find(f => f.f === 1 && f.b);
  if (f1) {
    try {
      const nested = decodeFields(f1.b);
      if (nested.some(f => f.f >= 8)) movieFields = nested;
    } catch (_) {}
  }

  for (const f of movieFields) {
    if (f.f === 18 && f.v !== undefined) {
      result.rating = RATING_MAP[f.v] || 'TBC';
    }
    if (f.f === 9 && f.v !== undefined && f.v > 0 && !result.duration) {
      result.duration = f.v;
    }
    if (f.f === 17 && f.v !== undefined && f.v > 0) {
      result.duration = f.v; // field 17 takes priority
    }
  }

  return result;
}

// ============================================================
// Batch helpers
// ============================================================

async function batchFetch(items, fn, concurrency = CONCURRENCY) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
    if (i + concurrency < items.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }
  return results;
}

// ============================================================
// Screening-variant duplicate detection
// ============================================================

const SCREENING_SUFFIXES = [
  '明星好友場', '好友場', '見面場', '謝票場', '首映場',
  '優先場', '特別場', '慈善場', '包場', '粵語配音版',
  '口述影像場', '通達放映場',
];

function normalizeMovieName(name) {
  let n = name.replace(/[《》]/g, '').trim();
  for (const suffix of SCREENING_SUFFIXES) {
    if (n.endsWith(suffix)) {
      n = n.slice(0, -suffix.length).trim();
      break;
    }
  }
  return n;
}

// ============================================================
// Special screening classification
// ============================================================

const SPECIAL_PATTERNS = [
  { re: /LIVE\s*VIEWING|現場直播|LIVE\s*IN\s*CINEMA/i, tag: '直播' },
  { re: /CONCERT|VR\s*CONCERT|演唱會/i, tag: '演唱會' },
  { re: /The\s+Met\s+\d{4}|MET\s+\d{4}/i, tag: '歌劇' },
  { re: /Paris\s+Opera|Opera\s+Ballet/i, tag: '芭蕾' },
  { re: /4K\s*修復版|4K\s*Restoration/i, tag: '經典修復' },
  { re: /3D\s*版/i, tag: '重映' },
  { re: /GFF\s+\d{4}|InDPanda|bcDocs|bcSunday|Cinema\s+PANDA|EOS\s+\d{4}/i, tag: '電影節' },
  { re: /M\+\s*[Pp]rogramme|M\+\s*programme/i, tag: '特別放映' },
  { re: /特別放映|特別加映|特別場/i, tag: '特別放映' },
  { re: /CA\s+Retro/i, tag: '經典修復' },
];

function classifyMovie(name) {
  for (const { re, tag } of SPECIAL_PATTERNS) {
    if (re.test(name)) return tag;
  }
  return null; // regular movie
}

// ============================================================
// wmoov.com cross-reference (rating + duration)
// ============================================================

// Normalize name for fuzzy matching: strip spaces around numbers, brackets, etc.
function normalizeForMatch(name) {
  return name
    .replace(/[《》「」\[\]()（）]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

async function fetchWmoovIndex() {
  const index = new Map(); // normalizedName -> { id, name }
  for (const page of ['showing', 'upcoming']) {
    let html;
    try {
      const res = await fetch(`https://wmoov.com/movie/${page}`, {
        headers: { 'User-Agent': 'Movie6-QA-Bot/1.0' },
      });
      if (!res.ok) continue;
      html = await res.text();
    } catch (_) { continue; }

    const re = /<option value="(\d+)">([^<]+)<\/option>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const name = m[2].trim();
      // wmoov lists versions like "優獸大都會2 (英語版)" — store base name too
      const baseName = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const key = normalizeForMatch(baseName);
      if (!index.has(key)) index.set(key, { id: m[1], name });
    }
  }
  return index;
}

async function fetchWmoovDetail(id) {
  const res = await fetch(`https://wmoov.com/movie/details/${id}`, {
    headers: { 'User-Agent': 'Movie6-QA-Bot/1.0' },
  });
  if (!res.ok) throw new Error(`wmoov ${id}: HTTP ${res.status}`);
  const html = await res.text();

  // Rating: <dt>級別:</dt>\n<dd>IIB 級</dd>
  const ratingMatch = html.match(/級別[：:]\s*<\/dt>\s*<dd>\s*(I{1,3}|IIA|IIB|III|TBC)\s*級?\s*<\/dd>/i);
  const rating = ratingMatch ? ratingMatch[1].toUpperCase() : null;

  // Duration: JSON-LD "duration":"PT107M" or <dd>1小時47分</dd>
  let duration = 0;
  const jsonLd = html.match(/"duration"\s*:\s*"PT(\d+)M"/);
  if (jsonLd) {
    duration = parseInt(jsonLd[1]);
  } else {
    const durMatch = html.match(/片長[：:]\s*<\/dt>\s*<dd>\s*(?:(\d+)小時)?(\d+)分/);
    if (durMatch) {
      duration = (parseInt(durMatch[1] || '0') * 60) + parseInt(durMatch[2]);
    }
  }

  return { rating, duration };
}

// ============================================================
// OFNAA (電檢處) cross-reference (official rating + duration)
// ============================================================

const OFNAA_BASE = 'https://apps.ofnaa.gov.hk/search/film';

async function fetchOfnaaSession() {
  const res = await fetch(`${OFNAA_BASE}/onlineEnquiry?lang=zh_HK`, {
    headers: { 'User-Agent': 'Movie6-QA-Bot/1.0' },
  });
  if (!res.ok) throw new Error(`OFNAA session: HTTP ${res.status}`);
  const html = await res.text();

  // Extract CSRF token from hidden field
  const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!csrfMatch) throw new Error('OFNAA: CSRF token not found');

  // Extract cookies from Set-Cookie headers
  const cookies = [];
  for (const [key, val] of res.headers.entries()) {
    if (key === 'set-cookie') {
      const name = val.split(';')[0];
      cookies.push(name);
    }
  }

  return { csrf: csrfMatch[1], cookies: cookies.join('; ') };
}

async function searchOfnaa(session, title) {
  const body = new URLSearchParams({
    title,
    director: '',
    days: '',
    _csrf: session.csrf,
  });

  const res = await fetch(`${OFNAA_BASE}/onlineEnquiryResult`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': session.cookies,
      'Referer': `${OFNAA_BASE}/onlineEnquiry?lang=zh_HK`,
      'User-Agent': 'Movie6-QA-Bot/1.0',
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`OFNAA search: HTTP ${res.status}`);
  const html = await res.text();

  // Check for no results
  if (html.includes('alert-danger') || !html.includes('commonBody')) {
    return [];
  }

  // Parse results table rows (skip mobile duplicate rows)
  const results = [];
  const rowRe = /<tr>\s*<td class="main_column">\s*<p>([^<]*)<\/p>\s*<p>([^<]*)<\/p>\s*<\/td>\s*<td class="main_column mainResultCol">[\s\S]*?<br>\s*(\w+)級\s*<\/td>[\s\S]*?<td class="info_column">([\s\S]*?)<\/td>\s*<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const chTitle = m[1].trim();
    const enTitle = m[2].trim();
    const rating = m[3].trim(); // I, IIA, IIB, III

    // Extract duration from info column
    let duration = 0;
    const durMatch = m[4].match(/片長\s*:\s*(\d+)\s*分鐘/);
    if (durMatch) duration = parseInt(durMatch[1]);

    results.push({ chTitle, enTitle, rating, duration });
  }

  return results;
}

// Build a clean search term from movie name
function ofnaaSearchTerm(name) {
  return name
    .replace(/[《》「」\[\]()（）]/g, '')
    .replace(/\s*[-–—:：]\s*(劇場版|電影版|前篇|後篇|無限城篇|蕾潔篇).*$/, '')
    .replace(/\s*(明星好友場|好友場|見面場|謝票場|首映場|優先場|特別場)$/, '')
    .replace(/\s*\d{4}$/, '') // remove trailing year
    .trim();
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
// Report formatting
// ============================================================

function formatSlackMessage(report) {
  const { date, dayOfWeek, showingCount, comingCount, source,
          duplicates, screeningDupes, missing, wmoovSupplements, ofnaaSupplements } = report;

  const lines = [
    '\u{1f4ca} Movie6 \u6bcf\u65e5\u6578\u64da\u8cea\u7d20\u6aa2\u67e5',
    `\u{1f4c5} \u65e5\u671f\uff1a${date}\uff08${dayOfWeek}\uff09`,
    '',
    `\u{1f3ac} \u4e0a\u6620\u4e2d\u96fb\u5f71\uff1a${showingCount} \u90e8`,
    `\u{1f3ac} \u5373\u5c07\u4e0a\u6620\uff1a${comingCount} \u90e8`,
  ];

  if (source) {
    lines.push(`\u{2139}\ufe0f \u8cc7\u6599\u4f86\u6e90\uff1a${source}`);
  }

  const hasIssues =
    duplicates.length > 0 ||
    screeningDupes.length > 0 ||
    missing.poster.length > 0 ||
    missing.duration.length > 0 ||
    missing.rating.length > 0 ||
    missing.ratingSpecial.length > 0;

  if (hasIssues) {
    lines.push('', '\u26a0\ufe0f \u554f\u984c\u767c\u73fe\uff1a');

    // UUID duplicates
    if (duplicates.length > 0) {
      lines.push('', `\u{1f501} \u91cd\u8907\u96fb\u5f71\uff08${duplicates.length} \u90e8\uff09`);
      for (const m of duplicates) {
        lines.push(`\u2022 ${m.name} \u2014 \u51fa\u73fe\u5728\uff1a\u4e0a\u6620\u4e2d\u3001\u5373\u5c07\u4e0a\u6620`);
        lines.push(`  ${BASE_URL}/movie/${m.uuid}`);
      }
    }

    // Screening-variant duplicates
    if (screeningDupes.length > 0) {
      lines.push('', `\u{1f501} \u540c\u5834\u91cd\u8907\u96fb\u5f71\uff08${screeningDupes.length} \u7d44\uff09`);
      for (const group of screeningDupes) {
        lines.push(`\u2022 ${group.normalizedName}`);
        for (const m of group.movies) {
          const suffix = m.suffix ? ` (${m.suffix})` : ' (\u539f\u7247)';
          lines.push(`  ${suffix}\uff1a${BASE_URL}/movie/${m.uuid}`);
        }
      }
    }

    // Regular movie missing info — actionable
    const regularMissingUuids = new Set([
      ...missing.poster.map(m => m.uuid),
      ...missing.duration.map(m => m.uuid),
      ...missing.rating.map(m => m.uuid),
    ]);

    if (regularMissingUuids.size > 0) {
      lines.push('', `\u{1f4cb} \u4e00\u822c\u96fb\u5f71\u4fe1\u606f\u7f3a\u5931\uff08${regularMissingUuids.size} \u90e8\uff0c\u9700\u8981\u8655\u7406\uff09`);

      if (missing.poster.length > 0) {
        lines.push('\u7f3a\u5c11\u6d77\u5831\uff1a');
        for (const m of missing.poster) {
          lines.push(`\u2022 ${m.name}`);
          lines.push(`  ${BASE_URL}/movie/${m.uuid}`);
        }
      }

      if (missing.duration.length > 0) {
        lines.push('\u7f3a\u5c11\u7247\u9577\uff1a');
        for (const m of missing.duration) {
          lines.push(`\u2022 ${m.name}`);
          lines.push(`  ${BASE_URL}/movie/${m.uuid}`);
        }
      }

      if (missing.rating.length > 0) {
        lines.push('\u7f3a\u5c11\u5206\u7d1a (TBC)\uff1a');
        for (const m of missing.rating) {
          lines.push(`\u2022 ${m.name}`);
          lines.push(`  ${BASE_URL}/movie/${m.uuid}`);
        }
      }
    }

    // Supplemented data from external sources — show what was found so team can update Movie6
    const allSupplements = [
      ...(wmoovSupplements || []).map(s => ({ ...s, source: 'wmoov' })),
      ...(ofnaaSupplements || []).map(s => ({ ...s, source: 'OFNAA' })),
    ];
    if (allSupplements.length > 0) {
      lines.push('', `\u{1f4dd} \u5f9e\u5916\u90e8\u641c\u5230\u7684\u8cc7\u6599\uff08${allSupplements.length} \u90e8\uff0c\u8acb\u66f4\u65b0\u5230 Movie6\uff09`);
      for (const s of allSupplements) {
        const info = [];
        if (s.rating) info.push(`\u5206\u7d1a\uff1a${s.rating}`);
        if (s.duration) info.push(`\u7247\u9577\uff1a${s.duration} \u5206\u9418`);
        lines.push(`\u2022 ${s.name} \u2192 ${info.join('\u3001')} [${s.source}]`);
        lines.push(`  ${BASE_URL}/movie/${s.uuid}`);
      }
    }

    // Special screening missing rating — informational, grouped by type
    if (missing.ratingSpecial.length > 0) {
      const byType = new Map();
      for (const m of missing.ratingSpecial) {
        if (!byType.has(m.screeningType)) byType.set(m.screeningType, []);
        byType.get(m.screeningType).push(m);
      }
      lines.push('', `\u{1f3ad} \u7279\u5225\u5834\u6b21\u7f3a\u5c11\u5206\u7d1a\uff08${missing.ratingSpecial.length} \u90e8\uff0c\u4e00\u822c\u6bcb\u9808\u8655\u7406\uff09`);
      for (const [type, movies] of byType) {
        const names = movies.map(m => m.name).join('\u3001');
        lines.push(`  ${type} (${movies.length})\uff1a${names}`);
      }
    }
  }

  // Summary — only count showing movies for completeness, exclude special screening rating
  const issueUuids = new Set([
    ...duplicates.map(m => m.uuid),
    ...missing.poster.map(m => m.uuid),
    ...missing.duration.map(m => m.uuid),
    ...missing.rating.map(m => m.uuid),
  ]);
  const cleanCount = showingCount - issueUuids.size;

  if (!hasIssues) {
    lines.push('', '\u2705 \u6240\u6709\u4e0a\u6620\u4e2d\u96fb\u5f71\u6578\u64da\u5b8c\u6574');
  } else if (cleanCount > 0) {
    lines.push('', `\u2705 \u5176\u4ed6 ${cleanCount} \u90e8\u4e0a\u6620\u4e2d\u96fb\u5f71\u6578\u64da\u5b8c\u6574`);
  }

  return lines.join('\n');
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('Movie6 QA Check v6 starting...');
  const startTime = Date.now();

  // 1. Get anonymous JWT token
  console.log('Getting anonymous token...');
  let token;
  try {
    token = await getAnonymousToken();
    console.log('Token obtained (' + token.length + ' chars)');
  } catch (e) {
    console.error('Failed to get token:', e.message);
    process.exit(1);
  }

  // 2. Fetch ALL movies via gRPC
  console.log('Fetching movie lists via gRPC API...');
  const [showingResult, comingResult] = await Promise.all([
    fetchMovieList(token, 'ListShowing'),
    fetchMovieList(token, 'ListComing'),
  ]);

  const showingMovies = showingResult.movies;
  const comingMovies = comingResult.movies;

  console.log(`Showing: ${showingMovies.length} movies (total: ${showingResult.totalElements})`);
  console.log(`Coming:  ${comingMovies.length} movies (total: ${comingResult.totalElements})`);

  // 3. Find UUID duplicates (same UUID in both lists)
  const showingUuids = new Set(showingMovies.map(m => m.uuid));
  const duplicates = comingMovies.filter(m => showingUuids.has(m.uuid));
  console.log(`UUID duplicates: ${duplicates.length}`);

  // 4. Find screening-variant duplicates (different UUID, same normalized name)
  const allForDupeCheck = [...showingMovies, ...comingMovies.filter(m => !showingUuids.has(m.uuid))];
  const nameGroups = new Map();
  for (const m of allForDupeCheck) {
    const normalized = normalizeMovieName(m.name);
    const originalClean = m.name.replace(/[《》]/g, '').trim();
    const suffix = originalClean !== normalized
      ? originalClean.slice(normalized.length).trim()
      : '';
    if (!nameGroups.has(normalized)) nameGroups.set(normalized, []);
    nameGroups.get(normalized).push({ uuid: m.uuid, name: m.name, suffix });
  }
  const screeningDupes = [];
  for (const [normalizedName, movies] of nameGroups) {
    if (movies.length > 1) {
      const uuids = new Set(movies.map(m => m.uuid));
      if (uuids.size > 1) {
        screeningDupes.push({ normalizedName, movies });
      }
    }
  }
  console.log(`Screening-variant duplicates: ${screeningDupes.length} groups`);

  // 5. Check poster from gRPC list data (showing only)
  const missing = { poster: [], duration: [], rating: [], ratingSpecial: [] };

  for (const movie of showingMovies) {
    if (!movie.poster || movie.poster.includes('moviePosterPH') || movie.poster.length < 10) {
      missing.poster.push(movie);
    }
  }
  console.log(`Missing poster (showing): ${missing.poster.length}`);

  // 6. Fetch gRPC Detail for rating + duration supplement (showing only)
  console.log(`Fetching ${showingMovies.length} movie details via gRPC Detail...`);
  const detailResults = await batchFetch(showingMovies, async (movie) => {
    const reqMsg = encodeStringField(1, movie.uuid);
    const frame = encodeGrpcFrame(reqMsg);
    const raw = await grpcCall('mvpb.MovieX/Detail', frame, token);
    const msg = decodeGrpcFrame(raw);
    return decodeMovieDetail(msg);
  });

  let detailOk = 0;
  let detailFail = 0;
  let durationFilled = 0;
  for (let i = 0; i < detailResults.length; i++) {
    const r = detailResults[i];
    if (r.status === 'rejected') {
      detailFail++;
      console.warn(`  Detail failed for ${showingMovies[i].name}: ${r.reason?.message || r.reason}`);
      continue;
    }
    detailOk++;
    const movie = showingMovies[i];
    // Supplement duration from Detail if list returned 0
    if ((!movie.duration || movie.duration === 0) && r.value.duration > 0) {
      movie.duration = r.value.duration;
      durationFilled++;
    }
    // Store rating
    movie.rating = r.value.rating;
  }
  console.log(`Detail: ${detailOk} ok, ${detailFail} failed, duration filled: ${durationFilled}`);

  // 7. Cross-reference with wmoov.com for movies still missing rating/duration
  const needsWmoov = showingMovies.filter(m =>
    (!m.rating || m.rating === 'TBC') || (!m.duration || m.duration === 0)
  );
  let wmoovFilled = { rating: 0, duration: 0 };
  const wmoovSupplements = []; // track what wmoov found for the report
  if (needsWmoov.length > 0) {
    console.log(`Cross-referencing ${needsWmoov.length} movies with wmoov.com...`);
    try {
      const wmoovIndex = await fetchWmoovIndex();
      console.log(`  wmoov index: ${wmoovIndex.size} movies`);

      const toFetch = [];
      for (const movie of needsWmoov) {
        // Try matching by normalized name
        const key = normalizeForMatch(movie.name);
        let entry = wmoovIndex.get(key);
        if (!entry) {
          // Try without common suffixes
          const stripped = movie.name
            .replace(/\s*[\(（][^)）]*[\)）]\s*/g, '')
            .replace(/\s*-\s*劇場版.*$/, '')
            .trim();
          entry = wmoovIndex.get(normalizeForMatch(stripped));
        }
        if (entry) {
          toFetch.push({ movie, wmoovId: entry.id, wmoovName: entry.name });
        }
      }
      console.log(`  Matched ${toFetch.length}/${needsWmoov.length} movies`);

      if (toFetch.length > 0) {
        const wmoovResults = await batchFetch(toFetch, async ({ wmoovId }) => {
          return fetchWmoovDetail(wmoovId);
        }, 4); // lower concurrency for external site

        for (let i = 0; i < wmoovResults.length; i++) {
          const r = wmoovResults[i];
          if (r.status === 'rejected') continue;
          const { movie } = toFetch[i];
          const { rating, duration } = r.value;
          const sup = { uuid: movie.uuid, name: movie.name };
          if ((!movie.rating || movie.rating === 'TBC') && rating && rating !== 'TBC') {
            movie.rating = rating;
            movie.ratingSource = 'wmoov';
            sup.rating = rating;
            wmoovFilled.rating++;
          }
          if ((!movie.duration || movie.duration === 0) && duration > 0) {
            movie.duration = duration;
            movie.durationSource = 'wmoov';
            sup.duration = duration;
            wmoovFilled.duration++;
          }
          if (sup.rating || sup.duration) wmoovSupplements.push(sup);
        }
      }
    } catch (e) {
      console.warn(`  wmoov cross-reference failed: ${e.message}`);
    }
    console.log(`  wmoov filled: rating=${wmoovFilled.rating}, duration=${wmoovFilled.duration}`);
  }

  // 8. Cross-reference with OFNAA (電檢處) for movies still missing rating/duration
  const needsOfnaa = showingMovies.filter(m =>
    (!m.rating || m.rating === 'TBC') || (!m.duration || m.duration === 0)
  );
  const ofnaaSupplements = [];
  if (needsOfnaa.length > 0) {
    console.log(`Cross-referencing ${needsOfnaa.length} movies with OFNAA...`);
    try {
      const session = await fetchOfnaaSession();
      console.log(`  OFNAA session obtained`);

      let ofnaaFilled = { rating: 0, duration: 0 };
      for (const movie of needsOfnaa) {
        const term = ofnaaSearchTerm(movie.name);
        if (!term || term.length < 2) continue;

        try {
          const results = await searchOfnaa(session, term);
          if (results.length === 0) continue;

          // Find best match: prefer exact normalized match, else first result
          const normTerm = normalizeForMatch(term);
          let best = results.find(r => normalizeForMatch(r.chTitle) === normTerm);
          if (!best) {
            // Try partial: OFNAA title contains our search or vice versa
            best = results.find(r => {
              const normR = normalizeForMatch(r.chTitle);
              return normR.includes(normTerm) || normTerm.includes(normR);
            });
          }
          if (!best) continue;

          const sup = { uuid: movie.uuid, name: movie.name };
          if ((!movie.rating || movie.rating === 'TBC') && best.rating) {
            movie.rating = best.rating;
            movie.ratingSource = 'ofnaa';
            sup.rating = best.rating;
            ofnaaFilled.rating++;
          }
          if ((!movie.duration || movie.duration === 0) && best.duration > 0) {
            movie.duration = best.duration;
            movie.durationSource = 'ofnaa';
            sup.duration = best.duration;
            ofnaaFilled.duration++;
          }
          if (sup.rating || sup.duration) ofnaaSupplements.push(sup);

          // Small delay between searches to be polite
          await new Promise(r => setTimeout(r, 200));
        } catch (e) {
          // Individual search failure, continue with next
          continue;
        }
      }
      console.log(`  OFNAA filled: rating=${ofnaaFilled.rating}, duration=${ofnaaFilled.duration}`);
    } catch (e) {
      console.warn(`  OFNAA cross-reference failed: ${e.message}`);
    }
  }

  // 9. Check duration + rating (after all supplements)
  for (const movie of showingMovies) {
    if (!movie.duration || movie.duration === 0) {
      missing.duration.push(movie);
    }
    if (!movie.rating || movie.rating === 'TBC') {
      const screeningType = classifyMovie(movie.name);
      if (screeningType) {
        missing.ratingSpecial.push({ ...movie, screeningType });
      } else {
        missing.rating.push(movie);
      }
    }
  }
  console.log(`Missing duration (showing): ${missing.duration.length}`);
  console.log(`Missing rating — regular: ${missing.rating.length}, special: ${missing.ratingSpecial.length}`);

  // 10. Build report
  const now = new Date();
  const hkFormatter = new Intl.DateTimeFormat('zh-HK', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
  });
  const parts = hkFormatter.formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value || '';

  const report = {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    dayOfWeek: get('weekday'),
    showingCount: showingMovies.length,
    comingCount: comingMovies.length,
    source: 'gRPC API + Detail + wmoov + OFNAA',
    duplicates,
    screeningDupes,
    missing,
    wmoovSupplements,
    ofnaaSupplements,
  };

  const message = formatSlackMessage(report);
  console.log('\n--- Slack Message ---');
  console.log(message);
  console.log('--- End ---\n');

  // 11. Post to Slack
  let slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    try {
      const fs = await import('node:fs');
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
