/**
 * IngestionOrchestrator - Single entry point for all ingestion operations
 *
 * This class coordinates the entire ingestion flow:
 * 1. Project watchers detect file changes
 * 2. OrphanWatcher handles individual non-project files
 * 3. ChangeQueue batches changes for efficiency
 * 4. MetadataPreserver captures/restores embeddings and UUIDs
 * 5. UniversalSourceAdapter parses files
 * 6. IncrementalIngestionManager creates nodes in Neo4j
 *
 * Key simplifications over the old system:
 * - Single reingest() method instead of multiple modes
 * - Metadata preservation is always applied
 * - No more 'files'/'content'/'both' mode confusion
 */

import type { Driver } from 'neo4j-driver';
import * as path from 'path';
import { MetadataPreserver, type PreserverConfig } from './metadata-preserver.js';
import { ChangeQueue } from './change-queue.js';
import { OrphanWatcher } from './orphan-watcher.js';
import type {
  FileChange,
  ReingestOptions,
  ProjectIngestionOptions,
  IngestionStats,
  OrchestratorStatus,
  UuidMapping,
  CapturedMetadata,
} from './types.js';
import { ORPHAN_PROJECT_ID, getFileCategory } from './types.js';

/**
 * Dependencies injected into the orchestrator
 */
export interface OrchestratorDependencies {
  /** Neo4j driver for database operations */
  driver: Driver;

  /**
   * Parse files and create graph structure
   * Signature matches UniversalSourceAdapter.parse()
   */
  parseFiles: (options: {
    root: string;
    include: string[];
    projectId?: string;
    existingUUIDMapping?: UuidMapping;
    verbose?: boolean;
  }) => Promise<{
    nodes: Array<{ labels: string[]; id: string; properties: Record<string, any> }>;
    relationships: Array<{ type: string; from: string; to: string; properties?: Record<string, any> }>;
    metadata: { filesProcessed: number; nodesGenerated: number };
  }>;

  /**
   * Ingest parsed graph into Neo4j
   * Called after parsing to create/update nodes
   */
  ingestGraph: (
    graph: {
      nodes: Array<{ labels: string[]; id: string; properties: Record<string, any> }>;
      relationships: Array<{ type: string; from: string; to: string; properties?: Record<string, any> }>;
    },
    options: {
      projectId?: string;
      verbose?: boolean;
    }
  ) => Promise<void>;

  /**
   * Delete nodes for files
   * Called before re-parsing to remove old data
   */
  deleteNodesForFiles: (
    files: string[],
    projectId?: string
  ) => Promise<number>;

  /**
   * Get current embedding provider info
   */
  getEmbeddingProviderInfo?: () => { provider: string; model: string } | null;

  /**
   * Generate embeddings for dirty nodes
   * Called after ingestion to update embeddings
   */
  generateEmbeddings?: (projectId?: string) => Promise<number>;

  /**
   * Transform the parsed graph before ingestion
   * Use this to inject custom metadata on nodes (e.g., community metadata)
   * Called after parsing, before ingestGraph
   */
  transformGraph?: (graph: {
    nodes: Array<{ labels: string[]; id: string; properties: Record<string, any> }>;
    relationships: Array<{ type: string; from: string; to: string; properties?: Record<string, any> }>;
    metadata: { filesProcessed: number; nodesGenerated: number };
  }) => Promise<{
    nodes: Array<{ labels: string[]; id: string; properties: Record<string, any> }>;
    relationships: Array<{ type: string; from: string; to: string; properties?: Record<string, any> }>;
    metadata: { filesProcessed: number; nodesGenerated: number };
  }> | {
    nodes: Array<{ labels: string[]; id: string; properties: Record<string, any> }>;
    relationships: Array<{ type: string; from: string; to: string; properties?: Record<string, any> }>;
    metadata: { filesProcessed: number; nodesGenerated: number };
  };
}

/**
 * Configuration for the orchestrator
 */
export interface OrchestratorConfig {
  /** Batch interval for change queue (default: 1000ms) */
  batchIntervalMs?: number;

