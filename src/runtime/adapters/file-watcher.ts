/**
 * File Watcher - Detection Only
 *
 * Monitors source code files for changes and marks them as 'discovered'.
 * Uses chokidar for efficient file watching.
 * The actual processing is done by ProcessingLoop.
 *
 * @since 2026-01-16 - Refactored to detector-only mode
 */

import chokidar from 'chokidar';
import path from 'path';
import fg from 'fast-glob';
import { EventEmitter } from 'events';
import type { CodeSourceConfig } from './code-source-adapter.js';
import type { FileStateMachine } from '../../brain/file-state-machine.js';
import type { Neo4jClient } from '../client/neo4j-client.js';
import type { AgentLogger } from '../agents/rag-agent.js';

export interface FileWatcherConfig {
  /** Project ID for file tracking */
  projectId: string;
  /** Optional AgentLogger for structured logging */
  logger?: AgentLogger;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Chokidar options for file watching */
  watchOptions?: chokidar.WatchOptions;
  /** Batch interval for grouping multiple changes (ms, default: 500) */
  batchIntervalMs?: number;
  /** Callback when watcher starts */
  onWatchStart?: (paths: string[]) => void;
  /** Callback when file changes are detected */
  onFileChange?: (filePath: string, eventType: 'add' | 'change' | 'unlink') => void;
  /** Callback when files are marked as discovered (after batching) */
  onBatchComplete?: (stats: { created: number; reset: number; skipped: number; deleted: number }) => void;
}

export interface FileWatcherDependencies {
  fileStateMachine: FileStateMachine;
  neo4jClient: Neo4jClient;
}

/**
 * FileWatcher - Detection Only Mode
 *
 * This watcher only marks files as 'discovered' when they change.
 * The ProcessingLoop handles the actual parsing/embedding.
 */
