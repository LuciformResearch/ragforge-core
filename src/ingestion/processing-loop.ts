/**
 * ProcessingLoop - Continuous processing orchestrator
 *
 * Runs a continuous loop that processes files through UnifiedProcessor.
 * Handles:
 * - Initial recovery from crash
 * - Processing discovered files
 * - Processing linked files (entities + embeddings)
 * - Graceful shutdown
 * - Backoff when idle
 *
 * @since 2026-01-16 - Created as part of unification effort
 */

import { EventEmitter } from 'events';
import { UnifiedProcessor, type ProcessingStats, type RecoveryStats } from './unified-processor.js';

// ============================================
// Types
// ============================================

export interface ProcessingLoopConfig {
  /** UnifiedProcessor instance */
  processor: UnifiedProcessor;
  /** Poll interval when idle (ms, default: 1000) */
  idleIntervalMs?: number;
  /** Poll interval when busy (ms, default: 100) */
  busyIntervalMs?: number;
  /** Maximum idle interval for backoff (ms, default: 10000) */
  maxIdleIntervalMs?: number;
  /** Verbose logging */
  verbose?: boolean;
  /** Run recovery on start (default: true) */
  recoverOnStart?: boolean;
}

export interface LoopStats {
  /** Total iterations run */
  iterations: number;
  /** Total files processed */
  filesProcessed: number;
  /** Total files skipped */
  filesSkipped: number;
  /** Total files errored */
  filesErrored: number;
  /** Total entities created */
  entitiesCreated: number;
  /** Total embeddings generated */
  embeddingsGenerated: number;
  /** Start time */
  startedAt: Date;
  /** Last iteration time */
  lastIterationAt?: Date;
  /** Last time any activity was detected (for timeout reset) */
  lastActivityAt?: Date;
  /** Is currently running */
  isRunning: boolean;
  /** Is currently processing */
  isProcessing: boolean;
}

// ============================================
// ProcessingLoop
// ============================================

export class ProcessingLoop extends EventEmitter {
  private processor: UnifiedProcessor;
  private idleIntervalMs: number;
  private busyIntervalMs: number;
  private maxIdleIntervalMs: number;
  private verbose: boolean;
  private recoverOnStart: boolean;

  private isRunning = false;
  private isProcessing = false;
  private currentIntervalMs: number;
  private timeoutId?: NodeJS.Timeout;
  private consecutiveIdleCount = 0;

  private stats: LoopStats = {
    iterations: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    filesErrored: 0,
    entitiesCreated: 0,
    embeddingsGenerated: 0,
    startedAt: new Date(),
    isRunning: false,
    isProcessing: false,
  };

  constructor(config: ProcessingLoopConfig) {
    super();
    this.processor = config.processor;
    this.idleIntervalMs = config.idleIntervalMs ?? 1000;
    this.busyIntervalMs = config.busyIntervalMs ?? 100;
    this.maxIdleIntervalMs = config.maxIdleIntervalMs ?? 10000;
    this.verbose = config.verbose ?? false;
    this.recoverOnStart = config.recoverOnStart ?? true;
    this.currentIntervalMs = this.idleIntervalMs;
  }

  // ============================================
  // Lifecycle Methods
  // ============================================

  /**
   * Start the processing loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[ProcessingLoop] Already running, skipping start');
      return;
    }

    this.isRunning = true;
    this.stats.startedAt = new Date();
    this.stats.isRunning = true;

    this.emit('started');

    console.log('[ProcessingLoop] Started');

    // Run recovery if enabled
    if (this.recoverOnStart) {
      try {
        const recoveryStats = await this.processor.recover();
        this.emit('recovered', recoveryStats);

        if (this.verbose) {
          console.log(`[ProcessingLoop] Recovery complete: ${recoveryStats.filesRecovered} files to retry`);
        }
      } catch (error: any) {
        console.error(`[ProcessingLoop] Recovery failed: ${error.message}`);
      }
    }

    // Start the loop
    this.scheduleNextIteration(0);
  }

  /**
   * Stop the processing loop gracefully (waits for current processing to complete)
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.stats.isRunning = false;

    // Clear scheduled iteration
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }

    // Wait for current processing to complete (max 30s)
    const startTime = Date.now();
    while (this.isProcessing && Date.now() - startTime < 30000) {
      await this.sleep(100);
    }

    this.emit('stopped');

    if (this.verbose) {
      console.log('[ProcessingLoop] Stopped');
    }
  }

  /**
   * Force stop immediately without waiting for current processing
   */
  forceStop(): void {
    this.isRunning = false;
    this.isProcessing = false;
    this.stats.isRunning = false;

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }

    this.emit('stopped');
    console.log('[ProcessingLoop] Force stopped');
  }

  /**
   * Trigger immediate processing (for external events like file changes)
   */
  triggerProcessing(): void {
    if (!this.isRunning || this.isProcessing) {
      return;
    }

    // Clear current timeout and run immediately
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }

    this.consecutiveIdleCount = 0;
    console.log('[ProcessingLoop] Triggered');
    this.scheduleNextIteration(0);
  }

  // ============================================
  // Processing Loop
  // ============================================

  private scheduleNextIteration(delayMs: number): void {
    if (!this.isRunning) {
      return;
    }

    this.timeoutId = setTimeout(() => {
      this.runIteration().catch(error => {
        console.error(`[ProcessingLoop] Iteration error: ${error.message}`);
      });
    }, delayMs);
  }

  private async runIteration(): Promise<void> {
    if (!this.isRunning || this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    this.stats.isProcessing = true;
    this.stats.iterations++;
    this.stats.lastIterationAt = new Date();
    this.recordActivity(); // Record activity at start

    try {
      // Phase 1: Process ALL discovered files (parsing)
      this.recordActivity();
      const discoveredStats = await this.processor.processDiscovered();
      this.recordActivity(); // Record activity after phase
      if (discoveredStats.filesProcessed > 0 || discoveredStats.filesErrored > 0) {
        console.log(`[ProcessingLoop] Parsing: processed=${discoveredStats.filesProcessed}, skipped=${discoveredStats.filesSkipped}, errored=${discoveredStats.filesErrored}`);
      }

      // Phase 2: Process ALL linked files (entities + embeddings)
      this.recordActivity();
      const linkedStats = await this.processor.processLinked();
      this.recordActivity(); // Record activity after phase
      if (linkedStats.filesProcessed > 0 || linkedStats.entitiesCreated > 0 || linkedStats.embeddingsGenerated > 0) {
        console.log(`[ProcessingLoop] Linked: files=${linkedStats.filesProcessed}, entities=${linkedStats.entitiesCreated}, embeddings=${linkedStats.embeddingsGenerated}`);
      }

      // Phase 3: Process nodes directly (handles re-parsed files where File stayed 'embedded' but nodes became 'linked')
      this.recordActivity();
      const nodesStats = await this.processor.processLinkedNodes();
      this.recordActivity(); // Record activity after phase
      if (nodesStats.nodesProcessed > 0 || nodesStats.embeddingsGenerated > 0) {
        console.log(`[ProcessingLoop] Nodes: processed=${nodesStats.nodesProcessed}, embeddings=${nodesStats.embeddingsGenerated}`);
      }

      // Aggregate stats
      const totalProcessed = discoveredStats.filesProcessed + linkedStats.filesProcessed;
      const totalSkipped = discoveredStats.filesSkipped + linkedStats.filesSkipped;
      const totalErrored = discoveredStats.filesErrored + linkedStats.filesErrored;

      this.stats.filesProcessed += totalProcessed;
      this.stats.filesSkipped += totalSkipped;
      this.stats.filesErrored += totalErrored;
      this.stats.entitiesCreated += discoveredStats.entitiesCreated + linkedStats.entitiesCreated;
      this.stats.embeddingsGenerated += discoveredStats.embeddingsGenerated + linkedStats.embeddingsGenerated + nodesStats.embeddingsGenerated;

      // Emit progress event
      if (totalProcessed > 0 || totalErrored > 0) {
        this.emit('progress', {
          processed: totalProcessed,
          skipped: totalSkipped,
          errored: totalErrored,
        });
      }

      // Adjust interval based on activity
      const hadWork = totalProcessed > 0 || nodesStats.nodesProcessed > 0;
      if (hadWork) {
        // Busy - use short interval
        this.currentIntervalMs = this.busyIntervalMs;
        this.consecutiveIdleCount = 0;

        console.log(`[ProcessingLoop] Done: ${totalProcessed} files, ${nodesStats.nodesProcessed} nodes`);
      } else {
        // Idle - use exponential backoff
        this.consecutiveIdleCount++;
        this.currentIntervalMs = Math.min(
          this.idleIntervalMs * Math.pow(1.5, this.consecutiveIdleCount),
          this.maxIdleIntervalMs
        );
        // Only log first idle to avoid spam
        if (this.consecutiveIdleCount === 1) {
          console.log(`[ProcessingLoop] Idle, backoff to ${Math.round(this.currentIntervalMs)}ms`);
        }
      }

    } catch (error: any) {
      console.error(`[ProcessingLoop] Error: ${error.message}`);
      this.emit('error', error);

      // Back off on error
      this.currentIntervalMs = this.maxIdleIntervalMs;

    } finally {
      this.isProcessing = false;
      this.stats.isProcessing = false;
    }

    // Schedule next iteration
    this.scheduleNextIteration(this.currentIntervalMs);
  }

  // ============================================
  // Status Methods
  // ============================================

  /**
   * Get current loop statistics
   */
  getStats(): LoopStats {
    return { ...this.stats };
  }

  /**
   * Check if the loop is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get processing progress
   */
  async getProgress(): Promise<{ processed: number; total: number; percentage: number }> {
    return this.processor.getProgress();
  }

  /**
   * Check if processing is complete
   */
  async isComplete(): Promise<boolean> {
    return this.processor.isComplete();
  }

  /**
   * Get timestamp of last activity (for timeout management)
   * Returns undefined if no activity has occurred yet
   */
  getLastActivityAt(): Date | undefined {
    return this.stats.lastActivityAt;
  }

  /**
   * Record activity - updates lastActivityAt timestamp
   * Call this during long-running operations to prevent timeouts
   */
  recordActivity(): void {
    this.stats.lastActivityAt = new Date();
    this.emit('activity', this.stats.lastActivityAt);
  }

  // ============================================
  // Helper Methods
  // ============================================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a ProcessingLoop with default configuration
 */
export function createProcessingLoop(
  processor: UnifiedProcessor,
  options?: Partial<ProcessingLoopConfig>
): ProcessingLoop {
  return new ProcessingLoop({
    processor,
    ...options,
  });
}