  /** Max batch size (default: 100) */
  maxBatchSize?: number;

  /** Max orphan files to watch (default: 100) */
  maxOrphanFiles?: number;

  /** Orphan file retention in days (default: 7) */
  orphanRetentionDays?: number;

  /** Enable verbose logging (default: false) */
  verbose?: boolean;
}

/**
 * Project watcher registration
 */
interface ProjectWatcher {
  projectId: string;
  projectPath: string;
  isWatching: boolean;
}

export class IngestionOrchestrator {
  private deps: OrchestratorDependencies;
  private config: Required<OrchestratorConfig>;

  private metadataPreserver: MetadataPreserver;
  private changeQueue: ChangeQueue;
  private orphanWatcher: OrphanWatcher;

  private projectWatchers = new Map<string, ProjectWatcher>();
  private isInitialized = false;
  private isProcessing = false;

  constructor(deps: OrchestratorDependencies, config: OrchestratorConfig = {}) {
    this.deps = deps;
    this.config = {
      batchIntervalMs: config.batchIntervalMs ?? 1000,
      maxBatchSize: config.maxBatchSize ?? 100,
      maxOrphanFiles: config.maxOrphanFiles ?? 100,
      orphanRetentionDays: config.orphanRetentionDays ?? 7,
      verbose: config.verbose ?? false,
    };

    // Get current provider info
    const providerInfo = deps.getEmbeddingProviderInfo?.();

    // Initialize components
    this.metadataPreserver = new MetadataPreserver(deps.driver, {
      verbose: this.config.verbose,
      currentProvider: providerInfo?.provider,
      currentModel: providerInfo?.model,
    });

    this.changeQueue = new ChangeQueue({
      batchIntervalMs: this.config.batchIntervalMs,
      maxBatchSize: this.config.maxBatchSize,
      onBatchReady: (changes) => this.processBatch(changes),
    });

    this.orphanWatcher = new OrphanWatcher(deps.driver, {
      maxFiles: this.config.maxOrphanFiles,
      retentionDays: this.config.orphanRetentionDays,
    });
  }

