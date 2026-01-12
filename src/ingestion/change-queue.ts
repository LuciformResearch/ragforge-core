/**
 * ChangeQueue - Simplified batching for file changes
 *
 * Collects file changes and batches them for efficient processing.
 * Changes are grouped by project and processed after a configurable delay.
 *
 * This replaces the more complex IngestionQueue with a simpler model:
 * - No ingestion logic (delegated to Orchestrator)
 * - Simple batching with debounce
 * - Configurable flush callback
 */

import type { FileChange, ChangeQueueConfig, QueueStatus, ChangeBatch } from './types.js';

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<ChangeQueueConfig> = {
  batchIntervalMs: 1000,
  maxBatchSize: 100,
  onBatchReady: async () => {},
};

export class ChangeQueue {
  private config: Required<ChangeQueueConfig>;
  private pending: Map<string, FileChange> = new Map(); // path -> change (deduped)
  private flushTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private lastFlushTime = 0;

  constructor(config: ChangeQueueConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add a change to the queue
   * Deduplicates changes for the same file, keeping the latest
   */
  add(change: FileChange): void {
    // Dedupe: if we already have a change for this path, update it
    // Priority: deleted > updated > created
    const existing = this.pending.get(change.path);

    if (existing) {
      // If new change is delete, it always wins
      if (change.changeType === 'deleted') {
        this.pending.set(change.path, change);
      }
      // If existing is delete, keep it (file is being deleted)
      else if (existing.changeType === 'deleted') {
        // Keep delete
      }
      // Otherwise, update wins over create
      else if (change.changeType === 'updated') {
        this.pending.set(change.path, change);
      }
      // Keep existing if it's update and new is create
    } else {
      this.pending.set(change.path, change);
    }

    // Schedule flush
    this.scheduleFlush();

    // Force flush if we hit max batch size
    if (this.pending.size >= this.config.maxBatchSize) {
      this.flushNow();
    }
  }

  /**
   * Add multiple changes at once
   */
  addBatch(changes: FileChange[]): void {
    for (const change of changes) {
      this.add(change);
    }
  }

  /**
   * Get pending changes without clearing them
   */
  peek(): FileChange[] {
    return Array.from(this.pending.values());
  }

  /**
   * Flush pending changes and return them
   * This clears the queue
   */
  flush(): FileChange[] {
    this.cancelFlush();
    const changes = Array.from(this.pending.values());
    this.pending.clear();
    this.lastFlushTime = Date.now();
    return changes;
  }

  /**
   * Force immediate flush and process via callback
   */
  async flushNow(): Promise<void> {
    if (this.isProcessing) return;

    const changes = this.flush();
    if (changes.length === 0) return;

    this.isProcessing = true;
    try {
      await this.config.onBatchReady(changes);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Get the current status of the queue
   */
  getStatus(): QueueStatus {
    const now = Date.now();
    const timeSinceLastFlush = now - this.lastFlushTime;
    const timeUntilFlush = this.flushTimer
      ? Math.max(0, this.config.batchIntervalMs - timeSinceLastFlush)
      : undefined;

    return {
      pendingCount: this.pending.size,
      isProcessing: this.isProcessing,
      timeUntilFlush,
    };
  }

  /**
   * Get changes grouped by project
   */
  getChangesByProject(): Map<string, FileChange[]> {
    const byProject = new Map<string, FileChange[]>();

    for (const change of this.pending.values()) {
      const projectId = change.projectId || '_orphan';
      const existing = byProject.get(projectId) || [];
      existing.push(change);
      byProject.set(projectId, existing);
    }

    return byProject;
  }

  /**
   * Create a ChangeBatch from current pending changes
   */
  createBatch(): ChangeBatch {
    return {
      byProject: this.getChangesByProject(),
      createdAt: new Date(),
      totalChanges: this.pending.size,
    };
  }

  /**
   * Update configuration
   */
  configure(config: Partial<ChangeQueueConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Set the batch ready callback
   */
  onBatchReady(callback: (changes: FileChange[]) => Promise<void>): void {
    this.config.onBatchReady = callback;
  }

  /**
   * Clear all pending changes without processing
   */
  clear(): void {
    this.cancelFlush();
    this.pending.clear();
  }

  /**
   * Check if queue has pending changes
   */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Stop the queue (cancel pending flush)
   */
  stop(): void {
    this.cancelFlush();
  }

  // =========================================================================
  // Private methods
  // =========================================================================

  private scheduleFlush(): void {
    // Already scheduled
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      await this.flushNow();
    }, this.config.batchIntervalMs);
  }

  private cancelFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

/**
 * Create a change queue with a processing callback
 */
export function createChangeQueue(
  onProcess: (changes: FileChange[]) => Promise<void>,
  config?: Omit<ChangeQueueConfig, 'onBatchReady'>
): ChangeQueue {
  return new ChangeQueue({
    ...config,
    onBatchReady: onProcess,
  });
}
