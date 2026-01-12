/**
 * Daemon Client - HTTP client for Brain Daemon communication
 */
export {
  // Status checks
  isDaemonRunning,
  isDaemonStarted,

  // Lifecycle
  ensureDaemonRunning,
  stopDaemon,

  // Tool calls
  callToolViaDaemon,

  // Info
  getDaemonStatus,
  listDaemonTools,

  // Constants
  DAEMON_PORT,
  DAEMON_URL,

  // Types
  type DaemonToolResult,
} from './daemon-client.js';