  /**
   * Initialize the orchestrator
   * Must be called before using
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Initialize orphan watcher (loads persisted files)
    await this.orphanWatcher.initialize();

    // Set up orphan watcher to queue changes
    this.orphanWatcher.onFileChange((change) => {
      this.changeQueue.add(change);
    });

    this.isInitialized = true;

    if (this.config.verbose) {
      console.log('[Orchestrator] Initialized');
    }
  }

  /**
   * Re-ingest files with full metadata preservation
   *
   * This is the main entry point for re-ingestion.
   * It handles:
   * 1. Capturing existing metadata (UUIDs, embeddings)
   * 2. Deleting old nodes
   * 3. Parsing files
   * 4. Creating new nodes
   * 5. Restoring metadata
   * 6. Generating embeddings for changed content
   */
  async reingest(
    changes: FileChange[],
    options: ReingestOptions = {}
  ): Promise<IngestionStats> {
    const { projectId, generateEmbeddings = true, verbose = this.config.verbose } = options;

    const startTime = Date.now();
    const stats: IngestionStats = {
      unchanged: 0,
      updated: 0,
      created: 0,
      deleted: 0,
      nodesCreated: 0,
      nodesUpdated: 0,
      embeddingsGenerated: 0,
      embeddingsPreserved: 0,
      warnings: [],
      errors: [],
    };

    if (changes.length === 0) {
      return stats;
    }

    // Group changes by type
    const creates = changes.filter(c => c.changeType === 'created');
    const updates = changes.filter(c => c.changeType === 'updated');
    const deletes = changes.filter(c => c.changeType === 'deleted');

    if (verbose) {
      console.log(`\n🔄 Re-ingesting ${changes.length} files...`);
      console.log(`   Creates: ${creates.length}, Updates: ${updates.length}, Deletes: ${deletes.length}`);
    }

    try {
      // Step 1: Capture metadata BEFORE any deletions
      const filesToCapture = [...updates, ...deletes].map(c => this.getRelativePath(c.path, projectId));
      const captured = await this.metadataPreserver.captureForFiles(filesToCapture, projectId);

      // Update provider info in preserver (in case it changed)
      const providerInfo = this.deps.getEmbeddingProviderInfo?.();
      if (providerInfo) {
        this.metadataPreserver.setProviderInfo(providerInfo.provider, providerInfo.model);
      }

      // Step 2: Delete nodes for updated/deleted files
      const filesToDelete = [...updates, ...deletes].map(c => c.path);
      if (filesToDelete.length > 0) {
        const deletedCount = await this.deps.deleteNodesForFiles(filesToDelete, projectId);
        stats.deleted = deletedCount;

        if (verbose) {
          console.log(`   🗑️ Deleted ${deletedCount} nodes`);
        }
      }

      // Step 3: Parse and ingest creates + updates
      const filesToParse = [...creates, ...updates].map(c => c.path);
      if (filesToParse.length > 0) {
        // Get UUID mapping for parser to reuse UUIDs
        const uuidMapping = this.metadataPreserver.getUuidMapping(captured);

        // Find root path (common ancestor of all files)
        const rootPath = this.findCommonRoot(filesToParse);

        // Parse files
        let graph = await this.deps.parseFiles({
          root: rootPath,
          include: filesToParse.map(f => this.getRelativePath(f, undefined, rootPath)),
          projectId,
          existingUUIDMapping: uuidMapping,
          verbose,
        });

        // Apply graph transformation if provided (e.g., inject custom metadata)
        if (this.deps.transformGraph) {
          graph = await this.deps.transformGraph(graph);
        }

        // Ingest into Neo4j
        await this.deps.ingestGraph(graph, { projectId, verbose });

        stats.nodesCreated = graph.metadata.nodesGenerated;
        stats.created = creates.length;
        stats.updated = updates.length;

        if (verbose) {
          console.log(`   📦 Created ${graph.metadata.nodesGenerated} nodes from ${graph.metadata.filesProcessed} files`);
        }
      }

      // Step 4: Restore metadata
      const restoreResult = await this.metadataPreserver.restoreMetadata(captured);
      stats.embeddingsPreserved = restoreResult.embeddingsRestored;

      if (verbose && restoreResult.embeddingsRestored > 0) {
        console.log(`   ♻️ Restored ${restoreResult.embeddingsRestored} embeddings`);
      }

      // Step 5: Generate embeddings for dirty nodes
      if (generateEmbeddings && this.deps.generateEmbeddings) {
        const generated = await this.deps.generateEmbeddings(projectId);
        stats.embeddingsGenerated = generated;

        if (verbose && generated > 0) {
          console.log(`   🧠 Generated ${generated} new embeddings`);
        }
      }

      stats.durationMs = Date.now() - startTime;

      if (verbose) {
        console.log(`   ✅ Re-ingestion complete in ${stats.durationMs}ms`);
      }

      return stats;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      stats.errors!.push(errorMsg);
      console.error(`[Orchestrator] Re-ingestion error:`, error);
      throw error;
    }
  }

  /**
   * Queue changes for batched processing
   * Use this when you want changes to be batched before processing
   */
  queueChanges(changes: FileChange[]): void {
    this.changeQueue.addBatch(changes);
  }

  /**
   * Queue a single change
   */
  queueChange(change: FileChange): void {
    this.changeQueue.add(change);
  }

  /**
   * Watch an orphan file (not part of any project)
   * Call this when a file is read via tools but isn't in a project
   */
  async watchOrphanFile(filePath: string): Promise<boolean> {
    return this.orphanWatcher.watch(filePath);
  }

  /**
   * Stop watching an orphan file
   */
  async unwatchOrphanFile(filePath: string): Promise<void> {
    return this.orphanWatcher.unwatch(filePath);
  }

