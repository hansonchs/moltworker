import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';
import { ensureRcloneConfig } from './r2';

/**
 * Find an existing OpenClaw gateway process
 *
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      // Match gateway process (openclaw gateway or legacy clawdbot gateway)
      // Don't match CLI commands like "openclaw devices list"
      const isGatewayProcess =
        proc.command.includes('start-openclaw.sh') ||
        proc.command.includes('openclaw gateway') ||
        // Legacy: match old startup script during transition
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('clawdbot gateway');
      const isCliCommand =
        proc.command.includes('openclaw devices') ||
        proc.command.includes('openclaw --version') ||
        proc.command.includes('openclaw onboard') ||
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version');

      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Ensure the OpenClaw gateway is running
 *
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  // Configure rclone for R2 persistence (non-blocking if not configured).
  // The startup script uses rclone to restore data from R2 on boot.
  await ensureRcloneConfig(sandbox, env);

  // Check if gateway is already running or starting
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log(
      'Found existing gateway process:',
      existingProcess.id,
      'status:',
      existingProcess.status,
    );

    // Always use full startup timeout - a process can be "running" but not ready yet
    // (e.g., just started by another concurrent request). Using a shorter timeout
    // causes race conditions where we kill processes that are still initializing.
    try {
      console.log('Waiting for gateway on port', MOLTBOT_PORT, 'timeout:', STARTUP_TIMEOUT_MS);
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      console.log('Gateway is reachable');
      return existingProcess;
      // eslint-disable-next-line no-unused-vars
    } catch (_e) {
      // Timeout waiting for port - process is likely dead or stuck, kill and restart
      console.log('Existing process not reachable after full timeout, killing and restarting...');
      try {
        await existingProcess.kill();
      } catch (killError) {
        console.log('Failed to kill process:', killError);
      }
    }
  }

  // Start a new OpenClaw gateway
  console.log('Starting new OpenClaw gateway...');
  const envVars = buildEnvVars(env);
  const command = '/usr/local/bin/start-openclaw.sh';

  console.log('Starting process with command:', command);
  console.log('Environment vars being passed:', Object.keys(envVars));

  let process: Process;
  try {
    process = await sandbox.startProcess(command, {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    console.log('Process started with id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('Failed to start process:', startErr);
    throw startErr;
  }

  // Wait for the gateway to be ready
  try {
    console.log('[Gateway] Waiting for OpenClaw gateway to be ready on port', MOLTBOT_PORT);
    await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('[Gateway] OpenClaw gateway is ready!');

    const logs = await process.getLogs();
    if (logs.stdout) console.log('[Gateway] stdout:', logs.stdout);
    if (logs.stderr) console.log('[Gateway] stderr:', logs.stderr);
  } catch (e) {
    console.error('[Gateway] waitForPort failed:', e);
    try {
      const logs = await process.getLogs();
      console.error('[Gateway] startup failed. Stderr:', logs.stderr);
      console.error('[Gateway] startup failed. Stdout:', logs.stdout);
      throw new Error(`OpenClaw gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`, {
        cause: e,
      });
    } catch (logErr) {
      console.error('[Gateway] Failed to get logs:', logErr);
      throw e;
    }
  }

  // Verify gateway is actually responding
  console.log('[Gateway] Verifying gateway health...');

  // Patch crontab — the baked-in startup script may have outdated cron entries.
  // This ensures the correct skill schedules are always installed after gateway start.
  try {
    await patchCrontab(sandbox);
  } catch (cronErr) {
    console.error('[Gateway] Failed to patch crontab:', cronErr);
  }

  return process;
}

/**
 * Install the correct crontab inside the container.
 * This overrides whatever the startup script installed.
 */
export async function patchCrontab(sandbox: Sandbox): Promise<void> {
  const NODE = '/usr/local/bin/node';
  const WRAPPER = '/root/clawd/skills/_shared/run-skill.mjs';
  const SK = '/root/clawd/skills';
  const R = '--s3-no-check-bucket --config /root/.config/rclone/rclone.conf';
  const B = 'moltbot-data';

  const jobs = [
    `30 2 * * 1-5 ${NODE} ${WRAPPER} Distributor_Email ${SK}/movie-distributor-email/scripts/check.mjs >> /tmp/distributor-email.log 2>&1; rclone copyto /tmp/distributor-email.log r2:${B}/logs/distributor-email.log ${R} 2>/dev/null`,
    `35 2 * * 1-5 ${NODE} ${WRAPPER} Movie_QA_Check ${SK}/movie-qa-check/scripts/check.mjs >> /tmp/movie-qa.log 2>&1; rclone copyto /tmp/movie-qa.log r2:${B}/logs/movie-qa.log ${R} 2>/dev/null`,
    `0 4 * * 1-5 ${NODE} ${WRAPPER} App_Store_Monitor ${SK}/app-store-monitor/scripts/check.mjs >> /tmp/app-store.log 2>&1; rclone copyto /tmp/app-store.log r2:${B}/logs/app-store.log ${R} 2>/dev/null`,
    `0 6 * * 1-5 ${NODE} ${WRAPPER} SEO_Daily ${SK}/seo-monitor/scripts/seo-report.mjs daily >> /tmp/seo-monitor.log 2>&1; rclone copyto /tmp/seo-monitor.log r2:${B}/logs/seo-monitor.log ${R} 2>/dev/null`,
    `0 7 * * 1 ${NODE} ${WRAPPER} SEO_Weekly ${SK}/seo-monitor/scripts/seo-report.mjs weekly >> /tmp/seo-monitor.log 2>&1; rclone copyto /tmp/seo-monitor.log r2:${B}/logs/seo-monitor.log ${R} 2>/dev/null`,
  ];

  const crontab = jobs.join('\n') + '\n';
  // Write crontab file and install it
  const cmd = `bash -c 'cat > /tmp/patched-crontab << "CRONEOF"\n${crontab}CRONEOF\ncrontab /tmp/patched-crontab && echo "Crontab patched successfully"'`;

  console.log('[Gateway] Patching crontab with', jobs.length, 'jobs...');
  const proc = await sandbox.startProcess(cmd);

  // Wait briefly for the crontab command to complete
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const logs = await proc.getLogs();
  if (logs.stdout) console.log('[Gateway] Crontab patch:', logs.stdout);
  if (logs.stderr) console.error('[Gateway] Crontab patch stderr:', logs.stderr);
}
