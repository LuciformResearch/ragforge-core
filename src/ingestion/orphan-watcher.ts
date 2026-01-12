/**
 * OrphanWatcher - Watch individual files not part of any project
 *
 * Handles files that are read via tools (read_file, etc.) but are not
 * part of an ingested project. These are stored in the "touched-files"
 * pseudo-project.
 *
 * Features:
 * - Watch individual files (not directories)
 * - Auto-cleanup after retention period
 * - Configurable limit on watched files
 * - Persistence to Neo4j for daemon restart recovery
 */

import { watch, type FSWatcher } from 'chokidar';
import type { Driver } from 'neo4j-driver';
import type { FileChange, OrphanWatcherConfig, OrphanFileStatus } from './types.js';
import { ORPHAN_PROJECT_ID } from './types.js';

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<OrphanWatcherConfig> = {
  maxFiles: 100,
  retentionDays: 7,
  persistToNeo4j: true,
  batchIntervalMs: 1000,
};

/**
 * Event handler types
 */
export type OrphanWatcherEventHandler = (change: FileChange) => void;

export class OrphanWatcher {
  private config: Required<OrphanWatcherConfig>;
  private driver: Driver | null;
  private watcher: FSWatcher | null = null;
  private watchedFiles = new Set<string>();
  private fileAccessTimes = new Map<string, Date>();
  private eventHandler: OrphanWatcherEventHandler | null = null;
  private isInitialized = false;

  constructor(driver: Driver | null, config: OrphanWatcherConfig = {}) {
    this.driver = driver;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the watcher
   * Loads previously watched files from Neo4j if persistence is enabled
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Load persisted watch list from Neo4j
    if (this.driver && this.config.persistToNeo4j) {
      await this.loadPersistedFiles();
    }

    // Initialize chokidar watcher (lazy - only if we have files)
    if (this.watchedFiles.size > 0) {
      this.initWatcher();
    }

    this.isInitialized = true;
  }

  /**
   * Watch a file
   * Returns false if the file limit is reached
   */
  async watch(filePath: string): Promise<boolean> {
    // Already watching
    if (this.watchedFiles.has(filePath)) {
      // Update access time
      this.fileAccessTimes.set(filePath, new Date());
      await this.updateAccessTime(filePath);
      return true;
    }

    // Check limit
    if (this.watchedFiles.size >= this.config.maxFiles) {
      console.warn(`[OrphanWatcher] Limit reached (${this.config.maxFiles} files), not watching: ${filePath}`);
      return false;
    }

    // Add to watch set
    this.watchedFiles.add(filePath);
    this.fileAccessTimes.set(filePath, new Date());

    // Initialize watcher if needed
    if (!this.watcher) {
      this.initWatcher();
    }

    // Add file to chokidar
    this.watcher!.add(filePath);

    // Persist to Neo4j
    if (this.driver && this.config.persistToNeo4j) {
      await this.persistFile(filePath);
    }

    return true;
  }

  /**
   * Stop watching a file
   */
  async unwatch(filePath: string): Promise<void> {
    if (!this.watchedFiles.has(filePath)) return;

    this.watchedFiles.delete(filePath);
    this.fileAccessTimes.delete(filePath);

    if (this.watcher) {
      this.watcher.unwatch(filePath);
    }

    // Remove from Neo4j
    if (this.driver && this.config.persistToNeo4j) {
      await this.unpersistFile(filePath);
    }
  }

  /**
   * Set the event handler for file changes
   */
  onFileChange(handler: OrphanWatcherEventHandler): void {
    this.eventHandler = handler;
  }

  /**
   * Get list of currently watched files
   */
  getWatchedFiles(): string[] {
    return Array.from(this.watchedFiles);
  }

  /**
   * Get status of a specific file
   */
  getFileStatus(filePath: string): OrphanFileStatus | null {
    if (!this.watchedFiles.has(filePath)) return null;

    const lastAccessed = this.fileAccessTimes.get(filePath) || new Date();

    return {
      path: filePath,
      isWatched: true,
      firstAccessed: lastAccessed, // We don't track first access separately
      lastAccessed,
      watchedSince: lastAccessed,
    };
  }