  /**
   * Register a project watcher
   * Call this when a project watcher is started elsewhere
   */
  registerProjectWatcher(projectId: string, projectPath: string): void {
    this.projectWatchers.set(projectId, {
      projectId,
      projectPath,
      isWatching: true,
    });
  }

  /**
   * Unregister a project watcher
   */
  unregisterProjectWatcher(projectId: string): void {
    this.projectWatchers.delete(projectId);
  }

  /**
   * Get the current status
   */
  getStatus(): OrchestratorStatus {
    const orphanStats = this.orphanWatcher.getStats();
    const queueStatus = this.changeQueue.getStatus();
    const providerInfo = this.deps.getEmbeddingProviderInfo?.();

    return {
      projectWatchers: Array.from(this.projectWatchers.values()),
      orphanWatcher: {
        isActive: orphanStats.watchedCount > 0,
        watchedFilesCount: orphanStats.watchedCount,
        maxFiles: orphanStats.maxFiles,
      },
      queue: queueStatus,
      embeddingProvider: providerInfo?.provider,
      embeddingModel: providerInfo?.model,
    };
  }

  /**
   * Cleanup stale orphan files
   */
  async cleanupStaleOrphans(): Promise<number> {
    return this.orphanWatcher.cleanupStale();
  }

  /**
   * Flush pending changes immediately
   */
  async flushQueue(): Promise<void> {
    await this.changeQueue.flushNow();
  }

  /**
   * Stop the orchestrator
   */
  async stop(): Promise<void> {
    this.changeQueue.stop();
    await this.orphanWatcher.stop();
    this.isInitialized = false;
  }

  // =========================================================================
  // Private methods
  // =========================================================================

  /**
   * Process a batch of changes
   * Called by ChangeQueue when batch is ready
   */
  private async processBatch(changes: FileChange[]): Promise<void> {
    if (this.isProcessing) {
      // Re-queue if already processing
      this.changeQueue.addBatch(changes);
      return;
    }

    this.isProcessing = true;

    try {
      // Group by project
      const byProject = new Map<string, FileChange[]>();
      for (const change of changes) {
        const projectId = change.projectId || ORPHAN_PROJECT_ID;
        const existing = byProject.get(projectId) || [];
        existing.push(change);
        byProject.set(projectId, existing);
      }

      // Process each project's changes
      for (const [projectId, projectChanges] of byProject) {
        await this.reingest(projectChanges, {
          projectId: projectId === ORPHAN_PROJECT_ID ? undefined : projectId,
          verbose: this.config.verbose,
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Get relative path for a file
   */
  private getRelativePath(absolutePath: string, projectId?: string, rootPath?: string): string {
    // If we have a root path, use it
    if (rootPath) {
      return path.relative(rootPath, absolutePath);
    }

    // Otherwise, find the project's root
    if (projectId) {
      const watcher = this.projectWatchers.get(projectId);
      if (watcher) {
        return path.relative(watcher.projectPath, absolutePath);
      }
    }

    // Fallback: return the basename
    return path.basename(absolutePath);
  }

  /**
   * Find the common root directory for a set of files
   */
  private findCommonRoot(files: string[]): string {
    if (files.length === 0) return process.cwd();
    if (files.length === 1) {
      return path.dirname(files[0]);
    }

    // Split all paths into segments
    const segments = files.map(f => f.split(path.sep));

    // Find common prefix
    const firstPath = segments[0];
    let commonLength = 0;

    for (let i = 0; i < firstPath.length; i++) {
      const segment = firstPath[i];
      const allMatch = segments.every(s => s[i] === segment);
      if (allMatch) {
        commonLength = i + 1;
      } else {
        break;
      }
    }

    // Build common path
    const commonPath = firstPath.slice(0, commonLength).join(path.sep);

    // Ensure it's a directory (not a file)
    return commonPath || path.sep;
  }
}

/**
 * Create an orchestrator with default dependencies from BrainManager
 */
export function createOrchestrator(
  deps: OrchestratorDependencies,
  config?: OrchestratorConfig
): IngestionOrchestrator {
  return new IngestionOrchestrator(deps, config);
}
