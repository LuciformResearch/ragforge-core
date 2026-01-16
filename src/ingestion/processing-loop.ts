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
  /** Batch size per iteration (default: 10) */
  batchSize?: number;
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
  private batchSize: number;
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
    this.batchSize = config.batchSize ?? 10;
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
      return;
    }

    this.isRunning = true;
    this.stats.startedAt = new Date();
    this.stats.isRunning = true;

    this.emit('started');

    if (this.verbose) {
      console.log('[ProcessingLoop] Started');
    }

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
   * Stop the processing loop gracefully
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

    // Wait for current processing to complete
    while (this.isProcessing) {
      await this.sleep(100);
    }

    this.emit('stopped');

    if (this.verbose) {
      console.log('[ProcessingLoop] Stopped');
    }
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

    try {
      // 1. Process discovered files first
      const discoveredStats = await this.processor.processDiscovered({
        limit: this.batchSize,
      });

      // 2. Then process linked files (entities + embeddings)
      const linkedStats = await this.processor.processLinked({
        limit: this.batchSize,
      });

      // Aggregate stats
      const totalProcessed = discoveredStats.filesProcessed + linkedStats.filesProcessed;
      const totalSkipped = discoveredStats.filesSkipped + linkedStats.filesSkipped;
      const totalErrored = discoveredStats.filesErrored + linkedStats.filesErrored;

      this.stats.filesProcessed += totalProcessed;
      this.stats.filesSkipped += totalSkipped;
      this.stats.filesErrored += totalErrored;
      this.stats.entitiesCreated += discoveredStats.entitiesCreated + linkedStats.entitiesCreated;
      this.stats.embeddingsGenerated += discoveredStats.embeddingsGenerated + linkedStats.embeddingsGenerated;

      // Emit progress event
      if (totalProcessed > 0 || totalErrored > 0) {
        this.emit('progress', {
          processed: totalProcessed,
          skipped: totalSkipped,
          errored: totalErrored,
        });
      }

      // Adjust interval based on activity
      if (totalProcessed > 0) {
        // Busy - use short interval
        this.currentIntervalMs = this.busyIntervalMs;
        this.consecutiveIdleCount = 0;

        if (this.verbose) {
          console.log(`[ProcessingLoop] Processed ${totalProcessed} files`);
        }
      } else {
        // Idle - use exponential backoff
        this.consecutiveIdleCount++;
        this.currentIntervalMs = Math.min(
          this.idleIntervalMs * Math.pow(1.5, this.consecutiveIdleCount),
          this.maxIdleIntervalMs
        );
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