export class FileWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private config: FileWatcherConfig;
  private deps: FileWatcherDependencies;
  private sourceConfig: CodeSourceConfig;
  private logger?: AgentLogger;
  private paused = false;

  // Batching
  private pendingChanges = new Map<string, 'add' | 'change' | 'unlink'>();
  private batchTimer: NodeJS.Timeout | null = null;
  private batchIntervalMs: number;

  constructor(
    deps: FileWatcherDependencies,
    sourceConfig: CodeSourceConfig,
    config: FileWatcherConfig
  ) {
    super();
    this.deps = deps;
    this.sourceConfig = sourceConfig;
    this.config = config;
    this.logger = config.logger;
    this.batchIntervalMs = config.batchIntervalMs ?? 500;
  }

  /**
   * Set or update the logger
   */
  setLogger(logger: AgentLogger): void {
    this.logger = logger;
  }

  /**
   * Get the project ID
   */
  getProjectId(): string {
    return this.config.projectId;
  }

  /**
   * Start watching files for changes
   */
  async start(): Promise<void> {
    if (this.watcher) {
      throw new Error('Watcher already started');
    }

    const { root = '.', include, exclude = [] } = this.sourceConfig;

    if (!include || include.length === 0) {
      throw new Error('No include patterns specified in source config');
    }

    // Convert glob patterns to absolute paths
    const patterns = include.map(pattern => `${root}/${pattern}`);

    if (this.config.verbose) {
      console.log('\n👀 Starting file watcher (detector mode)...');
      console.log(`   Watching patterns: ${patterns.join(', ')}`);
      if (exclude.length > 0) {
        console.log(`   Ignoring patterns: ${exclude.join(', ')}`);
      }
    }

    // Create chokidar watcher
    const watcherStartTime = Date.now();

    this.watcher = chokidar.watch(patterns, {
      ignored: exclude,
      persistent: true,
      ignoreInitial: true, // Don't trigger on startup
      usePolling: false,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      },
      ...this.config.watchOptions
    });

    // Listen to 'ready' event for logging
    this.watcher.on('ready', () => {
      const readyDuration = Date.now() - watcherStartTime;
      const watched = this.watcher!.getWatched();
      const paths = Object.keys(watched);
      const fileCount = Object.values(watched).reduce((sum, files) => sum + files.length, 0);

      if (this.config.verbose) {
        console.log(`[FileWatcher] Initial scan complete after ${readyDuration}ms (${fileCount} files watched)`);
      }

      this.logger?.logWatcherStarted(patterns, fileCount);
      this.emit('ready', { paths, fileCount });

      if (this.config.onWatchStart) {
        this.config.onWatchStart(paths);
      }
    });

    // Set up event handlers
    this.watcher
      .on('add', (filePath) => this.handleFileEvent(filePath, 'add'))
      .on('change', (filePath) => this.handleFileEvent(filePath, 'change'))
      .on('unlink', (filePath) => this.handleFileEvent(filePath, 'unlink'))
      .on('error', (error) => {
        console.error(`[FileWatcher] ❌ Watcher error:`, error);
        this.emit('error', error);
      });

    if (this.config.verbose) {
      console.log(`[FileWatcher] Watcher ready (detector mode)`);
    }
  }

  /**
   * Stop watching files
   */
  async stop(): Promise<void> {
    if (!this.watcher) {
      return;
    }

    // Flush pending changes
    await this.flushBatch();

    // Clear timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Close watcher
    await this.watcher.close();
    this.watcher = null;

    if (this.config.verbose) {
      console.log('[FileWatcher] Watcher stopped');
    }

    this.emit('stopped');
  }

  /**
   * Get the root path being watched
   */
  getRoot(): string {
    return this.sourceConfig.root || '.';
  }

  /**
   * Queue all files in a directory for re-discovery
   */
  async queueDirectory(dirPath: string): Promise<void> {
    const { include = [], exclude = [] } = this.sourceConfig;
    const absoluteDir = path.resolve(dirPath);

    const patterns = include.map(pattern => `${absoluteDir}/${pattern}`);
    const files = await fg(patterns, {
      ignore: exclude,
      absolute: true,
      onlyFiles: true,
    });

    if (this.config.verbose) {
      console.log(`[FileWatcher] Marking ${files.length} files as discovered from ${absoluteDir}`);
    }

    // Mark all files as discovered in batch
    const fileData = files.map(f => ({
      absolutePath: f,
      relativePath: path.relative(this.getRoot(), f),
    }));

    const stats = await this.deps.fileStateMachine.markDiscoveredBatch(fileData, this.config.projectId);

    this.emit('batch', stats);

    if (this.config.onBatchComplete) {
      this.config.onBatchComplete({ ...stats, deleted: 0 });
    }
  }

  /**
   * Check if watcher is running
   */
  isWatching(): boolean {
    return this.watcher !== null;
  }

  /**
   * Check if watcher is paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Pause the watcher - events are ignored
   */
  pause(): void {
    if (!this.watcher) {
      return;
    }
    this.paused = true;
    if (this.config.verbose) {
      console.log('⏸️ File watcher paused');
    }
    this.emit('paused');
  }

  /**
   * Resume the watcher
   */
  resume(): void {
    if (!this.watcher) {
      return;
    }
    this.paused = false;
    if (this.config.verbose) {
      console.log('▶️ File watcher resumed');
    }
    this.emit('resumed');
  }

  /**
   * Pause, execute a function, then resume
   */
  async withPause<T>(fn: () => Promise<T>): Promise<T> {
    this.pause();
    try {
      return await fn();
    } finally {
      this.resume();
    }
  }

  /**
   * Handle file system events - add to pending batch
   */
  private handleFileEvent(filePath: string, eventType: 'add' | 'change' | 'unlink'): void {
    // Ignore events while paused
    if (this.paused) {
      if (this.config.verbose) {
        console.log(`⏸️ Ignoring ${eventType} (paused): ${filePath}`);
      }
      return;
    }

    // Log event
    const emoji = eventType === 'add' ? '➕' : eventType === 'change' ? '✏️' : '➖';
    if (this.config.verbose) {
      console.log(`[FileWatcher] ${emoji} ${eventType.toUpperCase()}: ${filePath}`);
    }

    this.logger?.logFileChange(filePath, eventType);

    if (this.config.onFileChange) {
      this.config.onFileChange(filePath, eventType);
    }

    // Add to pending batch (latest event wins for same file)
    this.pendingChanges.set(filePath, eventType);

    // Reset batch timer
    this.resetBatchTimer();
  }

  /**
   * Reset the batch timer
   */
  private resetBatchTimer(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    this.batchTimer = setTimeout(() => {
      this.flushBatch().catch(error => {
        console.error(`[FileWatcher] Batch flush error:`, error);
        this.emit('error', error);
      });
    }, this.batchIntervalMs);
  }

  /**
   * Flush pending changes - mark files as discovered
   */
  private async flushBatch(): Promise<void> {
    if (this.pendingChanges.size === 0) {
      return;
    }

    const changes = new Map(this.pendingChanges);
    this.pendingChanges.clear();

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Separate additions/changes from deletions
    const toDiscover: Array<{ absolutePath: string; relativePath?: string }> = [];
    const toDelete: string[] = [];

    for (const [filePath, eventType] of changes) {
      if (eventType === 'unlink') {
        toDelete.push(filePath);
      } else {
        toDiscover.push({
          absolutePath: filePath,
          relativePath: path.relative(this.getRoot(), filePath),
        });
      }
    }

    let stats = { created: 0, reset: 0, skipped: 0 };
    let deleted = 0;

    // Mark files as discovered (batch)
    if (toDiscover.length > 0) {
      stats = await this.deps.fileStateMachine.markDiscoveredBatch(toDiscover, this.config.projectId);

      if (this.config.verbose) {
        console.log(`[FileWatcher] Marked ${toDiscover.length} files: created=${stats.created}, reset=${stats.reset}, skipped=${stats.skipped}`);
      }
    }

    // Handle deletions - delete File nodes and associated Scopes
    if (toDelete.length > 0) {
      deleted = await this.deleteFiles(toDelete);

      if (this.config.verbose) {
        console.log(`[FileWatcher] Deleted ${deleted} files`);
      }
    }

    // Emit event
    this.emit('batch', { ...stats, deleted });

    if (this.config.onBatchComplete) {
      this.config.onBatchComplete({ ...stats, deleted });
    }
  }

  /**
   * Delete File nodes and associated Scopes
   */
  private async deleteFiles(filePaths: string[]): Promise<number> {
    if (filePaths.length === 0) {
      return 0;
    }

    const uuids = filePaths.map(p => `file:${this.config.projectId}:${p}`);

    // Delete Scopes first (they reference Files)
    await this.deps.neo4jClient.run(
      `
      MATCH (f:File)
      WHERE f.uuid IN $uuids
      OPTIONAL MATCH (s:Scope)-[:DEFINED_IN]->(f)
      DETACH DELETE s
    `,
      { uuids }
    );

    // Delete Files
    const result = await this.deps.neo4jClient.run(
      `
      MATCH (f:File)
      WHERE f.uuid IN $uuids
      DETACH DELETE f
      RETURN count(*) as deleted
    `,
      { uuids }
    );

    return result.records[0]?.get('deleted')?.toNumber?.() || result.records[0]?.get('deleted') || 0;
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Create a FileWatcher with dependencies
 */
export function createFileWatcher(
  deps: FileWatcherDependencies,
  sourceConfig: CodeSourceConfig,
  config: FileWatcherConfig
): FileWatcher {
  return new FileWatcher(deps, sourceConfig, config);
}
