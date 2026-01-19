/**
 * UnifiedProcessor - Single unified ingestion pipeline
 *
 * Replaces all separate ingestion paths with one processor using proper state machines.
 * All files (project files, orphan files, virtual files) go through the same pipeline.
 *
 * Pipeline stages:
 *   discovered → parsing → parsed → linking → linked → entities → embedding → ready
 *
 * Features:
 * - Hash pre-parsing (skip unchanged files)
 * - Metadata preservation (UUIDs, embeddings)
 * - Entity extraction (GLiNER)
 * - Multi-embedding generation (name, content, description)
 * - Chunking for large content
 * - State machine recovery after crash
 * - Retry logic with backoff
 *
 * @since 2026-01-16 - Created as part of unification effort
 */

import type { Driver } from 'neo4j-driver';
import pLimit from 'p-limit';
import * as fs from 'fs/promises';
import type { Neo4jClient } from '../runtime/client/neo4j-client.js';
import { FileStateMachine, type FileState, type FileStateInfo } from '../brain/file-state-machine.js';
import { NodeStateMachine } from './node-state-machine.js';
import { MetadataPreserver, type PreserverConfig } from './metadata-preserver.js';
import { FileProcessor, type FileInfo, type ProcessResult } from '../brain/file-processor.js';
import { EmbeddingService, type GenerateMultiEmbeddingsOptions } from '../brain/embedding-service.js';
import { EntityExtractionClient } from './entity-extraction/client.js';
import { createEntityExtractionTransform } from './entity-extraction/transform.js';
import type { NodeState } from './state-types.js';
import { type ErrorType } from '../brain/file-state-machine.js';
import { resolvePendingImports } from '../brain/reference-extractor.js';
import {
  type IContentProvider,
  type ContentSourceType,
  type ContentFileInfo,
  createContentProvider,
} from '../brain/content-provider.js';
import type { VirtualFile, ParserOptionsConfig } from '../runtime/adapters/types.js';
import * as crypto from 'crypto';

// ============================================
// Types
// ============================================

export interface UnifiedProcessorConfig {
  /** Neo4j driver for direct queries */
  driver: Driver;
  /** Neo4j client for managed queries */
  neo4jClient: Neo4jClient;
  /** GLiNER service URL */
  glinerServiceUrl?: string;
  /** Project ID */
  projectId: string;
  /** Project root path */
  projectRoot?: string;
  /** Verbose logging */
  verbose?: boolean;
  /** Max retries for errors */
  maxRetries?: number;
  /** Concurrency limit for parallel processing (default: 10) */
  concurrency?: number;
  /** Pre-configured embedding service (optional, will create one if not provided) */
  embeddingService?: EmbeddingService;
  /** Activity callback - called during long-running operations to signal liveness */
  onActivity?: () => void;
  /**
   * Content source type for file content reading
   * - 'disk': Read from file system (default)
   * - 'virtual': Read from Neo4j _rawContent (for virtual projects)
   */
  contentSourceType?: ContentSourceType;
  /** Pre-configured content provider (optional, will create one if not provided) */
  contentProvider?: IContentProvider;
  /**
   * Parser-specific options for documents and media files.
   * These options are passed to DocumentParser and MediaParser for Vision-enhanced parsing.
   */
  parserOptions?: ParserOptionsConfig;
}

export interface ProcessingStats {
  /** Files processed in this run */
  filesProcessed: number;
  /** Files skipped (unchanged) */
  filesSkipped: number;
  /** Files that errored */
  filesErrored: number;
  /** Total scopes created */
  scopesCreated: number;
  /** Total entities extracted */
  entitiesCreated: number;
  /** Total relations extracted between entities */
  relationsCreated: number;
  /** Total embeddings generated */
  embeddingsGenerated: number;
  /** Processing duration in ms */
  durationMs: number;
}

export interface RecoveryStats {
  /** Files recovered from stuck states */
  filesRecovered: number;
  /** Files still in error state */
  filesInError: number;
  /** States reset */
  statesReset: number;
}

// ============================================
// UnifiedProcessor
// ============================================

export class UnifiedProcessor {
  private driver: Driver;
  private neo4jClient: Neo4jClient;
  private fileStateMachine: FileStateMachine;
  private nodeStateMachine: NodeStateMachine;
  private metadataPreserver: MetadataPreserver;
  private fileProcessor: FileProcessor;
  private embeddingService: EmbeddingService;
  private entityClient: EntityExtractionClient;
  private projectId: string;
  private projectRoot?: string;
  private verbose: boolean;
  private maxRetries: number;
  private concurrency: number;
  private onActivity?: () => void;
  private contentProvider: IContentProvider;
  private contentSourceType: ContentSourceType;
  private parserOptions?: ParserOptionsConfig;

  constructor(config: UnifiedProcessorConfig) {
    this.driver = config.driver;
    this.neo4jClient = config.neo4jClient;
    this.projectId = config.projectId;
    this.projectRoot = config.projectRoot;
    this.verbose = config.verbose ?? false;
    this.maxRetries = config.maxRetries ?? 3;
    this.concurrency = config.concurrency ?? 10;
    this.onActivity = config.onActivity;
    this.contentSourceType = config.contentSourceType ?? 'disk';
    this.parserOptions = config.parserOptions;

    // Initialize content provider (for reading file content from disk or Neo4j)
    this.contentProvider = config.contentProvider ||
      createContentProvider(
        this.contentSourceType,
        config.neo4jClient,
        config.projectId
      );

    // Initialize state machines
    this.fileStateMachine = new FileStateMachine(config.neo4jClient);
    this.nodeStateMachine = new NodeStateMachine(config.neo4jClient);

    // Initialize metadata preserver
    this.metadataPreserver = new MetadataPreserver(config.driver, {
      verbose: config.verbose,
    });

    // Initialize file processor (handles parsing + linking)
    // Pass content provider for virtual file support
    this.fileProcessor = new FileProcessor({
      neo4jClient: config.neo4jClient,
      projectId: config.projectId,
      projectRoot: config.projectRoot,
      verbose: config.verbose,
      contentProvider: this.contentProvider,
      contentSourceType: this.contentSourceType,
      parserOptions: config.parserOptions,
    });

    // Use provided embedding service or create a basic one (without provider config)
    this.embeddingService = config.embeddingService || new EmbeddingService(config.neo4jClient);
    if (config.embeddingService) {
      console.log(`[UnifiedProcessor] Using provided EmbeddingService (canGenerate=${this.embeddingService.canGenerateEmbeddings()})`);
    }

    // Initialize entity extraction client
    const glinerUrl = config.glinerServiceUrl || 'http://localhost:6971';
    this.entityClient = new EntityExtractionClient({
      serviceUrl: glinerUrl,
    });
    console.log(`[UnifiedProcessor] Entity extraction client initialized: ${glinerUrl}`);
  }

  /**
   * Signal activity for timeout reset
   * Call this during long-running operations to prevent timeouts
   */
  private signalActivity(): void {
    if (this.onActivity) {
      this.onActivity();
    }
  }

  /**
   * Set the activity callback (called during long-running operations)
   * This allows injecting the callback after creation
   */
  setOnActivity(callback: () => void): void {
    this.onActivity = callback;
  }

  // ============================================
  // Main Processing Methods
  // ============================================

  /**
   * Process all files in 'discovered' state (batch parsing to 'linked')
   *
   * This method uses batch processing for optimal performance:
   * - Single adapter.parse() call for all files
   * - Parallel file reading and hash checking
   * - Batch state transitions
   *
   * Files are processed up to 'linked' state. Call processLinked() afterwards
   * to complete entity extraction and embedding generation.
   */
  async processDiscovered(): Promise<ProcessingStats> {
    const startTime = Date.now();

    // Get ALL files in discovered state
    console.log(`[UnifiedProcessor] Getting files in 'discovered' state for project ${this.projectId}...`);
    const discoveredFiles = await this.fileStateMachine.getFilesInState(
      this.projectId,
      'discovered'
    );
    console.log(`[UnifiedProcessor] Found ${discoveredFiles.length} files in 'discovered' state`);

    if (discoveredFiles.length === 0) {
      return this.emptyStats(startTime);
    }

    // Process ALL discovered files at once (adapter handles batching internally)
    const filesToProcess = discoveredFiles;

    console.log(`[UnifiedProcessor] 🚀 Processing ALL ${filesToProcess.length} discovered files`);

    // Convert FileStateInfo to FileInfo for batch processing
    const fileInfos: FileInfo[] = filesToProcess.map(f => ({
      absolutePath: this.resolveAbsolutePath(f.file),
      uuid: f.uuid,
      state: 'discovered' as const,
    }));

    // Use batch processing (single adapter.parse() call)
    const batchResult = await this.fileProcessor.processBatchFiles(fileInfos);

    // Resolve any PENDING_IMPORT relations now that all scopes exist
    // This converts PENDING_IMPORT → CONSUMES for cross-file references
    const pendingResult = await resolvePendingImports(this.neo4jClient, this.projectId);
    if (pendingResult.resolved > 0) {
      console.log(`[UnifiedProcessor] Resolved ${pendingResult.resolved} pending imports, ${pendingResult.remaining} remaining`);
    }

    // Capture metadata before entity extraction (for files that succeeded)
    // This is done lazily when processLinked() is called

    const stats: ProcessingStats = {
      filesProcessed: batchResult.processed,
      filesSkipped: batchResult.skipped,
      filesErrored: batchResult.errors,
      scopesCreated: batchResult.totalScopesCreated,
      entitiesCreated: 0, // Done in processLinked()
      relationsCreated: 0, // Done in processLinked()
      embeddingsGenerated: 0, // Done in processLinked()
      durationMs: Date.now() - startTime,
    };

    console.log(`[UnifiedProcessor] ✅ Discovered processing: ${stats.filesProcessed} parsed, ${stats.scopesCreated} scopes (${stats.durationMs}ms)`);

    return stats;
  }

