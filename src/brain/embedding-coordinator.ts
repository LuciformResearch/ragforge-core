/**
 * Embedding Coordinator
 *
 * Coordinates embedding generation with the FileStateMachine and IngestionLock.
 * Provides a unified API for generating embeddings across different contexts:
 * - TouchedFilesWatcher (orphan files)
 * - IncrementalIngestionManager (project files)
 * - BrainManager (on-demand)
 *
 * Features:
 * - Lock acquisition/release for embedding operations
 * - State machine integration (linked → embedding → embedded)
 * - Batch processing with progress tracking
 * - Error handling with retry support
 *
 * @since 2025-12-13
 */

import type { Neo4jClient } from '../runtime/client/neo4j-client.js';
import type { EmbeddingService, MultiEmbeddingResult } from './embedding-service.js';
import type { FileStateMachine, FileStateInfo } from './file-state-machine.js';
import type { IngestionLock } from '../tools/ingestion-lock.js';

// ============================================
// Types
// ============================================

export interface EmbedProjectResult {
  /** Number of files processed */
  filesProcessed: number;
  /** Total embeddings generated */
  embeddingsGenerated: number;
  /** Files that failed */
  errors: number;
  /** Files skipped (already embedded or no changes) */
  skipped: number;
  /** Duration in ms */
  durationMs: number;
  /** Detailed embedding stats by type */
  embeddingsByType?: {
    name: number;
    content: number;
    description: number;
  };
}

export interface EmbeddingCoordinatorConfig {
  /** Neo4j client */
  neo4jClient: Neo4jClient;
  /** Embedding service */
  embeddingService: EmbeddingService;
  /** File state machine */
  stateMachine: FileStateMachine;
  /** Embedding lock (optional - for blocking RAG queries) */
  embeddingLock?: IngestionLock;
  /** Verbose logging */
  verbose?: boolean;
  /** Lock timeout in ms (default: 300000 = 5 minutes) */
  lockTimeout?: number;
}

export interface EmbedProjectOptions {
  /** Verbose logging */
  verbose?: boolean;
  /** Only embed incrementally (nodes with embeddingsDirty=true) */
  incrementalOnly?: boolean;
  /** Specific embedding types to generate */
  embeddingTypes?: ('name' | 'content' | 'description')[];
  /** Batch size for Neo4j updates */
  batchSize?: number;
  /** Skip lock acquisition (if already holding lock) */
  skipLock?: boolean;
}

// ============================================
// EmbeddingCoordinator
// ============================================

export class EmbeddingCoordinator {
  private neo4jClient: Neo4jClient;
  private embeddingService: EmbeddingService;
  private stateMachine: FileStateMachine;
  private embeddingLock?: IngestionLock;
  private verbose: boolean;
  private lockTimeout: number;

  constructor(config: EmbeddingCoordinatorConfig) {
    this.neo4jClient = config.neo4jClient;
    this.embeddingService = config.embeddingService;
    this.stateMachine = config.stateMachine;
    this.embeddingLock = config.embeddingLock;
    this.verbose = config.verbose ?? false;
    this.lockTimeout = config.lockTimeout ?? 300000; // 5 minutes
  }

