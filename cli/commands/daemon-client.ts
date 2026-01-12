/**
 * Brain Daemon Client
 *
 * HTTP client for communicating with the Brain Daemon.
 * Used by test-tool and other CLI commands to call tools via the daemon.
 *
 * @since 2025-12-08
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { getLocalTimestamp } from '@luciformresearch/ragforge';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DAEMON_PORT = 6969;
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const STARTUP_TIMEOUT_MS = 90000; // 90 seconds to start daemon (Neo4j + watchers can be slow)
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
      signal: AbortSignal.timeout(5000), // Increased timeout for slow init
    });

    // 200 = ready, 503 = starting, 500 = error
    if (response.ok) {
      await logToFile('debug', `Daemon is ready`, { status: response.status });
      return true;
    }

    // Daemon is responding but not ready yet
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
    // Any response means daemon is started (200, 503, or 500)
    await logToFile('debug', `Daemon is started`, { status: response.status });
    return true;
  } catch (error: any) {
    // Connection refused = daemon not started
    return false;
  }
}

/**
 * Acquire startup lock to prevent multiple parallel daemon starts
 */
async function acquireStartupLock(): Promise<boolean> {
  try {
    // Check if lock file exists and is recent (less than 30 seconds old)
    try {
      const stats = await fs.stat(DAEMON_STARTUP_LOCK_FILE);
      const age = Date.now() - stats.mtimeMs;
      if (age < 30000) {
        // Lock file exists and is recent - someone else is starting the daemon
        return false;
      }
      // Lock file is stale - remove it
      await fs.unlink(DAEMON_STARTUP_LOCK_FILE);
    } catch {
      // Lock file doesn't exist - we can proceed
    }

    // Create lock file with current PID
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
    // Ignore errors (file might not exist)
  }
}

/**
 * Check if port is already in use (more reliable than health check)
 */
async function isPortInUse(port: number): Promise<boolean> {
  try {
    const { createServer } = await import('net');
    return new Promise((resolve) => {
      const server = createServer();
      server.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          resolve(true);
        } else {
          resolve(false);
        }
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
  const alreadyReady = await isDaemonRunning();
  if (alreadyReady) {
    await logToFile('info', 'Daemon already ready');
    if (verbose) {
      console.log('✓ Daemon already running');
    }
    return true;
  }

  // Check if daemon is started but not ready yet (initializing brain)
  const alreadyStarted = await isDaemonStarted();
  if (alreadyStarted) {
    await logToFile('info', 'Daemon started but not ready, waiting for initialization...');
    if (verbose) {
      console.log('⏳ Daemon starting, waiting for initialization...');
    }
    // Wait for daemon to become ready
    const startTime = Date.now();
    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, STARTUP_CHECK_INTERVAL_MS));
      if (await isDaemonRunning()) {
        await logToFile('info', 'Daemon became ready');
        if (verbose) {
          console.log('✓ Daemon ready');
        }
        return true;
      }
    }
    await logToFile('error', 'Timeout waiting for daemon to become ready');
    return false;
  }

  // Check if port is in use (daemon might be starting)
  const portInUse = await isPortInUse(DAEMON_PORT);
  if (portInUse) {
    await logToFile('info', 'Port in use, waiting for daemon...');
    const startTime = Date.now();
    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, STARTUP_CHECK_INTERVAL_MS));
      if (await isDaemonRunning()) {
        await logToFile('info', 'Daemon became ready');
        return true;
      }
    }
    await logToFile('error', 'Timeout waiting for daemon on port');
    return false;
  }

  // Try to acquire startup lock to prevent parallel starts
  const lockAcquired = await acquireStartupLock();
  if (!lockAcquired) {
    await logToFile('info', 'Another process is starting the daemon, waiting...');
    const startTime = Date.now();
    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, STARTUP_CHECK_INTERVAL_MS));
      if (await isDaemonRunning()) {
        await logToFile('info', 'Daemon started by another process');
        return true;
      }
    }
    await logToFile('error', 'Timeout waiting for daemon started by another process');
    return false;
  }

  try {
    await logToFile('info', 'Daemon not running, starting...');
    if (verbose) {
      console.log('⏳ Starting daemon...');
    }

  // Find the daemon script - try multiple locations
  const possiblePaths = [
    path.join(__dirname, 'daemon.js'),                    // dist/esm/commands/
    path.join(__dirname, '..', 'commands', 'daemon.js'),  // dist/esm/
    path.join(__dirname, 'daemon.ts'),                    // src/commands/ (for tsx)
  ];

  let daemonScript: string | null = null;
  for (const p of possiblePaths) {
    await logToFile('debug', `Checking daemon script at: ${p}`);
    try {
      await fs.access(p);
      daemonScript = p;
      await logToFile('info', `Found daemon script at: ${p}`);
      break;
    } catch {
      // Continue to next path
    }
  }

  if (!daemonScript) {
    await logToFile('error', 'Could not find daemon script', { tried: possiblePaths });
    console.error('❌ Could not find daemon script');
    return false;
  }

  // Spawn daemon in background
  const isTs = daemonScript.endsWith('.ts');

  // For .ts files, use npx tsx; for .js files, use node directly
  let command: string;
  let args: string[];

  if (isTs) {
    command = 'npx';
    args = ['tsx', daemonScript, 'start'];
  } else {
    command = process.execPath;
    args = [daemonScript, 'start'];
  }

  await logToFile('info', 'Spawning daemon process', {
    command,
    args,
    script: daemonScript,
    cwd: process.cwd(),
  });

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
    env: {
      ...process.env,
      RAGFORGE_DAEMON_VERBOSE: verbose ? '1' : '',
    },
    shell: isTs, // Use shell for npx
  });
  child.unref();

  await logToFile('info', `Daemon process spawned with PID: ${child.pid}`);

  // Wait for daemon to be ready
  const startTime = Date.now();
  let attempts = 0;
  while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, STARTUP_CHECK_INTERVAL_MS));
    attempts++;

    if (await isDaemonRunning()) {
      await logToFile('info', `Daemon started after ${attempts} attempts (${Date.now() - startTime}ms)`);
      if (verbose) {
        console.log('✓ Daemon started');
      }
      return true;
    }

    if (attempts % 10 === 0) {
      await logToFile('debug', `Still waiting for daemon... (attempt ${attempts})`);
    }
  }

  await logToFile('error', `Failed to start daemon within timeout (${STARTUP_TIMEOUT_MS}ms, ${attempts} attempts)`);
  console.error('❌ Failed to start daemon within timeout');
  return false;
  } finally {
    // Always release lock, even if we return early
    await releaseStartupLock();
  }
}