  /**
   * Process files in 'linked' state through entity extraction and embedding (parallel with batch transitions)
   */
  async processLinked(): Promise<ProcessingStats> {
    const startTime = Date.now();

    // Get ALL files in linked state
    const linkedFiles = await this.fileStateMachine.getFilesInState(
      this.projectId,
      'linked'
    );

    if (linkedFiles.length === 0) {
      return this.emptyStats(startTime);
    }

    // Process ALL linked files (concurrency is controlled by pLimit)
    const filesToProcess = linkedFiles;

    console.log(`[UnifiedProcessor] 🚀 Processing ALL ${filesToProcess.length} linked files (concurrency=${this.concurrency})`);

    const limit = pLimit(this.concurrency);

    // Track successful and failed files
    const successfulFiles: FileStateInfo[] = [];
    const failedFiles: Array<{ file: FileStateInfo; error: Error }> = [];

    // 1. Check GLiNER availability ONCE (not per file)
    const glinerConfig = this.entityClient.getConfig();
    console.log(`[UnifiedProcessor] 🔍 Checking GLiNER availability at ${glinerConfig.serviceUrl}...`);
    const glinerAvailable = await this.entityClient.isAvailable();
    if (glinerAvailable) {
      const health = await this.entityClient.getHealth();
      console.log(`[UnifiedProcessor] ✅ GLiNER available: model=${health?.model_name}, device=${health?.device}`);
      // Load model to GPU before extraction
      console.log(`[UnifiedProcessor] 🔄 Loading GLiNER model to GPU...`);
      const loadResult = await this.entityClient.loadModel();
      if (loadResult.loaded) {
        console.log(`[UnifiedProcessor] ✅ GLiNER model loaded${loadResult.wasAlreadyLoaded ? ' (was already loaded)' : ''}`);
      } else {
        console.log(`[UnifiedProcessor] ⚠️ Failed to load GLiNER model, extraction may be slow`);
      }
    } else {
      console.log(`[UnifiedProcessor] ❌ GLiNER not available at ${glinerConfig.serviceUrl}, skipping entity extraction`);
    }

    // 2. Batch fetch ALL nodes for entity extraction in ONE query (not per file)
    const nodesByFile = glinerAvailable
      ? await this.getAllNodesForEntityExtractionBatch()
      : new Map();

    if (glinerAvailable) {
      const totalNodes = Array.from(nodesByFile.values()).reduce((sum, nodes) => sum + nodes.length, 0);
      console.log(`[UnifiedProcessor] 📊 Fetched ${totalNodes} nodes for entity extraction (${nodesByFile.size} files with content)`);
    }

    // 3. Batch transition to 'entities'
    await this.fileStateMachine.transitionBatch(
      filesToProcess.map(f => f.uuid),
      'entities'
    );

    // 4. DOMAIN-BASED entity extraction
    // Phase 1: Classify files by domain
    // Phase 2: Group nodes by their file's domain
    // Phase 3: Extract entities per domain with domain-specific entity types
    let totalEntitiesCreated = 0;
    let totalRelationsCreated = 0;

    if (glinerAvailable) {
      // Flatten all nodes into a single array with file tracking
      const allNodes: Array<{ uuid: string; content: string; label: string; filePath: string; contentHash: string }> = [];
      for (const [filePath, nodes] of nodesByFile) {
        for (const node of nodes) {
          allNodes.push({ ...node, filePath });
        }
      }

      if (allNodes.length > 0) {
        // Get unique file paths
        const uniqueFilePaths = Array.from(new Set(allNodes.map(n => n.filePath)));
        console.log(`[UnifiedProcessor] 🔍 Classifying ${uniqueFilePaths.length} files by domain...`);

        // Phase 1: Read file contents and classify domains
        // Store ALL domains per file (not just primary) as a sorted combo key
        const fileDomainCombo = new Map<string, string>(); // filePath -> "domain1|domain2|..."
        const fileContents: string[] = [];
        const validFilePaths: string[] = [];

        for (const filePath of uniqueFilePaths) {
          try {
            // Use content provider to support both disk and virtual files
            const content = await this.readFileContent(filePath);
            // Use first 2000 chars for classification (domain detection needs context)
            fileContents.push(content.slice(0, 2000));
            validFilePaths.push(filePath);
          } catch (error) {
            // File might not exist anymore, use default domain
            fileDomainCombo.set(filePath, 'default');
            if (this.verbose) {
              console.warn(`[UnifiedProcessor] Could not read file for classification: ${filePath}`);
            }
          }
        }

        // Batch classify files
        if (fileContents.length > 0) {
          try {
            this.signalActivity();
            const classifications = await this.entityClient.classifyDomainsBatch(fileContents, 0.3);
            this.signalActivity();

            for (let i = 0; i < validFilePaths.length; i++) {
              const domains = classifications[i] || [];
              // Create sorted combo key from all detected domains (e.g., "legal|tech")
              const domainLabels = domains.map(d => d.label).filter(Boolean);
              const comboKey = domainLabels.length > 0
                ? domainLabels.sort().join('|')
                : 'default';
              fileDomainCombo.set(validFilePaths[i], comboKey);
            }

            // Log domain combo distribution
            const comboCounts = new Map<string, number>();
            for (const combo of fileDomainCombo.values()) {
              comboCounts.set(combo, (comboCounts.get(combo) || 0) + 1);
            }
            console.log(`[UnifiedProcessor] 📊 File domain combos: ${Array.from(comboCounts.entries()).map(([c, n]) => `"${c}"=${n}`).join(', ')}`);
          } catch (error: any) {
            console.warn(`[UnifiedProcessor] ⚠️ Domain classification failed, using default: ${error.message}`);
            for (const filePath of validFilePaths) {
              fileDomainCombo.set(filePath, 'default');
            }
          }
        }

        // Phase 2: Group nodes by their file's domain combo
        const nodesByDomainCombo = new Map<string, typeof allNodes>();
        for (const node of allNodes) {
          const combo = fileDomainCombo.get(node.filePath) || 'default';
          if (!nodesByDomainCombo.has(combo)) {
            nodesByDomainCombo.set(combo, []);
          }
          nodesByDomainCombo.get(combo)!.push(node);
        }

        // Get disabled domains (enabled: false in config) - these are detected but extraction is skipped
        const disabledDomains = await this.entityClient.getDisabledDomains();
        if (disabledDomains.size > 0) {
          console.log(`[UnifiedProcessor] ⏭️ Disabled domains (extraction skipped): ${Array.from(disabledDomains).join(', ')}`);
        }

        console.log(`[UnifiedProcessor] 🚀 Starting DOMAIN-BASED entity extraction: ${allNodes.length} nodes across ${nodesByDomainCombo.size} domain combo(s)`);

        // Phase 3: Extract entities per domain combo
        // Each combo gets merged entity_types from all its domains
        let skippedNodes = 0;
        for (const [comboKey, comboNodes] of nodesByDomainCombo) {
          const domains = comboKey.split('|'); // e.g., "legal|tech" -> ["legal", "tech"]

          // Filter out disabled domains from the combo
          const enabledDomains = domains.filter(d => !disabledDomains.has(d));

          // If ALL domains in the combo are disabled, skip extraction entirely
          if (enabledDomains.length === 0 && comboKey !== 'default') {
            console.log(`[UnifiedProcessor] ⏭️ Skipping "${comboKey}": all domains disabled (${comboNodes.length} nodes)`);
            skippedNodes += comboNodes.length;

            // Mark these nodes as processed so they won't be re-selected for extraction
            await this.markNodesBatchEntityHashUpdated(comboNodes);

            continue;
          }

          // Use enabled domains for extraction, or 'default' if none
          const extractionDomains = enabledDomains.length > 0 ? enabledDomains : ['default'];

          const BATCH_SIZE = 1000;
          const totalBatches = Math.ceil(comboNodes.length / BATCH_SIZE);

          console.log(`[UnifiedProcessor] 🏷️ Domain combo "${comboKey}": ${comboNodes.length} nodes in ${totalBatches} batch(es)${enabledDomains.length < domains.length ? ` (using: ${extractionDomains.join('|')})` : ''}`);

          for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
            const batchStart = batchIdx * BATCH_SIZE;
            const batchNodes = comboNodes.slice(batchStart, batchStart + BATCH_SIZE);

            try {
              this.signalActivity();
              const batchResult = await this.extractEntitiesGlobalBatchWithDomains(batchNodes, extractionDomains);
              this.signalActivity();
              totalEntitiesCreated += batchResult.entitiesCreated;
              totalRelationsCreated += batchResult.relationsCreated;

              console.log(`[UnifiedProcessor] ✅ [${comboKey}] Batch ${batchIdx + 1}/${totalBatches}: ${batchResult.entitiesCreated} entities, ${batchResult.relationsCreated} relations`);
            } catch (error: any) {
              console.error(`[UnifiedProcessor] ❌ [${comboKey}] Batch ${batchIdx + 1}/${totalBatches} failed: ${error.message}`);
            }
          }
        }

        if (skippedNodes > 0) {
          console.log(`[UnifiedProcessor] ⏭️ Total nodes skipped (disabled domains): ${skippedNodes}`);
        }
      }

      // Unload GLiNER model from GPU to free VRAM for Ollama embeddings
      console.log(`[UnifiedProcessor] 🔄 Unloading GLiNER model from GPU...`);
      const unloadResult = await this.entityClient.unloadModel();
      if (unloadResult.unloaded) {
        console.log(`[UnifiedProcessor] ✅ GLiNER model unloaded, GPU memory freed for embeddings`);
      }
    }

    // All files that had nodes processed are considered successful
    const entitySuccesses: Array<{ file: FileStateInfo; result: { entitiesCreated: number; relationsCreated: number } }> = [];
    for (const file of filesToProcess) {
      const hasNodes = nodesByFile.has(file.file) && nodesByFile.get(file.file)!.length > 0;
      entitySuccesses.push({
        file,
        result: { entitiesCreated: hasNodes ? 1 : 0, relationsCreated: 0 }, // Simplified - actual counts are global
      });
      successfulFiles.push(file);
    }

