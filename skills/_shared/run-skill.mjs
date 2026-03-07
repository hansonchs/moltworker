#!/usr/bin/env node
// Skill execution wrapper with failure alerting.
// Runs a target script via child_process.spawn, captures output,
// and posts a Slack alert to #automation-testing if exit code !== 0.
//
// Usage: node run-skill.mjs "Skill Name" /path/to/script.mjs [args...]
//
// Zero external dependencies.

import { spawn } from 'node:child_process';
import { getSlackToken, findSlackChannel, postToSlack } from './slack-helpers.mjs';

const SLACK_CHANNEL_NAME = 'automation-testing';

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node run-skill.mjs "Skill Name" /path/to/script.mjs [args...]');
    process.exit(1);
  }

  const skillName = args[0];
  const scriptPath = args[1];
  const scriptArgs = args.slice(2);
  const startTime = Date.now();

  const stderrLines = [];

  const child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
  });

  // Passthrough stdout to console and capture
  child.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  // Passthrough stderr to console and capture last lines
  child.stderr.on('data', (data) => {
    process.stderr.write(data);
    const lines = data.toString().split('\n').filter(l => l.trim());
    stderrLines.push(...lines);
    // Keep only last 20 lines in memory
    if (stderrLines.length > 20) {
      stderrLines.splice(0, stderrLines.length - 20);
    }
  });

  child.on('close', async (code) => {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    if (code === 0) {
      console.log(`[run-skill] ${skillName} completed successfully in ${duration}s`);
      process.exit(0);
    }

    console.error(`[run-skill] ${skillName} failed with exit code ${code} after ${duration}s`);

    // Build failure alert
    const lastStderr = stderrLines.slice(-5).join('\n');
    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
    const lines = [
      `🚨 *Skill Execution Failed*`,
      ``,
      `*Skill:* ${skillName}`,
      `*Exit Code:* ${code}`,
      `*Duration:* ${duration}s`,
      `*Time:* ${timestamp} UTC`,
    ];

    if (lastStderr) {
      lines.push('', '*Last stderr output:*', '```', lastStderr, '```');
    }

    const message = lines.join('\n');

    // Post to Slack
    const slackToken = getSlackToken();
    if (!slackToken) {
      console.error('[run-skill] SLACK_BOT_TOKEN not available, cannot send failure alert');
      process.exit(code);
    }

    try {
      const channelId = await findSlackChannel(slackToken, SLACK_CHANNEL_NAME);
      await postToSlack(slackToken, channelId, message);
      console.log(`[run-skill] Failure alert posted to #${SLACK_CHANNEL_NAME}`);
    } catch (e) {
      console.error(`[run-skill] Failed to post Slack alert: ${e.message}`);
    }

    process.exit(code);
  });

  child.on('error', async (err) => {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[run-skill] Failed to start ${skillName}: ${err.message}`);

    const message = [
      `🚨 *Skill Execution Failed*`,
      ``,
      `*Skill:* ${skillName}`,
      `*Error:* ${err.message}`,
      `*Duration:* ${duration}s`,
      `*Time:* ${new Date().toISOString().replace('T', ' ').split('.')[0]} UTC`,
    ].join('\n');

    const slackToken = getSlackToken();
    if (slackToken) {
      try {
        const channelId = await findSlackChannel(slackToken, SLACK_CHANNEL_NAME);
        await postToSlack(slackToken, channelId, message);
      } catch (_) { /* best effort */ }
    }

    process.exit(1);
  });
}

main();