/**
 * Call a tool via the daemon
 */
export async function callToolViaDaemon(
  toolName: string,
  params: Record<string, any>,
  options: { verbose?: boolean } = {}
): Promise<{ success: boolean; result?: any; error?: string; duration_ms?: number }> {
  const { verbose = false } = options;
  const callStart = Date.now();

  await logToFile('info', `callToolViaDaemon: ${toolName}`, { params: Object.keys(params) });

  // Ensure daemon is running
  const daemonReady = await ensureDaemonRunning(verbose);
  if (!daemonReady) {
    await logToFile('error', 'Daemon not ready');
    return { success: false, error: 'Failed to start daemon' };
  }

  await logToFile('debug', `Daemon ready after ${Date.now() - callStart}ms`);

  try {
    if (verbose) {
      console.log(`⏳ Calling ${toolName}...`);
    }

    const url = `${DAEMON_URL}/tool/${toolName}`;
    await logToFile('debug', `Calling ${url}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = await response.json() as { success: boolean; result?: any; error?: string; duration_ms?: number };

    await logToFile('info', `Tool ${toolName} response`, {
      status: response.status,
      success: data.success,
      duration_ms: data.duration_ms,
      totalTime: Date.now() - callStart,
    });

    if (!response.ok) {
      return {
        success: false,
        error: data.error || `HTTP ${response.status}`,
      };
    }

    return data;
  } catch (error: any) {
    await logToFile('error', `Tool ${toolName} failed`, { error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Research result from the agent
 */
export interface ResearchResult {
  success: boolean;
  report?: string;
  confidence?: 'high' | 'medium' | 'low';
  sourcesUsed?: string[];
  toolsUsed?: string[];
  toolCallDetails?: Array<{
    tool_name: string;
    arguments: Record<string, any>;
    result: any;
    success: boolean;
    duration_ms: number;
  }>;
  iterations?: number;
  logPath?: string;
  reportPath?: string;
  error?: string;
}

/**
 * Call the research agent synchronously (waits for completion)
 */
export async function research(
  question: string,
  cwd?: string,
  options: { verbose?: boolean } = {}
): Promise<ResearchResult> {
  const { verbose = false } = options;
  const callStart = Date.now();

  await logToFile('info', `research: "${question.substring(0, 50)}..."`, { cwd });

  // Ensure daemon is running
  const daemonReady = await ensureDaemonRunning(verbose);
  if (!daemonReady) {
    await logToFile('error', 'Daemon not ready for research');
    return { success: false, error: 'Failed to start daemon' };
  }

  try {
    if (verbose) {
      console.log(`⏳ Researching...`);
    }

    const url = `${DAEMON_URL}/agent/research-sync`;
    await logToFile('debug', `Calling ${url}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question, cwd }),
    });

    const data = await response.json() as ResearchResult;

    await logToFile('info', `Research complete`, {
      status: response.status,
      success: data.success,
      confidence: data.confidence,
      iterations: data.iterations,
      totalTime: Date.now() - callStart,
    });

    if (!response.ok) {
      return {
        success: false,
        error: data.error || `HTTP ${response.status}`,
      };
    }

    return data;
  } catch (error: any) {
    await logToFile('error', `Research failed`, { error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Get daemon status
 */
export async function getDaemonStatus(): Promise<any | null> {
  try {
    const response = await fetch(`${DAEMON_URL}/status`);
    if (response.ok) {
      return await response.json();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List available tools
 */
export async function listTools(): Promise<string[]> {
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
    const response = await fetch(`${DAEMON_URL}/shutdown`, {
      method: 'POST',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get recent logs from daemon
 */
export async function getDaemonLogs(lines: number = 100): Promise<string[]> {
  try {
    const response = await fetch(`${DAEMON_URL}/logs?lines=${lines}`);
    if (response.ok) {
      const data = await response.json() as { logs?: string[] };
      return data.logs || [];
    }
    return [];
  } catch {
    return [];
  }
}

export { DAEMON_PORT, DAEMON_URL };

// ============================================
// Daemon Tool Handlers for Agent Use
// ============================================

/**
 * List of tools that should be routed through daemon
 *
 * All tools that interact with the brain (Neo4j) or benefit from brain integration
 * should be routed via daemon. This ensures:
 * - Single point of access to Neo4j (no connection conflicts)
 * - Atomic operations (file creation + ingestion together)
 * - Proper file watching and orphan tracking
 */
const DAEMON_TOOL_NAMES = [
  // FS tools (file system exploration - ensures latest code after build)
  'list_directory',
  'glob_files',
  'grep_files',
  'search_files',
  'analyze_files',

  // File tools (for brain integration - touchFile on read, triggerReIngestion on modify)
  'read_file',
  'read_files',
  'write_file',
  'create_file',
  'edit_file',
  'delete_path',
  'move_file',
  'copy_file',

  // Brain tools
  'create_project',
  'ingest_directory',
  'ingest_web_page',
  'brain_search',
  'forget_path',
  'list_brain_projects',
  'exclude_project',
  'include_project',
  'list_watchers',
  'start_watcher',
  'stop_watcher',
  'mark_file_dirty',
  'touch_file',
  'get_schema',
  'run_cypher',
  'extract_dependency_hierarchy',
  'explore_node',
  'notify_user',
  'update_todos',
  'call_research_agent',

  // Image tools
  'read_image',
  'describe_image',
  'list_images',
  'generate_image',
  'edit_image',
  'generate_multiview_images',
  'analyze_visual',

  // 3D tools
  'render_3d_asset',
  'generate_3d_from_image',
  'generate_3d_from_text',
  'analyze_3d_model',

  // Web tools
  'search_web',
  'fetch_web_page',
] as const;

/**
 * Generate daemon tool handlers that call the daemon via HTTP
 *
 * This is used by agents to route all daemon tool calls through the daemon,
 * ensuring single-point access to the database and proper file watching.
 */
export function generateDaemonToolHandlers(): Record<string, (params: any) => Promise<any>> {
  const handlers: Record<string, (params: any) => Promise<any>> = {};

  for (const toolName of DAEMON_TOOL_NAMES) {
    handlers[toolName] = async (params: any) => {
      const result = await callToolViaDaemon(toolName, params);
      if (!result.success) {
        throw new Error(result.error || `Tool ${toolName} failed`);
      }
      return result.result;
    };
  }

  return handlers;
}

// Keep backward compatibility alias
export const generateDaemonBrainToolHandlers = generateDaemonToolHandlers;

// Export the tool names for external use
export { DAEMON_TOOL_NAMES };