    if (successfulFiles.length === 0) {
      return {
        filesProcessed: 0,
        filesSkipped: 0,
        filesErrored: failedFiles.length,
        scopesCreated: 0,
        entitiesCreated: totalEntitiesCreated,
        relationsCreated: totalRelationsCreated,
        embeddingsGenerated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // 3. Batch transition successful files to 'embedding'
    await this.fileStateMachine.transitionBatch(
      successfulFiles.map(f => f.uuid),
      'embedding'
    );

    // 4. Generate embeddings ONCE for all nodes (not per-file)
    // generateEmbeddingsForFile generates embeddings for the entire project,
    // so we only need to call it once after all files are processed
    let totalEmbeddings = 0;
    const embeddingSuccesses: FileStateInfo[] = [];
    const embeddingFailed: Array<{ file: FileStateInfo; error: Error }> = [];

    try {
      const embeddingResult = await this.generateEmbeddingsForFile('batch');
      totalEmbeddings = embeddingResult.embeddingsGenerated;
      embeddingSuccesses.push(...successfulFiles);
    } catch (error: any) {
      // If embedding fails, mark all files as failed
      for (const file of successfulFiles) {
        embeddingFailed.push({ file, error });
        await this.fileStateMachine.transition(file.uuid, 'error', {
          errorType: 'embed',
          errorMessage: error.message,
        });
        if (this.verbose) {
          console.error(`[UnifiedProcessor] Embedding failed for ${file.file}: ${error.message}`);
        }
      }
    }

    // 5. Batch transition to 'embedded'
    if (embeddingSuccesses.length > 0) {
      await this.fileStateMachine.transitionBatch(
        embeddingSuccesses.map(f => f.uuid),
        'embedded'
      );
    }

    // Aggregate stats
    const stats = this.aggregateLinkedStats(
      entitySuccesses.map(e => e.result),
      totalEmbeddings,
      embeddingSuccesses.length,
      failedFiles.length + embeddingFailed.length,
      startTime
    );

    console.log(`[UnifiedProcessor] ✅ Linked processing: ${stats.filesProcessed} files, ${stats.entitiesCreated} entities, ${stats.embeddingsGenerated} embeddings (${stats.durationMs}ms)`);

    return stats;
  }

  /**
   * Aggregate results from parallel linked processing
   */
  private aggregateLinkedStats(
    entityResults: Array<{ entitiesCreated: number; relationsCreated: number }>,
    totalEmbeddings: number,
    filesProcessed: number,
    filesErrored: number,
    startTime: number
  ): ProcessingStats {
    let entitiesCreated = 0;
    let relationsCreated = 0;

    for (const result of entityResults) {
      entitiesCreated += result.entitiesCreated;
      relationsCreated += result.relationsCreated;
    }

    return {
      filesProcessed,
      filesSkipped: 0,
      filesErrored,
      scopesCreated: 0,
      entitiesCreated,
      relationsCreated,
      embeddingsGenerated: totalEmbeddings,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Process nodes directly (not via Files) for embedding generation.
   *
   * This handles the case where:
   * - A file was re-parsed and its nodes updated to _state='linked'
   * - But the File itself remained _state='embedded'
   * - So processLinked() didn't find the File
   *
   * This method generates embeddings for any nodes with _state='linked',
   * regardless of their parent File's state.
   */
  async processLinkedNodes(): Promise<{ nodesProcessed: number; embeddingsGenerated: number }> {
    // FIRST: Mark filtered Entity types as 'embedded' BEFORE checking for linked nodes
    // These are entities like price, date, quantity, etc. that don't need embeddings
    // This prevents infinite loop where skip types are found but never processed
    const skipEmbeddingTypes = await this.entityClient.getSkipEmbeddingTypes();
    const skipMarkedResult = await this.neo4jClient.run(`
      MATCH (e:Entity {projectId: $projectId})
      WHERE e._state = 'linked'
        AND e.entityType IN $skipTypes
      SET e._state = 'embedded'
      RETURN count(e) AS marked
    `, { projectId: this.projectId, skipTypes: skipEmbeddingTypes });

    const skipMarkedCount = skipMarkedResult.records[0]?.get('marked')?.toNumber?.() ?? 0;
    if (skipMarkedCount > 0) {
      console.log(`[UnifiedProcessor] 📝 Pre-marked ${skipMarkedCount} skip-embedding Entity types as embedded`);
    }

    // Check if there are nodes needing embedding - get details for debugging
    // Note: File is excluded because it's processed in Phase 1/2
    // Directory, ExternalURL, etc. are now included (they have embedding configs)
    // Project is excluded because it doesn't need embedding
    const nodesWithLinkedState = await this.neo4jClient.run(`
      MATCH (n)
      WHERE n.projectId = $projectId
        AND n._state = 'linked'
        AND NOT n:File AND NOT n:Project
      RETURN labels(n)[0] as label, n.uuid as uuid, n._name as name, n.file as file,
             n.embedding_name IS NOT NULL as hasNameEmb,
             n.embedding_content IS NOT NULL as hasContentEmb,
             n.usesChunks as usesChunks,
             n.embeddingsDirty as embeddingsDirty,
             n.embedding_name_hash as nameHash,
             n.embedding_content_hash as contentHash
      LIMIT 10
    `, { projectId: this.projectId });

    const nodeCount = nodesWithLinkedState.records.length;

    if (nodeCount === 0) {
      return { nodesProcessed: 0, embeddingsGenerated: 0 };
    }

    // Log details of the nodes found
    console.log(`[UnifiedProcessor] 🔄 Found ${nodeCount} nodes with _state='linked', details:`);
    for (const record of nodesWithLinkedState.records) {
      const label = record.get('label');
      const uuid = record.get('uuid');
      const name = record.get('name');
      const file = record.get('file');
      const hasNameEmb = record.get('hasNameEmb');
      const hasContentEmb = record.get('hasContentEmb');
      const usesChunks = record.get('usesChunks');
      const embeddingsDirty = record.get('embeddingsDirty');
      const nameHash = record.get('nameHash');
      const contentHash = record.get('contentHash');
      console.log(`  - ${label}: ${name} (file=${file}, uuid=${uuid?.substring(0, 8)}..., hasNameEmb=${hasNameEmb}, hasContentEmb=${hasContentEmb}, nameHash=${nameHash ? 'yes' : 'no'}, contentHash=${contentHash ? 'yes' : 'no'}, usesChunks=${usesChunks}, dirty=${embeddingsDirty})`);
    }

    console.log(`[UnifiedProcessor] Generating embeddings for project ${this.projectId}...`);

    // Generate embeddings for all nodes with _state='linked'
    const embeddingResult = await this.generateEmbeddingsForFile('nodes-batch');

    console.log(`[UnifiedProcessor] ✅ Processed ${nodeCount} nodes, generated ${embeddingResult.embeddingsGenerated} embeddings`);

    return {
      nodesProcessed: nodeCount,
      embeddingsGenerated: embeddingResult.embeddingsGenerated,
    };
  }

  /**
   * Process specific files through the complete pipeline (parallel with pLimit)
   */
  async processFiles(files: FileStateInfo[]): Promise<ProcessingStats> {
    const startTime = Date.now();

    if (files.length === 0) {
      return this.emptyStats(startTime);
    }

    console.log(`[UnifiedProcessor] 🚀 Starting parallel processing of ${files.length} files (concurrency=${this.concurrency})`);

    const limit = pLimit(this.concurrency);

    // Process all files in parallel with concurrency limit
    const results = await Promise.all(
      files.map(file =>
        limit(async () => {
          try {
            return await this.processFile(file);
          } catch (error: any) {
            if (this.verbose) {
              console.error(`[UnifiedProcessor] Error processing ${file.file}: ${error.message}`);
            }
            return {
              status: 'error' as const,
              scopesCreated: 0,
              entitiesCreated: 0,
              relationsCreated: 0,
              embeddingsGenerated: 0,
              error: error.message,
            };
          }
        })
      )
    );

    // Aggregate results
    const stats = this.aggregateStats(results, startTime);

    console.log(`[UnifiedProcessor] ✅ Processed ${stats.filesProcessed} files, skipped ${stats.filesSkipped}, errors ${stats.filesErrored} (${stats.durationMs}ms)`);

    return stats;
  }

  /**
   * Aggregate results from parallel file processing
   */
  private aggregateStats(
    results: Array<{
      status: 'processed' | 'skipped' | 'error';
      scopesCreated: number;
      entitiesCreated: number;
      relationsCreated: number;
      embeddingsGenerated: number;
      error?: string;
    }>,
    startTime: number
  ): ProcessingStats {
    const stats: ProcessingStats = {
      filesProcessed: 0,
      filesSkipped: 0,
      filesErrored: 0,
      scopesCreated: 0,
      entitiesCreated: 0,
      relationsCreated: 0,
      embeddingsGenerated: 0,
      durationMs: 0,
    };

    for (const result of results) {
      if (result.status === 'skipped') {
        stats.filesSkipped++;
      } else if (result.status === 'error') {
        stats.filesErrored++;
      } else {
        stats.filesProcessed++;
        stats.scopesCreated += result.scopesCreated;
        stats.entitiesCreated += result.entitiesCreated;
        stats.relationsCreated += result.relationsCreated;
        stats.embeddingsGenerated += result.embeddingsGenerated;
      }
    }

    stats.durationMs = Date.now() - startTime;
    return stats;
  }

  /**
   * Process a single file through the complete pipeline
   */
  async processFile(fileInfo: FileStateInfo): Promise<{
    status: 'processed' | 'skipped' | 'error';
    scopesCreated: number;
    entitiesCreated: number;
    relationsCreated: number;
    embeddingsGenerated: number;
    error?: string;
  }> {
    const filePath = fileInfo.file;

    try {
      // 1. Capture metadata BEFORE any changes
      const capturedMetadata = await this.metadataPreserver.captureForFiles(
        [filePath],
        this.projectId
      );

      // 2. Process through FileProcessor (discovered → linked)
      const fileProcessorInfo: FileInfo = {
        absolutePath: this.resolveAbsolutePath(filePath),
        uuid: fileInfo.uuid,
        hash: undefined, // Let FileProcessor check the hash
        state: 'discovered',
      };

      const parseResult = await this.fileProcessor.processFile(fileProcessorInfo);

      if (parseResult.status === 'skipped') {
        return {
          status: 'skipped',
          scopesCreated: 0,
          entitiesCreated: 0,
          relationsCreated: 0,
          embeddingsGenerated: 0,
        };
      }

      if (parseResult.status === 'error') {
        return {
          status: 'error',
          scopesCreated: 0,
          entitiesCreated: 0,
          relationsCreated: 0,
          embeddingsGenerated: 0,
          error: parseResult.error,
        };
      }

      // 3. Restore metadata after parsing
      await this.metadataPreserver.restoreMetadata(capturedMetadata);

      // 4. Entity extraction (with domain-based skip logic)
      await this.fileStateMachine.transition(fileInfo.uuid, 'entities');
      const entitiesResult = await this.extractEntitiesForFileSingleWithDomainCheck(filePath);

      // 5. Embedding generation
      await this.fileStateMachine.transition(fileInfo.uuid, 'embedding');
      const embeddingResult = await this.generateEmbeddingsForFile(filePath);

      // 6. Mark as complete
      await this.fileStateMachine.transition(fileInfo.uuid, 'embedded');

      return {
        status: 'processed',
        scopesCreated: parseResult.scopesCreated,
        entitiesCreated: entitiesResult.entitiesCreated,
        relationsCreated: entitiesResult.relationsCreated,
        embeddingsGenerated: embeddingResult.embeddingsGenerated,
      };

    } catch (error: any) {
      await this.fileStateMachine.transition(fileInfo.uuid, 'error', {
        errorType: this.determineErrorType(error),
        errorMessage: error.message,
      });

      return {
        status: 'error',
        scopesCreated: 0,
        entitiesCreated: 0,
        relationsCreated: 0,
        embeddingsGenerated: 0,
        error: error.message,
      };
    }
  }

  // ============================================
  // Recovery Methods
  // ============================================

  /**
   * Recover from crash - reset stuck files and retry errors
   */
  async recover(): Promise<RecoveryStats> {
    const stats: RecoveryStats = {
      filesRecovered: 0,
      filesInError: 0,
      statesReset: 0,
    };

    // 1. Reset files stuck in intermediate states
    const stuckStates: FileState[] = ['parsing', 'relations', 'entities', 'embedding'];

    for (const state of stuckStates) {
      const stuckFiles = await this.fileStateMachine.getFilesInState(this.projectId, state);

      for (const file of stuckFiles) {
        await this.fileStateMachine.transition(file.uuid, 'discovered');
        stats.statesReset++;
      }
    }

    // 2. Retry files in error state (up to maxRetries)
    const errorFiles = await this.fileStateMachine.getRetryableFiles(
      this.projectId,
      this.maxRetries
    );

    for (const file of errorFiles) {
      await this.fileStateMachine.transition(file.uuid, 'discovered');
      stats.filesRecovered++;
    }

    // 3. Count remaining errors
    const remainingErrors = await this.fileStateMachine.getFilesInState(
      this.projectId,
      'error'
    );
    stats.filesInError = remainingErrors.length;

    if (this.verbose) {
      console.log(`[UnifiedProcessor] Recovery: ${stats.statesReset} states reset, ${stats.filesRecovered} files to retry, ${stats.filesInError} still in error`);
    }

    return stats;
  }

  // ============================================
  // Entity Extraction (Batch Optimized)
  // ============================================

  /**
   * Get document nodes for a file that need entity extraction
   */
  private async getNodesForEntityExtraction(filePath: string): Promise<Array<{
    uuid: string;
    content: string;
    label: string;
    contentHash: string;
  }>> {
    const result = await this.neo4jClient.run(
      `
      MATCH (n)-[:DEFINED_IN]->(f:File)
      WHERE f.file = $filePath AND f.projectId = $projectId
        AND (n:MarkdownSection OR n:MarkdownDocument OR n:WebPage OR n:WebDocument)
        AND n._content IS NOT NULL
        AND n._state = 'linked'
        AND (n._entitiesContentHash IS NULL OR n._entitiesContentHash <> n._contentHash)
      RETURN n.uuid AS uuid, n._content AS content, labels(n)[0] AS label, n._contentHash AS contentHash
      LIMIT 100
      `,
      { filePath, projectId: this.projectId }
    );

    return result.records
      .map(r => ({
        uuid: r.get('uuid'),
        content: r.get('content'),
        label: r.get('label'),
        contentHash: r.get('contentHash') || '',
      }))
      .filter(n => n.content && n.content.length >= 50);
  }

  /**
   * Batch fetch ALL nodes for entity extraction across ALL files (single query)
   * Returns a Map of filePath -> nodes for that file
   */
  private async getAllNodesForEntityExtractionBatch(): Promise<Map<string, Array<{
    uuid: string;
    content: string;
    label: string;
    contentHash: string;
  }>>> {
    const result = await this.neo4jClient.run(
      `
      MATCH (n)-[:DEFINED_IN]->(f:File)
      WHERE f.projectId = $projectId
        AND (n:MarkdownSection OR n:MarkdownDocument OR n:WebPage OR n:WebDocument)
        AND n._content IS NOT NULL
        AND n._state = 'linked'
        AND (n._entitiesContentHash IS NULL OR n._entitiesContentHash <> n._contentHash)
      RETURN f.absolutePath AS filePath, n.uuid AS uuid, n._content AS content, labels(n)[0] AS label, n._contentHash AS contentHash
      `,
      { projectId: this.projectId }
    );

    // Group by file path
    const nodesByFile = new Map<string, Array<{ uuid: string; content: string; label: string; contentHash: string }>>();

    for (const record of result.records) {
      const filePath = record.get('filePath');
      const node = {
        uuid: record.get('uuid'),
        content: record.get('content'),
        label: record.get('label'),
        contentHash: record.get('contentHash') || '',
      };

      // Filter: content must exist and be >= 50 chars
      if (!node.content || node.content.length < 50) continue;

      if (!nodesByFile.has(filePath)) {
        nodesByFile.set(filePath, []);
      }
      nodesByFile.get(filePath)!.push(node);
    }

    return nodesByFile;
  }

  /**
   * Extract entities using pre-fetched nodes (most optimized version)
   * Nodes are passed directly - no DB query needed
   */
  private async extractEntitiesWithNodes(
    nodes: Array<{ uuid: string; content: string; label: string }>,
    glinerAvailable: boolean
  ): Promise<{ entitiesCreated: number; relationsCreated: number }> {
    if (!glinerAvailable || nodes.length === 0) {
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    // Parallel extraction with pLimit(5) for GLiNER concurrency
    const glinerLimit = pLimit(5);
    const extractions = await Promise.all(
      nodes.map(node =>
        glinerLimit(async () => {
          try {
            const result = await this.entityClient.extract(
              node.content.slice(0, 5000)
            );
            return { node, result, error: null };
          } catch (error: any) {
            if (this.verbose) {
              console.warn(`[UnifiedProcessor] Entity extraction failed for ${node.uuid}: ${(error as Error).message}`);
            }
            return { node, result: null, error };
          }
        })
      )
    );

    // Filter successful extractions
    const successfulExtractions = extractions.filter(e => e.result !== null);
    const totalEntitiesExtracted = successfulExtractions.reduce(
      (sum, e) => sum + (e.result?.entities?.length || 0), 0
    );
    const totalRelationsExtracted = successfulExtractions.reduce(
      (sum, e) => sum + (e.result?.relations?.length || 0), 0
    );

    if (this.verbose || totalEntitiesExtracted > 0) {
      console.log(`[UnifiedProcessor] 🧠 GLiNER extracted ${totalEntitiesExtracted} entities, ${totalRelationsExtracted} relations from ${successfulExtractions.length}/${nodes.length} nodes`);
    }

    if (successfulExtractions.length === 0) {
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    // Collect all entities with their source info (including label for indexed queries)
    const allEntities: Array<{
      entityId: string;
      name: string;
      entityType: string;
      confidence: number;
      sourceUuid: string;
      sourceLabel: string;
    }> = [];

    const entityMaps = new Map<string, Map<string, string>>();

    for (const { node, result } of successfulExtractions) {
      if (!result || !result.entities) continue;

      const nodeEntityMap = new Map<string, string>();
      entityMaps.set(node.uuid, nodeEntityMap);

      for (const entity of result.entities) {
        const normalizedName = entity.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const entityId = `entity:${entity.type}:${normalizedName}`;
        nodeEntityMap.set(entity.name.toLowerCase(), entityId);
        allEntities.push({
          entityId,
          name: entity.name,
          entityType: entity.type,
          confidence: entity.confidence ?? 0.5,
          sourceUuid: node.uuid,
          sourceLabel: node.label,
        });
      }
    }

    // Batch create entities with UNWIND - grouped by sourceLabel for index usage
    let entitiesCreated = 0;
    if (allEntities.length > 0) {
      // Group entities by sourceLabel to use label-specific indexes
      const entitiesByLabel = new Map<string, typeof allEntities>();
      for (const e of allEntities) {
        const group = entitiesByLabel.get(e.sourceLabel) || [];
        group.push(e);
        entitiesByLabel.set(e.sourceLabel, group);
      }

      // Run a separate query per label (uses index on Label.uuid)
      for (const [label, entities] of entitiesByLabel) {
        const entityResult = await this.neo4jClient.run(
          `
          UNWIND $entities AS entity
          MERGE (e:Entity {uuid: entity.entityId})
          ON CREATE SET
            e._name = entity.name,
            e._content = null,
            e._description = entity.entityType,
            e.entityType = entity.entityType,
            e.confidence = entity.confidence,
            e.projectId = $projectId,
            e._state = 'linked',
            e.embeddingsDirty = true
          WITH e, entity
          MATCH (n:\`${label}\` {uuid: entity.sourceUuid})
          MERGE (n)-[r:MENTIONS]->(e)
          ON CREATE SET r.confidence = entity.confidence
          RETURN count(DISTINCT e) AS created
          `,
          { entities, projectId: this.projectId }
        );

        const createdValue = entityResult.records[0]?.get('created');
        entitiesCreated += createdValue?.toNumber?.() ?? (typeof createdValue === 'number' ? createdValue : 0);
      }
    }

    // Collect and create relations (same logic as before)
    const allRelations: Array<{
      subjectId: string;
      objectId: string;
      predicate: string;
      confidence: number;
      sourceUuid: string;
    }> = [];

    for (const { node, result } of successfulExtractions) {
      if (!result || !result.relations) continue;
      const nodeEntityMap = entityMaps.get(node.uuid);
      if (!nodeEntityMap) continue;

      for (const relation of result.relations) {
        const subjectId = nodeEntityMap.get(relation.subject.toLowerCase());
        const objectId = nodeEntityMap.get(relation.object.toLowerCase());
        if (subjectId && objectId) {
          allRelations.push({
            subjectId,
            objectId,
            predicate: relation.predicate,
            confidence: relation.confidence ?? 0.5,
            sourceUuid: node.uuid,
          });
        }
      }
    }

    let relationsCreated = 0;
    if (allRelations.length > 0) {
      const relationResult = await this.neo4jClient.run(
        `
        UNWIND $relations AS rel
        MATCH (subject:Entity {uuid: rel.subjectId})
        MATCH (object:Entity {uuid: rel.objectId})
        MERGE (subject)-[r:RELATED_TO {type: rel.predicate}]->(object)
        ON CREATE SET
          r.confidence = rel.confidence,
          r.sourceNodeUuid = rel.sourceUuid,
          r.createdAt = datetime()
        ON MATCH SET
          r.confidence = CASE WHEN r.confidence < rel.confidence THEN rel.confidence ELSE r.confidence END
        RETURN count(r) AS created
        `,
        { relations: allRelations }
      );

      const relCreatedValue = relationResult.records[0]?.get('created');
      relationsCreated = relCreatedValue?.toNumber?.() ?? (typeof relCreatedValue === 'number' ? relCreatedValue : 0);
    }

    return { entitiesCreated, relationsCreated };
  }

  /**
   * GLOBAL BATCH entity extraction - processes ALL nodes in a single GLiNER batch call.
   * Much more efficient than per-file extraction.
   *
   * @param nodes - All nodes to process (with filePath for tracking)
   */
  private async extractEntitiesGlobalBatch(
    nodes: Array<{ uuid: string; content: string; label: string; filePath: string; contentHash: string }>
  ): Promise<{ entitiesCreated: number; relationsCreated: number }> {
    if (nodes.length === 0) {
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    // 1. Extract texts (truncated to 5000 chars each)
    const texts = nodes.map(n => n.content.slice(0, 5000));

    // 2. Single batch call to GLiNER (this is the long-running operation)
    const extractionStartTime = Date.now();
    const results = await this.entityClient.extractBatch(texts);
    const extractionDuration = Date.now() - extractionStartTime;
    this.signalActivity(); // Signal activity after GLiNER extraction

    const totalEntitiesExtracted = results.reduce((sum, r) => sum + (r?.entities?.length || 0), 0);
    const totalRelationsExtracted = results.reduce((sum, r) => sum + (r?.relations?.length || 0), 0);

    console.log(`[UnifiedProcessor] 🧠 GLiNER batch extracted ${totalEntitiesExtracted} entities, ${totalRelationsExtracted} relations from ${nodes.length} nodes in ${extractionDuration}ms`);

    // 3. Collect all entities with source tracking (including label for indexed queries)
    const allEntities: Array<{
      entityId: string;
      name: string;
      entityType: string;
      confidence: number;
      sourceUuid: string;
      sourceLabel: string;
    }> = [];

    const entityMaps = new Map<string, Map<string, string>>();

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const node = nodes[i];
      if (!result || !result.entities) continue;

      const nodeEntityMap = new Map<string, string>();
      entityMaps.set(node.uuid, nodeEntityMap);

      for (const entity of result.entities) {
        const normalizedName = entity.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const entityId = `entity:${entity.type}:${normalizedName}`;
        nodeEntityMap.set(entity.name.toLowerCase(), entityId);
        allEntities.push({
          entityId,
          name: entity.name,
          entityType: entity.type,
          confidence: entity.confidence ?? 0.5,
          sourceUuid: node.uuid,
          sourceLabel: node.label,
        });
      }
    }

    // 4. Batch create entities with UNWIND - grouped by sourceLabel for index usage
    let entitiesCreated = 0;
    if (allEntities.length > 0) {
      // Group entities by sourceLabel to use label-specific indexes
      const entitiesByLabel = new Map<string, typeof allEntities>();
      for (const e of allEntities) {
        const group = entitiesByLabel.get(e.sourceLabel) || [];
        group.push(e);
        entitiesByLabel.set(e.sourceLabel, group);
      }

      // Run a separate query per label (uses index on Label.uuid)
      for (const [label, entities] of entitiesByLabel) {
        const entityResult = await this.neo4jClient.run(
          `
          UNWIND $entities AS entity
          MERGE (e:Entity {uuid: entity.entityId})
          ON CREATE SET
            e._name = entity.name,
            e._content = null,
            e._description = entity.entityType,
            e.entityType = entity.entityType,
            e.confidence = entity.confidence,
            e.projectId = $projectId,
            e._state = 'linked',
            e.embeddingsDirty = true
          WITH e, entity
          MATCH (n:\`${label}\` {uuid: entity.sourceUuid})
          MERGE (n)-[r:MENTIONS]->(e)
          ON CREATE SET r.confidence = entity.confidence
          RETURN count(DISTINCT e) AS created
          `,
          { entities, projectId: this.projectId }
        );

        const createdValue = entityResult.records[0]?.get('created');
        entitiesCreated += createdValue?.toNumber?.() ?? (typeof createdValue === 'number' ? createdValue : 0);
      }
    }

    // 5. Collect and batch create relations
    const allRelations: Array<{
      subjectId: string;
      objectId: string;
      predicate: string;
      confidence: number;
      sourceUuid: string;
    }> = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const node = nodes[i];
      if (!result || !result.relations) continue;

      const nodeEntityMap = entityMaps.get(node.uuid);
      if (!nodeEntityMap) continue;

      for (const relation of result.relations) {
        const subjectId = nodeEntityMap.get(relation.subject.toLowerCase());
        const objectId = nodeEntityMap.get(relation.object.toLowerCase());
        if (subjectId && objectId) {
          allRelations.push({
            subjectId,
            objectId,
            predicate: relation.predicate,
            confidence: relation.confidence ?? 0.5,
            sourceUuid: node.uuid,
          });
        }
      }
    }

    let relationsCreated = 0;
    if (allRelations.length > 0) {
      const relationResult = await this.neo4jClient.run(
        `
        UNWIND $relations AS rel
        MATCH (subject:Entity {uuid: rel.subjectId})
        MATCH (object:Entity {uuid: rel.objectId})
        MERGE (subject)-[r:RELATED_TO {type: rel.predicate}]->(object)
        ON CREATE SET
          r.confidence = rel.confidence,
          r.sourceNodeUuid = rel.sourceUuid,
          r.createdAt = datetime()
        ON MATCH SET
          r.confidence = CASE WHEN r.confidence < rel.confidence THEN rel.confidence ELSE r.confidence END
        RETURN count(r) AS created
        `,
        { relations: allRelations }
      );

      const relCreatedValue = relationResult.records[0]?.get('created');
      relationsCreated = relCreatedValue?.toNumber?.() ?? (typeof relCreatedValue === 'number' ? relCreatedValue : 0);
    }

    // 6. Update _entitiesContentHash on all processed nodes to prevent re-extraction
    // Group by label for efficient indexed updates
    const nodesByLabel = new Map<string, Array<{ uuid: string; contentHash: string }>>();
    for (const node of nodes) {
      const group = nodesByLabel.get(node.label) || [];
      group.push({ uuid: node.uuid, contentHash: node.contentHash });
      nodesByLabel.set(node.label, group);
    }

    for (const [label, nodeData] of nodesByLabel) {
      await this.neo4jClient.run(
        `
        UNWIND $nodes AS node
        MATCH (n:\`${label}\` {uuid: node.uuid})
        SET n._entitiesContentHash = node.contentHash
        `,
        { nodes: nodeData }
      );
    }

    return { entitiesCreated, relationsCreated };
  }

  /**
   * Extract entities for a batch of nodes using specific domains' entity types.
   * Similar to extractEntitiesGlobalBatch but uses merged entity types from domains.
   *
   * @param nodes - Nodes with content to extract from
   * @param domains - Array of domain names (e.g., ["legal", "tech"])
   */
  private async extractEntitiesGlobalBatchWithDomains(
    nodes: Array<{ uuid: string; content: string; label: string; filePath: string; contentHash: string }>,
    domains: string[]
  ): Promise<{ entitiesCreated: number; relationsCreated: number }> {
    if (nodes.length === 0) {
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    // 0. Collect existing MENTIONS relationships for comparison after extraction
    const nodeUuids = nodes.map(n => n.uuid);
    const existingMentions = new Set<string>(); // "nodeUuid|entityUuid"

    const existingResult = await this.neo4jClient.run(
      `
      UNWIND $uuids AS uuid
      MATCH (n {uuid: uuid})-[:MENTIONS]->(e:Entity)
      RETURN n.uuid AS nodeUuid, e.uuid AS entityUuid
      `,
      { uuids: nodeUuids }
    );

    for (const record of existingResult.records) {
      const nodeUuid = record.get('nodeUuid');
      const entityUuid = record.get('entityUuid');
      existingMentions.add(`${nodeUuid}|${entityUuid}`);
    }

    if (this.verbose && existingMentions.size > 0) {
      console.log(`[UnifiedProcessor] Found ${existingMentions.size} existing MENTIONS to compare after extraction`);
    }

    // 1. Extract texts (truncated to 5000 chars each)
    const texts = nodes.map(n => n.content.slice(0, 5000));

    // 2. Single batch call to GLiNER with domain-specific entity types
    const extractionStartTime = Date.now();
    const results = await this.entityClient.extractBatchWithDomains(texts, domains);
    const extractionDuration = Date.now() - extractionStartTime;
    this.signalActivity();

    const totalEntitiesExtracted = results.reduce((sum, r) => sum + (r?.entities?.length || 0), 0);
    const totalRelationsExtracted = results.reduce((sum, r) => sum + (r?.relations?.length || 0), 0);

    console.log(`[UnifiedProcessor] 🧠 GLiNER batch [${domains.join('|')}] extracted ${totalEntitiesExtracted} entities, ${totalRelationsExtracted} relations from ${nodes.length} nodes in ${extractionDuration}ms`);

    // 3. Collect all entities with source tracking
    const allEntities: Array<{
      entityId: string;
      name: string;
      entityType: string;
      confidence: number;
      sourceUuid: string;
      sourceLabel: string;
    }> = [];

    const entityMaps = new Map<string, Map<string, string>>();

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const node = nodes[i];
      if (!result || !result.entities) continue;

      const nodeEntityMap = new Map<string, string>();
      entityMaps.set(node.uuid, nodeEntityMap);

      for (const entity of result.entities) {
        const normalizedName = entity.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const entityId = `entity:${entity.type}:${normalizedName}`;
        nodeEntityMap.set(entity.name.toLowerCase(), entityId);
        allEntities.push({
          entityId,
          name: entity.name,
          entityType: entity.type,
          confidence: entity.confidence ?? 0.5,
          sourceUuid: node.uuid,
          sourceLabel: node.label,
        });
      }
    }

    // 4. Batch create entities with UNWIND - grouped by sourceLabel
    let entitiesCreated = 0;
    if (allEntities.length > 0) {
      const entitiesByLabel = new Map<string, typeof allEntities>();
      for (const e of allEntities) {
        const group = entitiesByLabel.get(e.sourceLabel) || [];
        group.push(e);
        entitiesByLabel.set(e.sourceLabel, group);
      }

      for (const [label, entities] of entitiesByLabel) {
        const entityResult = await this.neo4jClient.run(
          `
          UNWIND $entities AS entity
          MERGE (e:Entity {uuid: entity.entityId})
          ON CREATE SET
            e._name = entity.name,
            e._content = null,
            e._description = entity.entityType,
            e.entityType = entity.entityType,
            e.confidence = entity.confidence,
            e.projectId = $projectId,
            e._state = 'linked',
            e.embeddingsDirty = true
          WITH e, entity
          MATCH (n:\`${label}\` {uuid: entity.sourceUuid})
          MERGE (n)-[r:MENTIONS]->(e)
          ON CREATE SET r.confidence = entity.confidence
          RETURN count(DISTINCT e) AS created
          `,
          { entities, projectId: this.projectId }
        );

        const createdValue = entityResult.records[0]?.get('created');
        entitiesCreated += createdValue?.toNumber?.() ?? (typeof createdValue === 'number' ? createdValue : 0);
      }
    }

    // 5. Collect and batch create relations
    const allRelations: Array<{
      subjectId: string;
      objectId: string;
      predicate: string;
      confidence: number;
      sourceUuid: string;
    }> = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const node = nodes[i];
      if (!result || !result.relations) continue;

      const nodeEntityMap = entityMaps.get(node.uuid);
      if (!nodeEntityMap) continue;

      for (const relation of result.relations) {
        const subjectId = nodeEntityMap.get(relation.subject.toLowerCase());
        const objectId = nodeEntityMap.get(relation.object.toLowerCase());
        if (subjectId && objectId) {
          allRelations.push({
            subjectId,
            objectId,
            predicate: relation.predicate,
            confidence: relation.confidence ?? 0.5,
            sourceUuid: node.uuid,
          });
        }
      }
    }

    let relationsCreated = 0;
    if (allRelations.length > 0) {
      const relationResult = await this.neo4jClient.run(
        `
        UNWIND $relations AS rel
        MATCH (subject:Entity {uuid: rel.subjectId})
        MATCH (object:Entity {uuid: rel.objectId})
        MERGE (subject)-[r:RELATED_TO {type: rel.predicate}]->(object)
        ON CREATE SET
          r.confidence = rel.confidence,
          r.sourceNodeUuid = rel.sourceUuid,
          r.createdAt = datetime()
        ON MATCH SET
          r.confidence = CASE WHEN r.confidence < rel.confidence THEN rel.confidence ELSE r.confidence END
        RETURN count(r) AS created
        `,
        { relations: allRelations }
      );

      const relCreatedValue = relationResult.records[0]?.get('created');
      relationsCreated = relCreatedValue?.toNumber?.() ?? (typeof relCreatedValue === 'number' ? relCreatedValue : 0);
    }

    // 5.5. Cleanup stale MENTIONS relationships
    if (existingMentions.size > 0) {
      // Build set of new mentions from allEntities
      const newMentions = new Set<string>();
      for (const entity of allEntities) {
        newMentions.add(`${entity.sourceUuid}|${entity.entityId}`);
      }

      // Find stale mentions (exist before but not after)
      const staleMentions: Array<{ nodeUuid: string; entityUuid: string }> = [];
      for (const key of existingMentions) {
        if (!newMentions.has(key)) {
          const [nodeUuid, entityUuid] = key.split('|');
          staleMentions.push({ nodeUuid, entityUuid });
        }
      }

      if (staleMentions.length > 0) {
        // Delete stale MENTIONS relationships
        const deleteResult = await this.neo4jClient.run(
          `
          UNWIND $staleMentions AS m
          MATCH (n {uuid: m.nodeUuid})-[r:MENTIONS]->(e:Entity {uuid: m.entityUuid})
          DELETE r
          RETURN count(r) AS deleted
          `,
          { staleMentions }
        );
        const deleted = deleteResult.records[0]?.get('deleted');
        const deletedCount = deleted?.toNumber?.() ?? (typeof deleted === 'number' ? deleted : 0);

        if (deletedCount > 0) {
          console.log(`[UnifiedProcessor] 🧹 Cleaned up ${deletedCount} stale MENTIONS relationships`);
        }

        // Delete orphaned entities (no MENTIONS relationships left)
        const orphanResult = await this.neo4jClient.run(
          `
          MATCH (e:Entity {projectId: $projectId})
          WHERE NOT (e)<-[:MENTIONS]-()
          WITH e, e._name AS name
          DETACH DELETE e
          RETURN count(e) AS deleted, collect(name)[0..5] AS samples
          `,
          { projectId: this.projectId }
        );
        const orphansDeleted = orphanResult.records[0]?.get('deleted');
        const orphanCount = orphansDeleted?.toNumber?.() ?? (typeof orphansDeleted === 'number' ? orphansDeleted : 0);
        const samples = orphanResult.records[0]?.get('samples') || [];

        if (orphanCount > 0) {
          console.log(`[UnifiedProcessor] 🗑️ Deleted ${orphanCount} orphaned entities${samples.length > 0 ? ` (e.g., ${samples.slice(0, 3).join(', ')})` : ''}`);
        }
      }
    }

    // 6. Update _entitiesContentHash on all processed nodes
    const nodesByLabel = new Map<string, Array<{ uuid: string; contentHash: string }>>();
    for (const node of nodes) {
      const group = nodesByLabel.get(node.label) || [];
      group.push({ uuid: node.uuid, contentHash: node.contentHash });
      nodesByLabel.set(node.label, group);
    }

    for (const [label, nodeData] of nodesByLabel) {
      await this.neo4jClient.run(
        `
        UNWIND $nodes AS node
        MATCH (n:\`${label}\` {uuid: node.uuid})
        SET n._entitiesContentHash = node.contentHash
        `,
        { nodes: nodeData }
      );
    }

    return { entitiesCreated, relationsCreated };
  }

  /**
   * Extract entities and relations for nodes in a file (batch optimized)
   *
   * Optimizations:
   * - Parallel GLiNER extraction with pLimit(5)
   * - Batch entity creation with UNWIND
   * - Batch relation creation with UNWIND
   * - Batch MENTIONS relationship creation
   *
   * @param glinerAvailable - Pre-checked GLiNER availability (avoids redundant checks)
   */
  private async extractEntitiesForFileOptimized(filePath: string, glinerAvailable: boolean): Promise<{
    entitiesCreated: number;
    relationsCreated: number;
  }> {
    // Use pre-checked availability to avoid redundant network calls
    if (!glinerAvailable) {
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    // 1. Get all nodes needing extraction
    const nodes = await this.getNodesForEntityExtraction(filePath);

    if (nodes.length === 0) {
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    // 1.5. Collect existing MENTIONS relationships for comparison after extraction
    // This allows us to detect which entities are no longer mentioned
    const nodeUuids = nodes.map(n => n.uuid);
    const existingMentions = new Set<string>(); // "nodeUuid|entityUuid"

    const existingResult = await this.neo4jClient.run(
      `
      UNWIND $uuids AS uuid
      MATCH (n {uuid: uuid})-[:MENTIONS]->(e:Entity)
      RETURN n.uuid AS nodeUuid, e.uuid AS entityUuid
      `,
      { uuids: nodeUuids }
    );

    for (const record of existingResult.records) {
      const nodeUuid = record.get('nodeUuid');
      const entityUuid = record.get('entityUuid');
      existingMentions.add(`${nodeUuid}|${entityUuid}`);
    }

    if (this.verbose && existingMentions.size > 0) {
      console.log(`[UnifiedProcessor] Found ${existingMentions.size} existing MENTIONS to compare after extraction`);
    }

    // 2. Parallel extraction with pLimit(5) for GLiNER concurrency
    const glinerLimit = pLimit(5);
    const extractions = await Promise.all(
      nodes.map(node =>
        glinerLimit(async () => {
          try {
            const result = await this.entityClient.extract(
              node.content.slice(0, 5000) // Limit content length
            );
            return { node, result, error: null };
          } catch (error: any) {
            if (this.verbose) {
              console.warn(`[UnifiedProcessor] Entity extraction failed for ${node.uuid}: ${error.message}`);
            }
            return { node, result: null, error };
          }
        })
      )
    );

    // Filter successful extractions
    const successfulExtractions = extractions.filter(e => e.result !== null);

    if (successfulExtractions.length === 0) {
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    // 3. Collect all entities with their source info (including label for indexed queries)
    const allEntities: Array<{
      entityId: string;
      name: string;
      entityType: string;
      confidence: number;
      sourceUuid: string;
      sourceLabel: string;
    }> = [];

    // Track entity name -> entityId for relation creation (per source node)
    const entityMaps = new Map<string, Map<string, string>>();

    for (const { node, result } of successfulExtractions) {
      if (!result || !result.entities) continue;

      const nodeEntityMap = new Map<string, string>();
      entityMaps.set(node.uuid, nodeEntityMap);

      for (const entity of result.entities) {
        const normalizedName = entity.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const entityId = `entity:${entity.type}:${normalizedName}`;

        nodeEntityMap.set(entity.name.toLowerCase(), entityId);

        allEntities.push({
          entityId,
          name: entity.name,
          entityType: entity.type,
          confidence: entity.confidence ?? 0.5,
          sourceUuid: node.uuid,
          sourceLabel: node.label,
        });
      }
    }

    // 4. Batch create entities with UNWIND - grouped by sourceLabel for index usage
    let entitiesCreated = 0;
    if (allEntities.length > 0) {
      // Group entities by sourceLabel to use label-specific indexes
      const entitiesByLabel = new Map<string, typeof allEntities>();
      for (const e of allEntities) {
        const group = entitiesByLabel.get(e.sourceLabel) || [];
        group.push(e);
        entitiesByLabel.set(e.sourceLabel, group);
      }

      // Run a separate query per label (uses index on Label.uuid)
      for (const [label, entities] of entitiesByLabel) {
        const entityResult = await this.neo4jClient.run(
          `
          UNWIND $entities AS entity
          MERGE (e:Entity {uuid: entity.entityId})
          ON CREATE SET
            e._name = entity.name,
            e._content = null,
            e._description = entity.entityType,
            e.entityType = entity.entityType,
            e.confidence = entity.confidence,
            e.projectId = $projectId,
            e._state = 'linked',
            e.embeddingsDirty = true
          WITH e, entity
          MATCH (n:\`${label}\` {uuid: entity.sourceUuid})
          MERGE (n)-[r:MENTIONS]->(e)
          ON CREATE SET r.confidence = entity.confidence
          RETURN count(DISTINCT e) AS created
          `,
          { entities, projectId: this.projectId }
        );

        const createdValue = entityResult.records[0]?.get('created');
        entitiesCreated += createdValue?.toNumber?.() ?? (typeof createdValue === 'number' ? createdValue : 0);
      }
    }

    // 5. Collect all relations
    const allRelations: Array<{
      subjectId: string;
      objectId: string;
      predicate: string;
      confidence: number;
      sourceUuid: string;
    }> = [];

    for (const { node, result } of successfulExtractions) {
      if (!result || !result.relations) continue;

      const nodeEntityMap = entityMaps.get(node.uuid);
      if (!nodeEntityMap) continue;

      for (const relation of result.relations) {
        const subjectId = nodeEntityMap.get(relation.subject.toLowerCase());
        const objectId = nodeEntityMap.get(relation.object.toLowerCase());

        if (subjectId && objectId) {
          allRelations.push({
            subjectId,
            objectId,
            predicate: relation.predicate,
            confidence: relation.confidence ?? 0.5,
            sourceUuid: node.uuid,
          });
        } else if (this.verbose) {
          console.log(`[UnifiedProcessor] Skipped relation (entities not found): ${relation.subject} -[${relation.predicate}]-> ${relation.object}`);
        }
      }
    }

    // 6. Batch create relations with UNWIND
    let relationsCreated = 0;
    if (allRelations.length > 0) {
      const relationResult = await this.neo4jClient.run(
        `
        UNWIND $relations AS rel
        MATCH (subject:Entity {uuid: rel.subjectId})
        MATCH (object:Entity {uuid: rel.objectId})
        MERGE (subject)-[r:RELATED_TO {type: rel.predicate}]->(object)
        ON CREATE SET
          r.confidence = rel.confidence,
          r.sourceNodeUuid = rel.sourceUuid,
          r.createdAt = datetime()
        ON MATCH SET
          r.confidence = CASE WHEN r.confidence < rel.confidence THEN rel.confidence ELSE r.confidence END
        RETURN count(r) AS created
        `,
        { relations: allRelations }
      );

      const relCreatedValue = relationResult.records[0]?.get('created');
      relationsCreated = relCreatedValue?.toNumber?.() ?? (typeof relCreatedValue === 'number' ? relCreatedValue : 0);

      if (this.verbose && relationsCreated > 0) {
        console.log(`[UnifiedProcessor] Created ${relationsCreated} entity relations`);
      }
    }

    // 6.5. Cleanup stale MENTIONS relationships
    // Compare existing mentions with new ones and delete the stale ones
    if (existingMentions.size > 0) {
      // Build set of new mentions from allEntities
      const newMentions = new Set<string>();
      for (const entity of allEntities) {
        // entityId is the uuid we'll use, sourceUuid is the node
        newMentions.add(`${entity.sourceUuid}|${entity.entityId}`);
      }

      // Find stale mentions (exist before but not after)
      const staleMentions: Array<{ nodeUuid: string; entityUuid: string }> = [];
      for (const key of existingMentions) {
        if (!newMentions.has(key)) {
          const [nodeUuid, entityUuid] = key.split('|');
          staleMentions.push({ nodeUuid, entityUuid });
        }
      }

      if (staleMentions.length > 0) {
        // Delete stale MENTIONS relationships
        const deleteResult = await this.neo4jClient.run(
          `
          UNWIND $staleMentions AS m
          MATCH (n {uuid: m.nodeUuid})-[r:MENTIONS]->(e:Entity {uuid: m.entityUuid})
          DELETE r
          RETURN count(r) AS deleted
          `,
          { staleMentions }
        );
        const deleted = deleteResult.records[0]?.get('deleted');
        const deletedCount = deleted?.toNumber?.() ?? (typeof deleted === 'number' ? deleted : 0);

        if (this.verbose || deletedCount > 0) {
          console.log(`[UnifiedProcessor] 🧹 Cleaned up ${deletedCount} stale MENTIONS relationships`);
        }

        // Delete orphaned entities (no MENTIONS relationships left)
        const orphanResult = await this.neo4jClient.run(
          `
          MATCH (e:Entity {projectId: $projectId})
          WHERE NOT (e)<-[:MENTIONS]-()
          WITH e, e._name AS name
          DETACH DELETE e
          RETURN count(e) AS deleted, collect(name)[0..5] AS samples
          `,
          { projectId: this.projectId }
        );
        const orphansDeleted = orphanResult.records[0]?.get('deleted');
        const orphanCount = orphansDeleted?.toNumber?.() ?? (typeof orphansDeleted === 'number' ? orphansDeleted : 0);
        const samples = orphanResult.records[0]?.get('samples') || [];

        if (this.verbose || orphanCount > 0) {
          console.log(`[UnifiedProcessor] 🗑️ Deleted ${orphanCount} orphaned entities${samples.length > 0 ? ` (e.g., ${samples.slice(0, 3).join(', ')})` : ''}`);
        }
      }
    }

    // 7. Update _entitiesContentHash on all processed nodes to prevent re-extraction
    const nodesByLabel = new Map<string, Array<{ uuid: string; contentHash: string }>>();
    for (const node of nodes) {
      const group = nodesByLabel.get(node.label) || [];
      group.push({ uuid: node.uuid, contentHash: node.contentHash });
      nodesByLabel.set(node.label, group);
    }

    for (const [label, nodeData] of nodesByLabel) {
      await this.neo4jClient.run(
        `
        UNWIND $nodes AS node
        MATCH (n:\`${label}\` {uuid: node.uuid})
        SET n._entitiesContentHash = node.contentHash
        `,
        { nodes: nodeData }
      );
    }

    return { entitiesCreated, relationsCreated };
  }

  /**
   * Extract entities for a single file (backward compatible wrapper)
   * Checks GLiNER availability internally - use extractEntitiesForFileOptimized for batch operations
   * Handles GPU load/unload automatically
   */
  private async extractEntitiesForFile(filePath: string): Promise<{
    entitiesCreated: number;
    relationsCreated: number;
  }> {
    const glinerAvailable = await this.entityClient.isAvailable();
    if (!glinerAvailable) {
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    // Load GLiNER model to GPU
    await this.entityClient.loadModel();

    try {
      return await this.extractEntitiesForFileOptimized(filePath, glinerAvailable);
    } finally {
      // Always unload to free GPU for Ollama embeddings
      await this.entityClient.unloadModel();
    }
  }

  /**
   * Extract entities for a single file WITH domain classification and disabled domain check.
   * Used by processFile() for individual file processing.
   *
   * This method:
   * 1. Reads file content
   * 2. Classifies domain
   * 3. Checks if all domains are disabled → skip extraction
   * 4. If enabled, extracts with domain-specific entity types
   */
  private async extractEntitiesForFileSingleWithDomainCheck(filePath: string): Promise<{
    entitiesCreated: number;
    relationsCreated: number;
  }> {
    const glinerAvailable = await this.entityClient.isAvailable();
    if (!glinerAvailable) {
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    // 1. Read file content for domain classification
    // Use content provider to support both disk and virtual files
    let fileContent: string;
    try {
      fileContent = await this.readFileContent(filePath);
    } catch (error) {
      // File might not exist anymore
      if (this.verbose) {
        console.warn(`[UnifiedProcessor] Could not read file for domain check: ${filePath}`);
      }
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    // 2. Classify domain
    let domains: string[] = [];
    try {
      const classifications = await this.entityClient.classifyDomainsBatch(
        [fileContent.slice(0, 2000)],
        0.3
      );
      domains = (classifications[0] || []).map(d => d.label).filter(Boolean);
    } catch (error: any) {
      if (this.verbose) {
        console.warn(`[UnifiedProcessor] Domain classification failed for ${filePath}: ${error.message}`);
      }
      // Continue with default domain
      domains = ['default'];
    }

    // 3. Check disabled domains
    const disabledDomains = await this.entityClient.getDisabledDomains();
    const enabledDomains = domains.filter(d => !disabledDomains.has(d));

    // If ALL detected domains are disabled, skip extraction
    if (enabledDomains.length === 0 && domains.length > 0 && !domains.includes('default')) {
      console.log(`[UnifiedProcessor] ⏭️ Skipping entity extraction for ${filePath}: all domains disabled (${domains.join('|')})`);
      // Mark nodes as processed to prevent re-extraction attempts
      await this.markNodesEntityHashUpdated(filePath);
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    // 4. Get nodes for this file
    const nodes = await this.getNodesForEntityExtraction(filePath);
    if (nodes.length === 0) {
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    // 5. Use enabled domains (or 'default' if none)
    const extractionDomains = enabledDomains.length > 0 ? enabledDomains : ['default'];

    // Load GLiNER model to GPU
    await this.entityClient.loadModel();

    try {
      // Extract with domain-specific entity types
      const nodesWithFilePath = nodes.map(n => ({
        ...n,
        filePath,
      }));

      if (this.verbose) {
        console.log(`[UnifiedProcessor] Extracting entities for ${filePath} with domains: ${extractionDomains.join('|')}`);
      }

      return await this.extractEntitiesGlobalBatchWithDomains(nodesWithFilePath, extractionDomains);
    } finally {
      // Always unload to free GPU for Ollama embeddings
      await this.entityClient.unloadModel();
    }
  }

  /**
   * Mark nodes in a file as having their entity hash updated (to skip future extraction).
   * Used when skipping extraction for disabled domains.
   */
  private async markNodesEntityHashUpdated(filePath: string): Promise<void> {
    await this.neo4jClient.run(
      `
      MATCH (n)-[:DEFINED_IN]->(f:File)
      WHERE f.file = $filePath AND f.projectId = $projectId
        AND (n:MarkdownSection OR n:MarkdownDocument OR n:WebPage OR n:WebDocument)
        AND n._content IS NOT NULL
        AND n._state = 'linked'
      SET n._entitiesContentHash = n._contentHash
      `,
      { filePath, projectId: this.projectId }
    );
  }

  /**
   * Mark a batch of nodes as having their entity hash updated (to skip future extraction).
   * Used when skipping extraction for disabled domains in batch processing.
   */
  private async markNodesBatchEntityHashUpdated(
    nodes: Array<{ uuid: string; label: string; contentHash: string }>
  ): Promise<void> {
    if (nodes.length === 0) return;

    // Group by label for efficient indexed updates
    const nodesByLabel = new Map<string, Array<{ uuid: string; contentHash: string }>>();
    for (const node of nodes) {
      const group = nodesByLabel.get(node.label) || [];
      group.push({ uuid: node.uuid, contentHash: node.contentHash });
      nodesByLabel.set(node.label, group);
    }

    for (const [label, nodeData] of nodesByLabel) {
      await this.neo4jClient.run(
        `
        UNWIND $nodes AS node
        MATCH (n:\`${label}\` {uuid: node.uuid})
        SET n._entitiesContentHash = node.contentHash
        `,
        { nodes: nodeData }
      );
    }
  }

  // ============================================
  // Embedding Generation
  // ============================================

  /**
   * Generate embeddings for nodes in a file
   */
  private async generateEmbeddingsForFile(filePath: string): Promise<{
    embeddingsGenerated: number;
  }> {
    // Check if embedding service can generate embeddings
    if (!this.embeddingService.canGenerateEmbeddings()) {
      console.log(`[UnifiedProcessor] Skipping embeddings for ${filePath}: no embedding provider configured`);
      return { embeddingsGenerated: 0 };
    }

    const options: GenerateMultiEmbeddingsOptions = {
      projectId: this.projectId,
      incrementalOnly: true,
      verbose: this.verbose,
      onActivity: () => this.signalActivity(),
    };

    try {
      console.log(`[UnifiedProcessor] Generating embeddings for project ${this.projectId}...`);
      const result = await this.embeddingService.generateMultiEmbeddings(options);
      console.log(`[UnifiedProcessor] Embeddings generated: ${result.totalEmbedded} (name=${result.embeddedByType.name}, content=${result.embeddedByType.content}, description=${result.embeddedByType.description})`);
      return {
        embeddingsGenerated: result.totalEmbedded,
      };
    } catch (error: any) {
      console.warn(`[UnifiedProcessor] Embedding generation failed: ${error.message}`);
      return { embeddingsGenerated: 0 };
    }
  }

  // ============================================
  // State Queries
  // ============================================

  /**
   * Get processing statistics for the project
   */
  async getStats(): Promise<{
    byState: Record<FileState, number>;
    total: number;
    processed: number;
    pending: number;
    errors: number;
  }> {
    const stats = await this.fileStateMachine.getStateStats(this.projectId);
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    const processed = stats.embedded;
    const pending = stats.discovered + stats.parsing + stats.parsed + stats.relations + stats.linked + stats.entities + stats.embedding;
    const errors = stats.error;

    return { byState: stats, total, processed, pending, errors };
  }

  /**
   * Check if processing is complete
   */
  async isComplete(): Promise<boolean> {
    return this.fileStateMachine.isProjectFullyProcessed(this.projectId);
  }

  /**
   * Get progress percentage
   */
  async getProgress(): Promise<{ processed: number; total: number; percentage: number }> {
    return this.fileStateMachine.getProgress(this.projectId);
  }

  // ============================================
  // Helper Methods
  // ============================================

  private resolveAbsolutePath(filePath: string): string {
    if (filePath.startsWith('/')) {
      return filePath;
    }
    if (this.projectRoot) {
      return `${this.projectRoot}/${filePath}`;
    }
    return filePath;
  }

  /**
   * Read file content using the content provider.
   * Supports both disk-based files and virtual files (content in Neo4j).
   *
   * @param filePath - Absolute path to the file
   * @param fileUuid - Optional file UUID (required for virtual files)
   * @returns File content as string
   * @throws Error if file doesn't exist or can't be read
   */
  private async readFileContent(filePath: string, fileUuid?: string): Promise<string> {
    const contentFile: ContentFileInfo = {
      uuid: fileUuid || '',
      absolutePath: this.resolveAbsolutePath(filePath),
      projectId: this.projectId,
    };

    // For disk-based projects, also try fs.readFile as fallback
    // (in case the file exists on disk but not yet in Neo4j)
    if (this.contentSourceType === 'disk') {
      return fs.readFile(contentFile.absolutePath!, 'utf-8');
    }

    // For virtual projects, use the content provider
    return this.contentProvider.readContent(contentFile);
  }

  private determineErrorType(error: any): ErrorType {
    const message = error.message?.toLowerCase() || '';

    if (message.includes('parse') || message.includes('syntax')) {
      return 'parse';
    }
    if (message.includes('relation')) {
      return 'relations';
    }
    if (message.includes('entity') || message.includes('gliner')) {
      return 'entities';
    }
    if (message.includes('embed') || message.includes('gemini') || message.includes('ollama')) {
      return 'embed';
    }

    return 'parse'; // Default
  }

  private emptyStats(startTime: number): ProcessingStats {
    return {
      filesProcessed: 0,
      filesSkipped: 0,
      filesErrored: 0,
      scopesCreated: 0,
      entitiesCreated: 0,
      relationsCreated: 0,
      embeddingsGenerated: 0,
      durationMs: Date.now() - startTime,
    };
  }

  // ============================================
  // Virtual File Ingestion
  // ============================================

  /**
   * Ingest virtual files (files that exist only in memory, not on disk).
   *
   * This method:
   * 1. Creates File nodes with _rawContent stored directly in Neo4j
   * 2. Marks them as 'discovered' state
   * 3. Processes them through the normal pipeline (parsing, linking, entities, embeddings)
   *
   * The VirtualContentProvider will read content from Neo4j _rawContent instead of disk.
   *
   * @param files - Array of virtual files to ingest
   * @param options - Optional configuration
   * @returns Processing statistics
   *
   * @example
   * ```typescript
   * const { files } = await downloadGitHubRepo('https://github.com/owner/repo');
   * const stats = await processor.ingestVirtualFiles(files);
   * ```
   */
  async ingestVirtualFiles(
    files: VirtualFile[],
    options?: {
      /** Skip processing and only create File nodes (default: false) */
      skipProcessing?: boolean;
      /** Root path prefix to strip from virtual paths */
      stripPrefix?: string;
      /**
       * Additional properties to inject on ALL nodes (File, Scope, etc.)
       * Use this for community metadata like documentId, categoryId, userId, etc.
       */
      additionalProperties?: Record<string, unknown>;
      /**
       * Parser-specific options for documents and media files.
       * Overrides config.parserOptions for this ingestion call.
       * Use for Vision-enhanced parsing of PDFs, images, 3D models, etc.
       */
      parserOptions?: ParserOptionsConfig;
    }
  ): Promise<ProcessingStats> {
    const startTime = Date.now();

    if (files.length === 0) {
      return this.emptyStats(startTime);
    }

    console.log(`[UnifiedProcessor] Ingesting ${files.length} virtual files for project ${this.projectId}`);

    // 1. Create File nodes with _rawContent and additional properties
    const createdCount = await this.createVirtualFileNodes(
      files,
      options?.stripPrefix,
      options?.additionalProperties
    );
    console.log(`[UnifiedProcessor] Created/updated ${createdCount} virtual File nodes`);

    // 2. If skipProcessing, return early
    if (options?.skipProcessing) {
      return {
        filesProcessed: createdCount,
        filesSkipped: files.length - createdCount,
        filesErrored: 0,
        scopesCreated: 0,
        entitiesCreated: 0,
        relationsCreated: 0,
        embeddingsGenerated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // 3. Set parserOptions if provided (for Vision-enhanced parsing)
    if (options?.parserOptions) {
      this.fileProcessor.setParserOptions(options.parserOptions);
    }

    // 4. Process through normal pipeline (discovered → parsed → linked)
    // The VirtualContentProvider will read from _rawContent
    const discoveredStats = await this.processDiscovered();

    // 5. Process linked nodes (entity extraction + embeddings)
    const linkedStats = await this.processLinked();

    // Merge stats
    const stats: ProcessingStats = {
      filesProcessed: discoveredStats.filesProcessed,
      filesSkipped: discoveredStats.filesSkipped,
      filesErrored: discoveredStats.filesErrored,
      scopesCreated: discoveredStats.scopesCreated,
      entitiesCreated: linkedStats.entitiesCreated,
      relationsCreated: linkedStats.relationsCreated,
      embeddingsGenerated: linkedStats.embeddingsGenerated,
      durationMs: discoveredStats.durationMs + linkedStats.durationMs,
    };

    // 6. Restore original parserOptions after processing
    if (options?.parserOptions) {
      this.fileProcessor.setParserOptions(this.parserOptions);
    }

    // 6. Propagate additional properties to all child nodes (Scope, etc.)
    if (options?.additionalProperties && Object.keys(options.additionalProperties).length > 0) {
      await this.propagatePropertiesToChildNodes(options.additionalProperties);
    }

    return {
      ...stats,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Propagate additional properties from File nodes to all related child nodes.
   * This is used for community metadata injection.
   */
  private async propagatePropertiesToChildNodes(
    properties: Record<string, unknown>
  ): Promise<void> {
    // Build SET clause dynamically for the properties
    const propKeys = Object.keys(properties);
    if (propKeys.length === 0) return;

    const setClause = propKeys.map(k => `child.${k} = $props.${k}`).join(', ');

    // Propagate to all Scope nodes linked via DEFINED_IN
    await this.neo4jClient.run(
      `
      MATCH (child:Scope)-[:DEFINED_IN]->(file:File {projectId: $projectId, isVirtual: true})
      SET ${setClause}
      `,
      { projectId: this.projectId, props: properties }
    );

    // Also propagate to Entity nodes linked via MENTIONS
    await this.neo4jClient.run(
      `
      MATCH (child:Entity)-[:MENTIONS]-(scope:Scope)-[:DEFINED_IN]->(file:File {projectId: $projectId, isVirtual: true})
      SET ${setClause}
      `,
      { projectId: this.projectId, props: properties }
    );

    console.log(`[UnifiedProcessor] Propagated ${propKeys.length} properties to child nodes`);
  }

  /**
   * Create File nodes with _rawContent for virtual files
   */
  private async createVirtualFileNodes(
    files: VirtualFile[],
    stripPrefix?: string,
    additionalProperties?: Record<string, unknown>
  ): Promise<number> {
    if (files.length === 0) return 0;

    // Prepare batch data
    const fileData = files.map(vf => {
      // Convert Buffer to string if needed
      const content = typeof vf.content === 'string'
        ? vf.content
        : vf.content.toString('utf-8');

      // Compute hash
      const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);

      // Clean up path
      let filePath = vf.path;
      if (stripPrefix && filePath.startsWith(stripPrefix)) {
        filePath = filePath.slice(stripPrefix.length);
      }
      // Ensure path starts with /
      if (!filePath.startsWith('/')) {
        filePath = '/' + filePath;
      }

      // Extract name and extension from path
      const fileName = filePath.split('/').pop() || filePath;
      const extMatch = fileName.match(/(\.[^.]+)$/);
      const extension = extMatch ? extMatch[1] : null;

      // Generate deterministic UUID from projectId + path
      const uuid = crypto.createHash('sha256')
        .update(`${this.projectId}:${filePath}`)
        .digest('hex')
        .substring(0, 32);

      return {
        uuid,
        filePath,
        fileName,
        extension,
        content,
        hash,
        mimeType: vf.mimeType,
      };
    });

    // Batch create/update File nodes
    const result = await this.neo4jClient.run(
      `
      UNWIND $files AS f
      MERGE (file:File {uuid: f.uuid})
      ON CREATE SET
        file.file = f.filePath,
        file.absolutePath = f.filePath,
        file.name = f.fileName,
        file.extension = f.extension,
        file.projectId = $projectId,
        file._rawContent = f.content,
        file._rawContentHash = f.hash,
        file._state = 'discovered',
        file._stateUpdatedAt = datetime(),
        file.createdAt = datetime(),
        file.isVirtual = true,
        file.retryCount = 0,
        file._wasCreated = true
      ON MATCH SET
        file.name = coalesce(file.name, f.fileName),
        file.extension = coalesce(file.extension, f.extension),
        file._rawContent = f.content,
        file._rawContentHash = f.hash,
        file._previousHash = file.hash,
        file._state = CASE
          WHEN file._rawContentHash <> f.hash THEN 'discovered'
          WHEN file._state = 'error' THEN 'discovered'
          ELSE file._state
        END,
        file._stateUpdatedAt = CASE
          WHEN file._rawContentHash <> f.hash OR file._state = 'error' THEN datetime()
          ELSE file._stateUpdatedAt
        END,
        file.isVirtual = true,
        file._wasCreated = false
      RETURN count(file) AS total,
             sum(CASE WHEN file._wasCreated THEN 1 ELSE 0 END) AS created
      `,
      {
        files: fileData,
        projectId: this.projectId,
      }
    );

    // Clean up temporary _wasCreated property
    await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f._wasCreated IS NOT NULL
      REMOVE f._wasCreated
      `,
      { projectId: this.projectId }
    );

    const total = result.records[0]?.get('total');
    return typeof total === 'number' ? total : (total?.toNumber?.() ?? 0);
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a UnifiedProcessor for a project
 */
export function createUnifiedProcessor(
  driver: Driver,
  neo4jClient: Neo4jClient,
  projectId: string,
  options?: Partial<UnifiedProcessorConfig>
): UnifiedProcessor {
  return new UnifiedProcessor({
    driver,
    neo4jClient,
    projectId,
    ...options,
  });
}
