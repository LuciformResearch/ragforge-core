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

  constructor(config: UnifiedProcessorConfig) {
    this.driver = config.driver;
    this.neo4jClient = config.neo4jClient;
    this.projectId = config.projectId;
    this.projectRoot = config.projectRoot;
    this.verbose = config.verbose ?? false;
    this.maxRetries = config.maxRetries ?? 3;
    this.batchSize = config.batchSize ?? 10;

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

    // Initialize embedding service (will use auto-detection from env)
    this.embeddingService = new EmbeddingService(config.neo4jClient);

    // Initialize entity extraction client
    this.entityClient = new EntityExtractionClient({
      serviceUrl: config.glinerServiceUrl || 'http://localhost:6971',
    });
  }

  // ============================================
  // Main Processing Methods
  // ============================================

  /**
   * Process all files in 'discovered' state
   */
  async processDiscovered(options?: { limit?: number }): Promise<ProcessingStats> {
    const startTime = Date.now();
    const limit = options?.limit ?? this.batchSize;

    // Get files in discovered state
    const discoveredFiles = await this.fileStateMachine.getFilesInState(
      this.projectId,
      'discovered'
    );

    if (discoveredFiles.length === 0) {
      return this.emptyStats(startTime);
    }

    // Process up to limit files
    const filesToProcess = discoveredFiles.slice(0, limit);

    if (this.verbose) {
      console.log(`[UnifiedProcessor] Processing ${filesToProcess.length} discovered files`);
    }

    return this.processFiles(filesToProcess);
  }

  /**
   * Process files in 'linked' state through entity extraction and embedding
   */
  async processLinked(options?: { limit?: number }): Promise<ProcessingStats> {
    const startTime = Date.now();
    const limit = options?.limit ?? this.batchSize;

    // Get files in linked state
    const linkedFiles = await this.fileStateMachine.getFilesInState(
      this.projectId,
      'linked'
    );

    if (linkedFiles.length === 0) {
      return this.emptyStats(startTime);
    }

    const filesToProcess = linkedFiles.slice(0, limit);

    if (this.verbose) {
      console.log(`[UnifiedProcessor] Processing ${filesToProcess.length} linked files`);
    }

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

    for (const file of filesToProcess) {
      try {
        // Entity extraction
        await this.fileStateMachine.transition(file.uuid, 'entities');
        const entitiesResult = await this.extractEntitiesForFile(file.file);
        stats.entitiesCreated += entitiesResult.entitiesCreated;
        stats.relationsCreated += entitiesResult.relationsCreated;

        // Embedding generation
        await this.fileStateMachine.transition(file.uuid, 'embedding');
        const embeddingResult = await this.generateEmbeddingsForFile(file.file);
        stats.embeddingsGenerated += embeddingResult.embeddingsGenerated;

        // Mark as complete
        await this.fileStateMachine.transition(file.uuid, 'embedded');
        stats.filesProcessed++;

      } catch (error: any) {
        if (this.verbose) {
          console.error(`[UnifiedProcessor] Error processing ${file.file}: ${error.message}`);
        }
        await this.fileStateMachine.transition(file.uuid, 'error', {
          errorType: 'entities',
          errorMessage: error.message,
        });
        stats.filesErrored++;
      }
    }

    stats.durationMs = Date.now() - startTime;
    return stats;
  }

  /**
   * Process specific files through the complete pipeline
   */
  async processFiles(files: FileStateInfo[]): Promise<ProcessingStats> {
    const startTime = Date.now();

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

    for (const file of files) {
      try {
        const result = await this.processFile(file);

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
      } catch (error: any) {
        if (this.verbose) {
          console.error(`[UnifiedProcessor] Error processing ${file.file}: ${error.message}`);
        }
        stats.filesErrored++;
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
  // Entity Extraction
  // ============================================

  /**
   * Extract entities and relations for nodes in a file
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

    // Get document nodes for this file that need entity extraction
    const result = await this.neo4jClient.run(
      `
      MATCH (n)-[:DEFINED_IN]->(f:File)
      WHERE f.file = $filePath AND f.projectId = $projectId
        AND (n:MarkdownSection OR n:MarkdownDocument OR n:WebPage OR n:WebDocument)
        AND n._content IS NOT NULL
      RETURN n.uuid AS uuid, n._content AS content, labels(n)[0] AS label
      LIMIT 100
      `,
      { filePath, projectId: this.projectId }
    );

    if (result.records.length === 0) {
      return { entitiesCreated: 0, relationsCreated: 0 };
    }

    let entitiesCreated = 0;
    let relationsCreated = 0;

    // Process each node
    for (const record of result.records) {
      const uuid = record.get('uuid');
      const content = record.get('content');
      const label = record.get('label');

      if (!content || content.length < 50) continue;

      try {
        const extractionResult = await this.entityClient.extract(
          content.slice(0, 5000) // Limit content length
        );

        // Map to track entity name -> entityId for relation creation
        const entityNameToId = new Map<string, string>();

        // Create Entity nodes and MENTIONS relationships
        if (extractionResult.entities && extractionResult.entities.length > 0) {
          for (const entity of extractionResult.entities) {
            const normalizedName = entity.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
            const entityId = `entity:${entity.type}:${normalizedName}`;

            // Store mapping for relation creation
            entityNameToId.set(entity.name.toLowerCase(), entityId);

            await this.neo4jClient.run(
              `
              MERGE (e:Entity {uuid: $entityId})
              ON CREATE SET
                e._name = $name,
                e._content = null,
                e._description = $entityType,
                e.entityType = $entityType,
                e.confidence = $confidence,
                e.projectId = $projectId,
                e.__state__ = 'linked',
                e.embeddingsDirty = true
              WITH e
              MATCH (n {uuid: $sourceUuid})
              MERGE (n)-[r:MENTIONS]->(e)
              ON CREATE SET r.confidence = $confidence
              `,
              {
                entityId,
                name: entity.name,
                entityType: entity.type,
                confidence: entity.confidence ?? 0.5,
                projectId: this.projectId,
                sourceUuid: uuid,
              }
            );

            entitiesCreated++;
          }
        }

        // Create relations between entities
        if (extractionResult.relations && extractionResult.relations.length > 0) {
          for (const relation of extractionResult.relations) {
            const subjectId = entityNameToId.get(relation.subject.toLowerCase());
            const objectId = entityNameToId.get(relation.object.toLowerCase());

            // Only create relation if both entities were found
            if (subjectId && objectId) {
              await this.neo4jClient.run(
                `
                MATCH (subject:Entity {uuid: $subjectId})
                MATCH (object:Entity {uuid: $objectId})
                MERGE (subject)-[r:RELATED_TO {type: $predicate}]->(object)
                ON CREATE SET
                  r.confidence = $confidence,
                  r.sourceNodeUuid = $sourceUuid,
                  r.createdAt = datetime()
                ON MATCH SET
                  r.confidence = CASE WHEN r.confidence < $confidence THEN $confidence ELSE r.confidence END
                `,
                {
                  subjectId,
                  objectId,
                  predicate: relation.predicate,
                  confidence: relation.confidence ?? 0.5,
                  sourceUuid: uuid,
                }
              );

              relationsCreated++;

              if (this.verbose) {
                console.log(`[UnifiedProcessor] Created relation: ${relation.subject} -[${relation.predicate}]-> ${relation.object}`);
              }
            } else if (this.verbose) {
              console.log(`[UnifiedProcessor] Skipped relation (entities not found): ${relation.subject} -[${relation.predicate}]-> ${relation.object}`);
            }
          }
        }
      } catch (error: any) {
        if (this.verbose) {
          console.warn(`[UnifiedProcessor] Entity extraction failed for ${uuid}: ${error.message}`);
        }
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
    const options: GenerateMultiEmbeddingsOptions = {
      projectId: this.projectId,
      incrementalOnly: true,
      verbose: this.verbose,
    };

    try {
      const result = await this.embeddingService.generateMultiEmbeddings(options);
      return {
        embeddingsGenerated: result.totalEmbedded,
      };
    } catch (error: any) {
      if (this.verbose) {
        console.warn(`[UnifiedProcessor] Embedding generation failed: ${error.message}`);
      }
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
