/**
 * Health monitoring for Clapper bot.
 *
 * Uses CF Worker scheduled handler (cron) to check if the gateway
 * is alive every 5 minutes. Alerts to Slack after consecutive failures.
 */

import { getSandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from './types';
import { findExistingMoltbotProcess } from './gateway';

/** Slack channel for health alerts */
const SLACK_CHANNEL = '#automation-testing';

/** Consecutive failures before alerting */
const ALERT_THRESHOLD = 2;

/** R2 key for persisting health state */
const HEALTH_STATE_KEY = 'health-state.json';

export interface HealthState {
  consecutiveFailures: number;
  lastCheck: string; // ISO timestamp
  lastStatus: 'ok' | 'fail';
  alertSent: boolean; // whether we've already sent a down alert
}

const DEFAULT_STATE: HealthState = {
  consecutiveFailures: 0,
  lastCheck: new Date().toISOString(),
  lastStatus: 'ok',
  alertSent: false,
};

/**
 * Read health state from R2.
 */
export async function getHealthState(bucket: R2Bucket): Promise<HealthState> {
  try {
    const obj = await bucket.get(HEALTH_STATE_KEY);
    if (!obj) return { ...DEFAULT_STATE };
    const text = await obj.text();
    return JSON.parse(text) as HealthState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * Write health state to R2.
 */
export async function setHealthState(bucket: R2Bucket, state: HealthState): Promise<void> {
  await bucket.put(HEALTH_STATE_KEY, JSON.stringify(state, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/**
 * Check if the gateway process is alive and responding.
 */
export async function checkHealth(
  env: MoltbotEnv,
): Promise<{ ok: boolean; status: string; error?: string }> {
  try {
    const sandbox = getSandbox(env.Sandbox, 'moltbot', { keepAlive: true });
    const process = await findExistingMoltbotProcess(sandbox);

    if (!process) {
      return { ok: false, status: 'not_running', error: 'No gateway process found' };
    }

    // Check if the process is responding on the gateway port
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 10_000 });
      return { ok: true, status: 'running' };
    } catch {
      return { ok: false, status: 'not_responding', error: 'Gateway port not reachable' };
    }
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Post a message to Slack via chat.postMessage API.
 */
export async function sendSlackAlert(token: string, message: string): Promise<void> {
  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL,
      text: message,
    }),
  });

  if (!resp.ok) {
    console.error('[Health] Slack API error:', resp.status, await resp.text());
  } else {
    const data = (await resp.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      console.error('[Health] Slack API returned error:', data.error);
    }
  }
}

/**
 * Main health check handler, called by CF Worker cron trigger.
 */
export async function handleScheduled(env: MoltbotEnv): Promise<void> {
  console.log('[Health] Running scheduled health check');

  const bucket = env.MOLTBOT_BUCKET;
  const state = await getHealthState(bucket);
  const result = await checkHealth(env);
  const now = new Date().toISOString();

  if (result.ok) {
    // Gateway is healthy
    if (state.alertSent) {
      // Was previously down, send recovery notification
      const msg = `\u2705 Clapper \u5df2\u6062\u5fa9\u904b\u884c\uff01\u4e4b\u524d\u9023\u7e8c fail ${state.consecutiveFailures} \u6b21\u5f8c\u81ea\u884c\u6062\u5fa9\u3002`;
      console.log('[Health] Sending recovery alert:', msg);
      if (env.SLACK_BOT_TOKEN) {
        await sendSlackAlert(env.SLACK_BOT_TOKEN, msg);
      }
    }

    await setHealthState(bucket, {
      consecutiveFailures: 0,
      lastCheck: now,
      lastStatus: 'ok',
      alertSent: false,
    });
    console.log('[Health] Gateway is healthy');
  } else {
    // Gateway is down
    const failures = state.consecutiveFailures + 1;
    const shouldAlert = failures >= ALERT_THRESHOLD && !state.alertSent;

    if (shouldAlert && env.SLACK_BOT_TOKEN) {
      const msg = `\u26a0\ufe0f Clapper \u7121\u56de\u61c9\uff01\u5df2\u9023\u7e8c fail ${failures} \u6b21\u3002\u72c0\u614b\uff1a${result.status}\u3002\u932f\u8aa4\uff1a${result.error || 'N/A'}`;
      console.log('[Health] Sending alert:', msg);
      await sendSlackAlert(env.SLACK_BOT_TOKEN, msg);
    }

    await setHealthState(bucket, {
      consecutiveFailures: failures,
      lastCheck: now,
      lastStatus: 'fail',
      alertSent: state.alertSent || shouldAlert,
    });
    console.log(`[Health] Gateway is DOWN. Consecutive failures: ${failures}`);
  }
}