  /**
   * Generate embeddings for all files in 'linked' state for a project
   *
   * This method:
   * 1. Acquires embedding lock (if configured)
   * 2. Gets files in 'linked' state
   * 3. Transitions files to 'embedding' state
   * 4. Generates embeddings via EmbeddingService
   * 5. Transitions files to 'embedded' state
   * 6. Releases lock
   *
   * @param projectId - Project ID to process
   * @param options - Embedding options
   */
  async embedProject(
    projectId: string,
    options: EmbedProjectOptions = {}
  ): Promise<EmbedProjectResult> {
    const startTime = Date.now();
    const verbose = options.verbose ?? this.verbose;

    // Check if embeddings are needed
    const needsCheck = await this.needsEmbedding(projectId);
    if (!needsCheck.needed) {
      if (verbose) {
        console.log(`[EmbeddingCoordinator] No files need embedding for project ${projectId}`);
      }
      return {
        filesProcessed: 0,
        embeddingsGenerated: 0,
        errors: 0,
        skipped: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // Acquire lock if configured and not skipped
    let lockKey: string | undefined;
    if (this.embeddingLock && !options.skipLock) {
      lockKey = this.embeddingLock.acquire('manual-ingest', `embedding:${projectId}`, {
        description: `Embedding ${needsCheck.fileCount} files for ${projectId}`,
        timeoutMs: this.lockTimeout,
      });

      if (verbose) {
        console.log(`[EmbeddingCoordinator] Acquired lock for embedding ${projectId}`);
      }
    }

    try {
      // Get files in 'linked' state
      const linkedFiles = await this.stateMachine.getFilesInState(projectId, 'linked');

      if (linkedFiles.length === 0) {
        if (verbose) {
          console.log(`[EmbeddingCoordinator] No files in 'linked' state for ${projectId}`);
        }
        return {
          filesProcessed: 0,
          embeddingsGenerated: 0,
          errors: 0,
          skipped: 0,
          durationMs: Date.now() - startTime,
        };
      }

      const fileUuids = linkedFiles.map(f => f.uuid);

      // Transition to 'embedding' state
      await this.stateMachine.transitionBatch(fileUuids, 'embedding');

      if (verbose) {
        console.log(`[EmbeddingCoordinator] Transitioning ${fileUuids.length} files to 'embedding' state`);
      }

      // Generate embeddings
      let embeddingResult: MultiEmbeddingResult;
      let errors = 0;

      try {
        embeddingResult = await this.embeddingService.generateMultiEmbeddings({
          projectId,
          incrementalOnly: options.incrementalOnly ?? true,
          embeddingTypes: options.embeddingTypes,
          batchSize: options.batchSize,
          verbose,
        });

        // Transition to 'embedded' state
        await this.stateMachine.transitionBatch(fileUuids, 'embedded');

        if (verbose) {
          console.log(
            `[EmbeddingCoordinator] Embedded ${embeddingResult.totalEmbedded} vectors ` +
            `for ${linkedFiles.length} files`
          );
        }
      } catch (err: any) {
        // Transition to error state
        await this.stateMachine.transitionBatch(fileUuids, 'error', {
          errorType: 'embed',
          errorMessage: err.message,
        });
        errors = linkedFiles.length;

        console.error(`[EmbeddingCoordinator] Error generating embeddings: ${err.message}`);

        return {
          filesProcessed: linkedFiles.length,
          embeddingsGenerated: 0,
          errors,
          skipped: 0,
          durationMs: Date.now() - startTime,
        };
      }

      return {
        filesProcessed: linkedFiles.length,
        embeddingsGenerated: embeddingResult.totalEmbedded,
        errors: 0,
        skipped: embeddingResult.skippedCount,
        durationMs: Date.now() - startTime,
        embeddingsByType: embeddingResult.embeddedByType,
      };
    } finally {
      // Release lock
      if (lockKey && this.embeddingLock) {
        this.embeddingLock.release(lockKey);
        if (verbose) {
          console.log(`[EmbeddingCoordinator] Released lock for ${projectId}`);
        }
      }
    }
  }

  /**
   * Generate embeddings for specific files
   *
   * @param projectId - Project ID
   * @param fileUuids - UUIDs of files to embed
   * @param options - Embedding options
   */
  async embedFiles(
    projectId: string,
    fileUuids: string[],
    options: EmbedProjectOptions = {}
  ): Promise<EmbedProjectResult> {
    const startTime = Date.now();
    const verbose = options.verbose ?? this.verbose;

    if (fileUuids.length === 0) {
      return {
        filesProcessed: 0,
        embeddingsGenerated: 0,
        errors: 0,
        skipped: 0,
        durationMs: 0,
      };
    }

    // Acquire lock if configured
    let lockKey: string | undefined;
    if (this.embeddingLock && !options.skipLock) {
      lockKey = this.embeddingLock.acquire('manual-ingest', `embedding:${fileUuids.length}files`, {
        description: `Embedding ${fileUuids.length} files`,
        timeoutMs: this.lockTimeout,
      });
    }

    try {
      // Transition to 'embedding' state
      await this.stateMachine.transitionBatch(fileUuids, 'embedding');

      // Generate embeddings
      let embeddingResult: MultiEmbeddingResult;

      try {
        embeddingResult = await this.embeddingService.generateMultiEmbeddings({
          projectId,
          incrementalOnly: options.incrementalOnly ?? true,
          embeddingTypes: options.embeddingTypes,
          batchSize: options.batchSize,
          verbose,
        });

        // Transition to 'embedded' state
        await this.stateMachine.transitionBatch(fileUuids, 'embedded');
      } catch (err: any) {
        // Transition to error state
        await this.stateMachine.transitionBatch(fileUuids, 'error', {
          errorType: 'embed',
          errorMessage: err.message,
        });

        return {
          filesProcessed: fileUuids.length,
          embeddingsGenerated: 0,
          errors: fileUuids.length,
          skipped: 0,
          durationMs: Date.now() - startTime,
        };
      }

      return {
        filesProcessed: fileUuids.length,
        embeddingsGenerated: embeddingResult.totalEmbedded,
        errors: 0,
        skipped: embeddingResult.skippedCount,
        durationMs: Date.now() - startTime,
        embeddingsByType: embeddingResult.embeddedByType,
      };
    } finally {
      if (lockKey && this.embeddingLock) {
        this.embeddingLock.release(lockKey);
      }
    }
  }

  /**
   * Check if embeddings are needed for a project
   *
   * @param projectId - Project ID to check
   * @returns Whether embeddings are needed and file count
   */
  async needsEmbedding(projectId: string): Promise<{
    needed: boolean;
    fileCount: number;
    linkedCount: number;
    dirtyCount: number;
  }> {
    // Count files in 'linked' state (waiting for embeddings)
    const linkedFiles = await this.stateMachine.getFilesInState(projectId, 'linked');
    const linkedCount = linkedFiles.length;

    // Count scopes with embeddingsDirty = true
    const dirtyResult = await this.neo4jClient.run(`
      MATCH (n {projectId: $projectId})
      WHERE n.embeddingsDirty = true
      RETURN count(n) as count
    `, { projectId });

    const dirtyCount = dirtyResult.records[0]?.get('count')?.toNumber?.() ||
                       dirtyResult.records[0]?.get('count') || 0;

    return {
      needed: linkedCount > 0 || dirtyCount > 0,
      fileCount: linkedCount,
      linkedCount,
      dirtyCount,
    };
  }

  /**
   * Wait for any ongoing embedding operations to complete
   *
   * @param timeoutMs - Maximum wait time (default: lockTimeout)
   * @returns true if unlocked, false if timeout
   */
  async waitForCompletion(timeoutMs?: number): Promise<boolean> {
    if (!this.embeddingLock) {
      return true;
    }

    return this.embeddingLock.waitForUnlock(timeoutMs ?? this.lockTimeout);
  }

  /**
   * Check if embedding is currently in progress
   */
  isEmbedding(): boolean {
    if (!this.embeddingLock) {
      return false;
    }
    return this.embeddingLock.isLocked();
  }

  /**
   * Get current embedding status
   */
  getStatus(): {
    isEmbedding: boolean;
    operationCount: number;
    description?: string;
  } {
    if (!this.embeddingLock) {
      return { isEmbedding: false, operationCount: 0 };
    }

    const status = this.embeddingLock.getStatus();
    return {
      isEmbedding: status.isLocked,
      operationCount: status.operationCount,
      description: status.isLocked ? this.embeddingLock.getDescription() : undefined,
    };
  }

  /**
   * Retry failed embeddings for a project
   *
   * @param projectId - Project ID
   * @param maxRetries - Maximum retry attempts per file
   * @param options - Embedding options
   */
  async retryFailed(
    projectId: string,
    maxRetries: number = 3,
    options: EmbedProjectOptions = {}
  ): Promise<EmbedProjectResult> {
    const startTime = Date.now();
    const verbose = options.verbose ?? this.verbose;

    // Get files in error state that can be retried
    const retryableFiles = await this.stateMachine.getRetryableFiles(projectId, maxRetries);
    const embedErrors = retryableFiles.filter(f => f.errorType === 'embed');

    if (embedErrors.length === 0) {
      if (verbose) {
        console.log(`[EmbeddingCoordinator] No embed errors to retry for ${projectId}`);
      }
      return {
        filesProcessed: 0,
        embeddingsGenerated: 0,
        errors: 0,
        skipped: 0,
        durationMs: Date.now() - startTime,
      };
    }

    if (verbose) {
      console.log(`[EmbeddingCoordinator] Retrying ${embedErrors.length} failed embeddings for ${projectId}`);
    }

    // Reset error files to 'linked' state for retry
    const fileUuids = embedErrors.map(f => f.uuid);
    await this.stateMachine.transitionBatch(fileUuids, 'linked');

    // Now embed them
    return this.embedFiles(projectId, fileUuids, options);
  }

  /**
   * Get embedding progress for a project
   */
  async getProgress(projectId: string): Promise<{
    total: number;
    embedded: number;
    linked: number;
    embedding: number;
    error: number;
    percentage: number;
  }> {
    const stats = await this.stateMachine.getStateStats(projectId);

    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    const embedded = stats.embedded;
    const linked = stats.linked;
    const embedding = stats.embedding;
    const error = stats.error;
    const percentage = total > 0 ? Math.round((100 * embedded) / total) : 100;

    return { total, embedded, linked, embedding, error, percentage };
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create an EmbeddingCoordinator with default configuration
 */
export function createEmbeddingCoordinator(
  neo4jClient: Neo4jClient,
  embeddingService: EmbeddingService,
  stateMachine: FileStateMachine,
  options?: {
    embeddingLock?: IngestionLock;
    verbose?: boolean;
    lockTimeout?: number;
  }
): EmbeddingCoordinator {
  return new EmbeddingCoordinator({
    neo4jClient,
    embeddingService,
    stateMachine,
    ...options,
  });
}
