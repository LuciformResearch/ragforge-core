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
  /** Batch size for processing */
  batchSize?: number;
  /** Concurrency limit for parallel processing (default: 10) */
  concurrency?: number;
  /** Pre-configured embedding service (optional, will create one if not provided) */
  embeddingService?: EmbeddingService;
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
  private batchSize: number;
  private concurrency: number;

  constructor(config: UnifiedProcessorConfig) {
    this.driver = config.driver;
    this.neo4jClient = config.neo4jClient;
    this.projectId = config.projectId;
    this.projectRoot = config.projectRoot;
    this.verbose = config.verbose ?? false;
    this.maxRetries = config.maxRetries ?? 3;
    this.batchSize = config.batchSize ?? 10;
    this.concurrency = config.concurrency ?? 10;

    // Initialize state machines
    this.fileStateMachine = new FileStateMachine(config.neo4jClient);
    this.nodeStateMachine = new NodeStateMachine(config.neo4jClient);

    // Initialize metadata preserver
    this.metadataPreserver = new MetadataPreserver(config.driver, {
      verbose: config.verbose,
    });

    // Initialize file processor (handles parsing + linking)
    this.fileProcessor = new FileProcessor({
      neo4jClient: config.neo4jClient,
      projectId: config.projectId,
      projectRoot: config.projectRoot,
      verbose: config.verbose,
    });

    // Use provided embedding service or create a basic one (without provider config)
    this.embeddingService = config.embeddingService || new EmbeddingService(config.neo4jClient);
    if (config.embeddingService) {
      console.log(`[UnifiedProcessor] Using provided EmbeddingService (canGenerate=${this.embeddingService.canGenerateEmbeddings()})`);
    }

    // Initialize entity extraction client
    this.entityClient = new EntityExtractionClient({
      serviceUrl: config.glinerServiceUrl || 'http://localhost:6971',
    });
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
  async processDiscovered(options?: { limit?: number }): Promise<ProcessingStats> {
    const startTime = Date.now();
    const batchLimit = options?.limit ?? this.batchSize;

    // Get files in discovered state
    console.log(`[UnifiedProcessor] Getting files in 'discovered' state for project ${this.projectId}...`);
    const discoveredFiles = await this.fileStateMachine.getFilesInState(
      this.projectId,
      'discovered'
    );
    console.log(`[UnifiedProcessor] Found ${discoveredFiles.length} files in 'discovered' state`);

    if (discoveredFiles.length === 0) {
      return this.emptyStats(startTime);
    }

    // Process up to limit files
    const filesToProcess = discoveredFiles.slice(0, batchLimit);

    console.log(`[UnifiedProcessor] 🚀 Batch processing ${filesToProcess.length} discovered files (limit: ${batchLimit})`);

    // Convert FileStateInfo to FileInfo for batch processing
    const fileInfos: FileInfo[] = filesToProcess.map(f => ({
      absolutePath: this.resolveAbsolutePath(f.file),
      uuid: f.uuid,
      state: 'discovered' as const,
    }));

    // Use batch processing (single adapter.parse() call)
    const batchResult = await this.fileProcessor.processBatchFiles(fileInfos);

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
  async processLinked(options?: { limit?: number }): Promise<ProcessingStats> {
    const startTime = Date.now();
    const batchLimit = options?.limit ?? this.batchSize;

    // Get files in linked state
    const linkedFiles = await this.fileStateMachine.getFilesInState(
      this.projectId,
      'linked'
    );

    if (linkedFiles.length === 0) {
      return this.emptyStats(startTime);
    }

    const filesToProcess = linkedFiles.slice(0, batchLimit);

    console.log(`[UnifiedProcessor] 🚀 Starting parallel linked processing of ${filesToProcess.length} files (concurrency=${this.concurrency})`);

    const limit = pLimit(this.concurrency);

    // Track successful and failed files
    const successfulFiles: FileStateInfo[] = [];
    const failedFiles: Array<{ file: FileStateInfo; error: Error }> = [];

    // 1. Batch transition to 'entities'
    await this.fileStateMachine.transitionBatch(
      filesToProcess.map(f => f.uuid),
      'entities'
    );

    // 2. Parallel entity extraction
    const entityResults = await Promise.all(
      filesToProcess.map(file =>
        limit(async () => {
          try {
            const result = await this.extractEntitiesForFile(file.file);
            return { file, result, error: null };
          } catch (error: any) {
            return { file, result: null, error };
          }
        })
      )
    );

    // Separate successful and failed entity extractions
    const entitySuccesses: Array<{ file: FileStateInfo; result: { entitiesCreated: number; relationsCreated: number } }> = [];
    for (const { file, result, error } of entityResults) {
      if (error) {
        failedFiles.push({ file, error });
      } else if (result) {
        entitySuccesses.push({ file, result });
        successfulFiles.push(file);
      }
    }

    // Handle failed files - transition to error state
    if (failedFiles.length > 0) {
      for (const { file, error } of failedFiles) {
        await this.fileStateMachine.transition(file.uuid, 'error', {
          errorType: 'entities',
          errorMessage: error.message,
        });
        if (this.verbose) {
          console.error(`[UnifiedProcessor] Entity extraction failed for ${file.file}: ${error.message}`);
        }
      }
    }

    if (successfulFiles.length === 0) {
      return {
        filesProcessed: 0,
        filesSkipped: 0,
        filesErrored: failedFiles.length,
        scopesCreated: 0,
        entitiesCreated: 0,
        relationsCreated: 0,
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

      // 4. Entity extraction
      await this.fileStateMachine.transition(fileInfo.uuid, 'entities');
      const entitiesResult = await this.extractEntitiesForFile(filePath);

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
  }>> {
    const result = await this.neo4jClient.run(
      `
      MATCH (n)-[:DEFINED_IN]->(f:File)
      WHERE f.file = $filePath AND f.projectId = $projectId
        AND (n:MarkdownSection OR n:MarkdownDocument OR n:WebPage OR n:WebDocument)
        AND n._content IS NOT NULL
        AND n._state = 'linked'
      RETURN n.uuid AS uuid, n._content AS content, labels(n)[0] AS label
      LIMIT 100
      `,
      { filePath, projectId: this.projectId }
    );

    return result.records
      .map(r => ({
        uuid: r.get('uuid'),
        content: r.get('content'),
        label: r.get('label'),
      }))
      .filter(n => n.content && n.content.length >= 50);
  }

  /**
   * Extract entities and relations for nodes in a file (batch optimized)
   *
   * Optimizations:
   * - Parallel GLiNER extraction with pLimit(5)
   * - Batch entity creation with UNWIND
   * - Batch relation creation with UNWIND
   * - Batch MENTIONS relationship creation
   */
  private async extractEntitiesForFile(filePath: string): Promise<{
    entitiesCreated: number;
    relationsCreated: number;
  }> {
    // Check if GLiNER service is available
    const isAvailable = await this.entityClient.isAvailable();
    if (!isAvailable) {
      if (this.verbose) {
        console.log(`[UnifiedProcessor] GLiNER service not available, skipping entity extraction`);
      }
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    // 1. Get all nodes needing extraction
    const nodes = await this.getNodesForEntityExtraction(filePath);

    if (nodes.length === 0) {
      return { entitiesCreated: 0, relationsCreated: 0 };
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

    // 3. Collect all entities with their source info
    const allEntities: Array<{
      entityId: string;
      name: string;
      entityType: string;
      confidence: number;
      sourceUuid: string;
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
        });
      }
    }

    // 4. Batch create entities with UNWIND
    let entitiesCreated = 0;
    if (allEntities.length > 0) {
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
          e._state = 'linked'
        WITH e, entity
        MATCH (n {uuid: entity.sourceUuid})
        MERGE (n)-[r:MENTIONS]->(e)
        ON CREATE SET r.confidence = entity.confidence
        RETURN count(DISTINCT e) AS created
        `,
        { entities: allEntities, projectId: this.projectId }
      );

      entitiesCreated = entityResult.records[0]?.get('created')?.toNumber?.() ||
                        entityResult.records[0]?.get('created') || 0;
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

      relationsCreated = relationResult.records[0]?.get('created')?.toNumber?.() ||
                         relationResult.records[0]?.get('created') || 0;

      if (this.verbose && relationsCreated > 0) {
        console.log(`[UnifiedProcessor] Created ${relationsCreated} entity relations`);
      }
    }

    return { entitiesCreated, relationsCreated };
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
