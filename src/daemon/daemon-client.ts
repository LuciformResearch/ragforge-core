/**
 * Brain Daemon Client
 *
 * HTTP client for communicating with the Brain Daemon.
 * Used by external tools (LucieCode, Studio, etc.) to call tools via the daemon.
 *
 * @since 2025-12-20
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getLocalTimestamp } from '../runtime/utils/timestamp.js';

const DAEMON_PORT = 6969;
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const STARTUP_TIMEOUT_MS = 90000; // 90 seconds to start daemon
const STARTUP_CHECK_INTERVAL_MS = 500;
const LOG_DIR = path.join(os.homedir(), '.ragforge', 'logs');
const CLIENT_LOG_FILE = path.join(LOG_DIR, 'daemon-client.log');
const DAEMON_STARTUP_LOCK_FILE = path.join(os.homedir(), '.ragforge', 'daemon-startup.lock');

/**
 * Log to file for debugging
 */
async function logToFile(level: string, message: string, meta?: any): Promise<void> {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const timestamp = getLocalTimestamp();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`;
    await fs.appendFile(CLIENT_LOG_FILE, line);
  } catch {
    // Ignore logging errors
  }
}

/**
 * Check if the daemon is running AND ready (brain initialized)
 */
export async function isDaemonRunning(): Promise<boolean> {
  const url = `${DAEMON_URL}/health`;
  await logToFile('debug', `Checking daemon health at ${url}`);

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      await logToFile('debug', `Daemon is ready`, { status: response.status });
      return true;
    }

    await logToFile('debug', `Daemon responding but not ready`, { status: response.status });
    return false;
  } catch (error: any) {
    await logToFile('debug', `Daemon health check failed`, { error: error.message, code: error.code });
    return false;
  }
}

/**
 * Check if the daemon is started (responding to requests, even if not fully ready)
 */
export async function isDaemonStarted(): Promise<boolean> {
  const url = `${DAEMON_URL}/health`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    await logToFile('debug', `Daemon is started`, { status: response.status });
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire startup lock to prevent multiple parallel daemon starts
 */
async function acquireStartupLock(): Promise<boolean> {
  try {
    try {
      const stats = await fs.stat(DAEMON_STARTUP_LOCK_FILE);
      const age = Date.now() - stats.mtimeMs;
      if (age < 30000) {
        return false;
      }
      await fs.unlink(DAEMON_STARTUP_LOCK_FILE);
    } catch {
      // Lock file doesn't exist
    }
    await fs.writeFile(DAEMON_STARTUP_LOCK_FILE, `${process.pid}\n`, 'utf-8');
    return true;
  } catch (err: any) {
    await logToFile('error', `Failed to acquire startup lock: ${err.message}`);
    return false;
  }
}

/**
 * Release startup lock
 */
async function releaseStartupLock(): Promise<void> {
  try {
    await fs.unlink(DAEMON_STARTUP_LOCK_FILE);
  } catch {
    // Ignore errors
  }
}

/**
 * Check if port is already in use
 */
async function isPortInUse(port: number): Promise<boolean> {
  try {
    const { createServer } = await import('net');
    return new Promise((resolve) => {
      const server = createServer();
      server.once('error', (err: any) => {
        resolve(err.code === 'EADDRINUSE');
      });
      server.once('listening', () => {
        server.close();
        resolve(false);
      });
      server.listen(port);
    });
  } catch {
    return false;
  }
}

/**
 * Start the daemon in background if not running
 */
export async function ensureDaemonRunning(verbose: boolean = false): Promise<boolean> {
  await logToFile('info', 'ensureDaemonRunning called', { verbose });

  // First check if daemon is already ready
  if (await isDaemonRunning()) {
    await logToFile('info', 'Daemon already ready');
    if (verbose) console.log('✓ Daemon already running');
    return true;
  }

  // Check if daemon is started but not ready yet
  if (await isDaemonStarted()) {
    await logToFile('info', 'Daemon started but not ready, waiting...');
    if (verbose) console.log('⏳ Daemon starting, waiting for initialization...');

    const startTime = Date.now();
    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, STARTUP_CHECK_INTERVAL_MS));
      if (await isDaemonRunning()) {
        if (verbose) console.log('✓ Daemon ready');
        return true;
      }
    }
    await logToFile('error', 'Timeout waiting for daemon to become ready');
    return false;
  }

  // Check if port is in use
  if (await isPortInUse(DAEMON_PORT)) {
    await logToFile('info', 'Port in use, waiting for daemon...');
    const startTime = Date.now();
    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, STARTUP_CHECK_INTERVAL_MS));
      if (await isDaemonRunning()) return true;
    }
    await logToFile('error', 'Timeout waiting for daemon on port');
    return false;
  }

  // Try to acquire startup lock
  const lockAcquired = await acquireStartupLock();
  if (!lockAcquired) {
    await logToFile('info', 'Another process is starting the daemon, waiting...');
    const startTime = Date.now();
    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, STARTUP_CHECK_INTERVAL_MS));
      if (await isDaemonRunning()) return true;
    }
    return false;
  }

  try {
    await logToFile('info', 'Daemon not running, starting...');
    if (verbose) console.log('⏳ Starting daemon...');

    // Use npx ragforge daemon start
    const child = spawn('npx', ['ragforge', 'daemon', 'start'], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env: {
        ...process.env,
        RAGFORGE_DAEMON_VERBOSE: verbose ? '1' : '',
      },
      shell: true,
    });
    child.unref();

    await logToFile('info', `Daemon process spawned with PID: ${child.pid}`);

    // Wait for daemon to be ready
    const startTime = Date.now();
    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, STARTUP_CHECK_INTERVAL_MS));
      if (await isDaemonRunning()) {
        if (verbose) console.log('✓ Daemon started');
        return true;
      }
    }

    await logToFile('error', 'Failed to start daemon within timeout');
    console.error('❌ Failed to start daemon within timeout');
    return false;
  } finally {
    await releaseStartupLock();
  }
}

/**
 * Tool call result from daemon
 */
export interface DaemonToolResult {
  success: boolean;
  result?: any;
  error?: string;
  duration_ms?: number;
}

/**
 * Call a tool via the daemon
 */
export async function callToolViaDaemon(
  toolName: string,
  params: Record<string, any>,
  options: { verbose?: boolean; ensureRunning?: boolean } = {}
): Promise<DaemonToolResult> {
  const { verbose = false, ensureRunning = true } = options;

  await logToFile('info', `callToolViaDaemon: ${toolName}`, { params: Object.keys(params) });

  // Ensure daemon is running (unless caller already did)
  if (ensureRunning) {
    const daemonReady = await ensureDaemonRunning(verbose);
    if (!daemonReady) {
      return { success: false, error: 'Failed to start daemon' };
    }
  }

  try {
    if (verbose) console.log(`⏳ Calling ${toolName}...`);

    const url = `${DAEMON_URL}/tool/${toolName}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = await response.json() as DaemonToolResult;

    await logToFile('info', `Tool ${toolName} response`, {
      status: response.status,
      success: data.success,
      duration_ms: data.duration_ms,
    });

    if (!response.ok) {
      return { success: false, error: data.error || `HTTP ${response.status}` };
    }

    return data;
  } catch (error: any) {
    await logToFile('error', `Tool ${toolName} failed`, { error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Get daemon status
 */
export async function getDaemonStatus(): Promise<any | null> {
  try {
    const response = await fetch(`${DAEMON_URL}/status`);
    if (response.ok) return await response.json();
    return null;
  } catch {
    return null;
  }
}

/**
 * List available tools from daemon
 */
export async function listDaemonTools(): Promise<string[]> {
  try {
    const response = await fetch(`${DAEMON_URL}/tools`);
    if (response.ok) {
      const data = await response.json() as { tools?: string[] };
      return data.tools || [];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Stop the daemon
 */
export async function stopDaemon(): Promise<boolean> {
  try {
    const response = await fetch(`${DAEMON_URL}/shutdown`, { method: 'POST' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for the daemon to fully stop (port becomes free)
 */
async function waitForDaemonStop(timeoutMs: number = 10000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    // Check if port is free
    const portInUse = await isPortInUse(DAEMON_PORT);
    if (!portInUse) {
      await logToFile('debug', 'Daemon port is now free');
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await logToFile('warn', 'Timeout waiting for daemon to stop');
  return false;
}

export interface RestartDaemonOptions {
  /** Whether to restart watchers after daemon restart (default: true) */
  withWatchers?: boolean;
  /** Verbose logging (default: false) */
  verbose?: boolean;
}

export interface RestartDaemonResult {
  success: boolean;
  message: string;
  wasRunning: boolean;
  watchersStarted?: boolean;
}

/**
 * Restart the daemon, optionally with watchers.
 *
 * This will:
 * 1. Stop the current daemon (if running)
 * 2. Wait for it to fully stop
 * 3. Start a new daemon
 * 4. If withWatchers=true (default), watchers auto-start for cwd during initialization
 */
export async function restartDaemon(options: RestartDaemonOptions = {}): Promise<RestartDaemonResult> {
  const { withWatchers = true, verbose = false } = options;

  await logToFile('info', 'restartDaemon called', { withWatchers, verbose });

  // Check if daemon is currently running
  const wasRunning = await isDaemonStarted();

  if (wasRunning) {
    if (verbose) console.log('⏳ Stopping daemon...');
    await logToFile('info', 'Stopping current daemon');

    // Send shutdown signal
    const stopped = await stopDaemon();
    if (!stopped) {
      await logToFile('warn', 'Shutdown request failed, daemon may already be stopping');
    }

    // Wait for daemon to fully stop
    const fullyStoped = await waitForDaemonStop(10000);
    if (!fullyStoped) {
      await logToFile('error', 'Failed to stop daemon within timeout');
      return {
        success: false,
        message: 'Failed to stop daemon within timeout',
        wasRunning,
      };
    }

    if (verbose) console.log('✓ Daemon stopped');
  } else {
    await logToFile('info', 'Daemon was not running');
    if (verbose) console.log('ℹ Daemon was not running');
  }

  // Small delay to ensure port is fully released
  await new Promise(resolve => setTimeout(resolve, 500));

  // Start new daemon
  if (verbose) console.log('⏳ Starting daemon...');
  await logToFile('info', 'Starting new daemon', { withWatchers });

  // Set environment variable to control watcher auto-start
  if (!withWatchers) {
    process.env.RAGFORGE_SKIP_AUTO_WATCHERS = '1';
  } else {
    delete process.env.RAGFORGE_SKIP_AUTO_WATCHERS;
  }

  const started = await ensureDaemonRunning(verbose);

  // Clean up env var
  delete process.env.RAGFORGE_SKIP_AUTO_WATCHERS;

  if (!started) {
    await logToFile('error', 'Failed to start daemon');
    return {
      success: false,
      message: 'Failed to start daemon',
      wasRunning,
    };
  }

  await logToFile('info', 'Daemon restarted successfully');
  if (verbose) console.log('✓ Daemon restarted');

  return {
    success: true,
    message: wasRunning ? 'Daemon restarted successfully' : 'Daemon started successfully',
    wasRunning,
    watchersStarted: withWatchers,
  };
}

export { DAEMON_PORT, DAEMON_URL };