  /**
   * Cleanup stale files that haven't been accessed in retention period
   */
  async cleanupStale(): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000);
    const staleFiles: string[] = [];

    for (const [filePath, lastAccess] of this.fileAccessTimes) {
      if (lastAccess < cutoff) {
        staleFiles.push(filePath);
      }
    }

    // Unwatch stale files
    for (const filePath of staleFiles) {
      await this.unwatch(filePath);
    }

    if (staleFiles.length > 0) {
      console.log(`[OrphanWatcher] Cleaned up ${staleFiles.length} stale files`);
    }

    return staleFiles.length;
  }

  /**
   * Get statistics
   */
  getStats(): { watchedCount: number; maxFiles: number; retentionDays: number } {
    return {
      watchedCount: this.watchedFiles.size,
      maxFiles: this.config.maxFiles,
      retentionDays: this.config.retentionDays,
    };
  }

  /**
   * Stop the watcher and clean up
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.isInitialized = false;
  }

  // =========================================================================
  // Private methods
  // =========================================================================

  private initWatcher(): void {
    if (this.watcher) return;

    this.watcher = watch([], {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher.on('change', (path) => {
      this.handleChange(path, 'updated');
    });

    this.watcher.on('unlink', (path) => {
      this.handleChange(path, 'deleted');
      // Remove from watch set since file is deleted
      this.watchedFiles.delete(path);
      this.fileAccessTimes.delete(path);
    });

    this.watcher.on('error', (error) => {
      console.error('[OrphanWatcher] Error:', error);
    });

    // Add existing files
    for (const file of this.watchedFiles) {
      this.watcher.add(file);
    }
  }

  private handleChange(path: string, changeType: 'updated' | 'deleted'): void {
    // Update access time
    this.fileAccessTimes.set(path, new Date());

    const change: FileChange = {
      path,
      changeType,
      projectId: ORPHAN_PROJECT_ID,
    };

    if (this.eventHandler) {
      this.eventHandler(change);
    }
  }

  private async loadPersistedFiles(): Promise<void> {
    if (!this.driver) return;

    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (f:File)
        WHERE f.projectId = $projectId AND f.isWatched = true
        RETURN f.absolutePath AS path, f.lastAccessed AS lastAccessed, f.watchedSince AS watchedSince
        `,
        { projectId: ORPHAN_PROJECT_ID }
      );

      for (const record of result.records) {
        const path = record.get('path');
        if (path) {
          this.watchedFiles.add(path);
          const lastAccessed = record.get('lastAccessed');
          this.fileAccessTimes.set(
            path,
            lastAccessed ? new Date(lastAccessed) : new Date()
          );
        }
      }

      if (this.watchedFiles.size > 0) {
        console.log(`[OrphanWatcher] Loaded ${this.watchedFiles.size} persisted files`);
      }
    } finally {
      await session.close();
    }
  }

  private async persistFile(filePath: string): Promise<void> {
    if (!this.driver) return;

    const session = this.driver.session();
    try {
      const now = new Date().toISOString();
      await session.run(
        `
        MERGE (f:File {absolutePath: $path})
        SET f.projectId = $projectId,
            f.isWatched = true,
            f.watchedSince = COALESCE(f.watchedSince, $now),
            f.lastAccessed = $now
        `,
        { path: filePath, projectId: ORPHAN_PROJECT_ID, now }
      );
    } finally {
      await session.close();
    }
  }

  private async unpersistFile(filePath: string): Promise<void> {
    if (!this.driver) return;

    const session = this.driver.session();
    try {
      await session.run(
        `
        MATCH (f:File {absolutePath: $path, projectId: $projectId})
        SET f.isWatched = false
        `,
        { path: filePath, projectId: ORPHAN_PROJECT_ID }
      );
    } finally {
      await session.close();
    }
  }

  private async updateAccessTime(filePath: string): Promise<void> {
    if (!this.driver || !this.config.persistToNeo4j) return;

    const session = this.driver.session();
    try {
      await session.run(
        `
        MATCH (f:File {absolutePath: $path, projectId: $projectId})
        SET f.lastAccessed = $now
        `,
        { path: filePath, projectId: ORPHAN_PROJECT_ID, now: new Date().toISOString() }
      );
    } finally {
      await session.close();
    }
  }
}
