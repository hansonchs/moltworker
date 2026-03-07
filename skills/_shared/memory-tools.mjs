#!/usr/bin/env node
// Memory tools for OpenClaw bot.
// CLI tool for searching, querying, and archiving the bot's memory file.
//
// Usage:
//   node memory-tools.mjs search <query>    — keyword search (中英文)
//   node memory-tools.mjs stats             — entry count, date range, file size
//   node memory-tools.mjs recent [n]        — last N date entries (default 5)
//   node memory-tools.mjs archive <date>    — move entries before <date> to archive
//
// Zero external dependencies.

import fs from 'node:fs';
import path from 'node:path';

const MEMORY_FILE = '/root/clawd/memory.md';
const ARCHIVE_DIR = '/root/clawd/memory-archive';

// ============================================================
// Parse memory.md into structured entries
// ============================================================

function parseMemory(content) {
  const entries = [];
  let currentDate = null;
  let currentItems = [];

  for (const line of content.split('\n')) {
    const dateMatch = line.match(/^## (\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      if (currentDate) {
        entries.push({ date: currentDate, items: currentItems });
      }
      currentDate = dateMatch[1];
      currentItems = [];
    } else if (currentDate && line.match(/^- .+/)) {
      currentItems.push(line.replace(/^- /, '').trim());
    }
  }

  if (currentDate) {
    entries.push({ date: currentDate, items: currentItems });
  }

  return entries;
}

function readMemory() {
  try {
    return fs.readFileSync(MEMORY_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(`Memory file not found: ${MEMORY_FILE}`);
      process.exit(1);
    }
    throw e;
  }
}

// ============================================================
// Commands
// ============================================================

function search(query) {
  const content = readMemory();
  const entries = parseMemory(content);

  if (entries.length === 0) {
    console.log('Memory file is empty.');
    return;
  }

  // Split query into terms (supports mixed Chinese/English)
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

  const results = [];

  for (const entry of entries) {
    for (const item of entry.items) {
      const itemLower = item.toLowerCase();
      const hits = terms.filter(t => itemLower.includes(t)).length;
      if (hits > 0) {
        results.push({ date: entry.date, item, hits });
      }
    }
  }

  if (results.length === 0) {
    console.log(`No results found for: ${query}`);
    return;
  }

  // Sort by hits (desc) then date (desc)
  results.sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    return b.date.localeCompare(a.date);
  });

  console.log(`Found ${results.length} result(s) for "${query}":\n`);
  for (const r of results) {
    console.log(`[${r.date}] ${r.item}`);
  }
}

function stats() {
  const content = readMemory();
  const entries = parseMemory(content);
  const totalItems = entries.reduce((sum, e) => sum + e.items.length, 0);
  const lineCount = content.split('\n').length;

  let fileSizeStr;
  try {
    const stat = fs.statSync(MEMORY_FILE);
    fileSizeStr = stat.size < 1024
      ? `${stat.size} bytes`
      : `${(stat.size / 1024).toFixed(1)} KB`;
  } catch (_) {
    fileSizeStr = 'unknown';
  }

  console.log('Memory Stats:');
  console.log(`  File: ${MEMORY_FILE}`);
  console.log(`  Size: ${fileSizeStr}`);
  console.log(`  Lines: ${lineCount}`);
  console.log(`  Date entries: ${entries.length}`);
  console.log(`  Total items: ${totalItems}`);

  if (entries.length > 0) {
    // entries are in file order (newest first)
    const dates = entries.map(e => e.date).sort();
    console.log(`  Date range: ${dates[0]} → ${dates[dates.length - 1]}`);
  }
}

function recent(n) {
  const content = readMemory();
  const entries = parseMemory(content);

  if (entries.length === 0) {
    console.log('Memory file is empty.');
    return;
  }

  // Entries are in file order (newest first), take first n
  const shown = entries.slice(0, n);

  console.log(`Last ${shown.length} date entries:\n`);
  for (const entry of shown) {
    console.log(`## ${entry.date}`);
    for (const item of entry.items) {
      console.log(`- ${item}`);
    }
    console.log('');
  }
}

function archive(beforeDate) {
  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
    console.error('Date must be in YYYY-MM-DD format');
    process.exit(1);
  }

  const content = readMemory();
  const entries = parseMemory(content);

  const keep = [];
  const toArchive = [];

  for (const entry of entries) {
    if (entry.date < beforeDate) {
      toArchive.push(entry);
    } else {
      keep.push(entry);
    }
  }

  if (toArchive.length === 0) {
    console.log(`No entries found before ${beforeDate}. Nothing to archive.`);
    return;
  }

  // Write archive file
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archiveFile = path.join(ARCHIVE_DIR, `memory-before-${beforeDate}.md`);

  const archiveLines = [];
  // Sort archive entries by date (oldest first for readability)
  toArchive.sort((a, b) => a.date.localeCompare(b.date));
  for (const entry of toArchive) {
    archiveLines.push(`## ${entry.date}`);
    for (const item of entry.items) {
      archiveLines.push(`- ${item}`);
    }
    archiveLines.push('');
  }
  fs.writeFileSync(archiveFile, archiveLines.join('\n'));
  console.log(`Archived ${toArchive.length} date entries (${toArchive.reduce((s, e) => s + e.items.length, 0)} items) to ${archiveFile}`);

  // Rewrite main memory file with kept entries
  const keepLines = [];
  for (const entry of keep) {
    keepLines.push(`## ${entry.date}`);
    for (const item of entry.items) {
      keepLines.push(`- ${item}`);
    }
    keepLines.push('');
  }
  fs.writeFileSync(MEMORY_FILE, keepLines.join('\n'));
  console.log(`Main memory file rewritten with ${keep.length} date entries`);
}

// ============================================================
// CLI
// ============================================================

const command = process.argv[2];

switch (command) {
  case 'search': {
    const query = process.argv.slice(3).join(' ');
    if (!query) {
      console.error('Usage: node memory-tools.mjs search <query>');
      process.exit(1);
    }
    search(query);
    break;
  }
  case 'stats':
    stats();
    break;
  case 'recent': {
    const n = parseInt(process.argv[3] || '5', 10);
    recent(n);
    break;
  }
  case 'archive': {
    const date = process.argv[3];
    if (!date) {
      console.error('Usage: node memory-tools.mjs archive <YYYY-MM-DD>');
      process.exit(1);
    }
    archive(date);
    break;
  }
  default:
    console.log('Memory Tools — manage bot memory file\n');
    console.log('Commands:');
    console.log('  search <query>    Search memory entries (supports Chinese/English)');
    console.log('  stats             Show memory file statistics');
    console.log('  recent [n]        Show last N date entries (default 5)');
    console.log('  archive <date>    Archive entries before YYYY-MM-DD');
    process.exit(command ? 1 : 0);
}
