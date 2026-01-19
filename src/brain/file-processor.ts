/**
 * FileProcessor - Unified file processing module
 *
 * Handles the complete file processing pipeline for both:
 * - Orphan files (TouchedFilesWatcher)
 * - Project files (IncrementalIngestionManager)
 *
 * Optimizations:
 * - Batch node creation using UNWIND (instead of one-by-one)
 * - Batch relationship creation using UNWIND
 * - Parallel file processing with p-limit
 * - State machine integration for tracking
 *
 * Pipeline stages:
 *   discovered → parsing → parsed → relations → linked
 *
 * @since 2025-12-13
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import pLimit from 'p-limit';
import type { Neo4jClient } from '../runtime/client/neo4j-client.js';
import type { EmbeddingService } from './embedding-service.js';
import { UniversalSourceAdapter } from '../runtime/adapters/universal-source-adapter.js';
import type { ParsedGraph, ParsedNode, ParsedRelationship, ParserOptionsConfig } from '../runtime/adapters/types.js';
import {
  type IContentProvider,
  type ContentFileInfo,
  DiskContentProvider,
  createContentProvider,
  type ContentSourceType,
} from './content-provider.js';
import {
  extractReferences,
  resolveAllReferences,
  createReferenceRelations,
  type ResolvedReference,
} from './reference-extractor.js';
import {
  FileStateMachine,
  type FileState,
} from './file-state-machine.js';
import { UniqueIDHelper } from '../runtime/utils/UniqueIDHelper.js';

// ============================================
// Types
// ============================================

export interface FileInfo {
  /** Absolute path to the file (canonical identifier) */
  absolutePath: string;
  /** File UUID in Neo4j */
  uuid: string;
  /** Content hash (for change detection) */
  hash?: string;
  /** Current state in the pipeline */
  state: FileState;
  /** File name */
  name?: string;
  /** File extension */
  extension?: string;
}

export interface ProcessResult {
  /** Processing status */
  status: 'parsed' | 'skipped' | 'deleted' | 'error';
  /** Number of scope nodes created */
  scopesCreated: number;
  /** Number of relationships created */
  relationshipsCreated: number;
  /** Number of references created (CONSUMES/PENDING_IMPORT) */
  referencesCreated: number;
  /** Error message if status is 'error' */
  error?: string;
  /** New content hash */
  newHash?: string;
  /** UUIDs of created content nodes (for state machine transitions) */
  createdNodes?: Array<{ uuid: string; label: string }>;
}

export interface BatchResult {
  /** Files successfully processed */
  processed: number;
  /** Files skipped (unchanged) */
  skipped: number;
  /** Files deleted (not found) */
  deleted: number;
  /** Errors encountered */
  errors: number;
  /** Total scopes created */
  totalScopesCreated: number;
  /** Total relationships created */
  totalRelationshipsCreated: number;
  /** Processing duration in ms */
  durationMs: number;
}

export interface FileProcessorConfig {
  /** Neo4j client */
  neo4jClient: Neo4jClient;
  /** Adapter for parsing (optional - creates default if not provided) */
  adapter?: UniversalSourceAdapter;
  /** State machine for tracking (optional - creates default if not provided) */
  stateMachine?: FileStateMachine;
  /** Project ID */
  projectId: string;
  /** Project root path (for calculating relative paths) */
  projectRoot?: string;
  /** Verbose logging */
  verbose?: boolean;
  /** Concurrency limit for parallel processing (default: 10) */
  concurrency?: number;
  /**
   * Content provider for reading file content (optional)
   * - If not provided, defaults to DiskContentProvider
   * - Use VirtualContentProvider for virtual projects (content in Neo4j)
   */
  contentProvider?: IContentProvider;
  /**
   * Content source type (alternative to providing a contentProvider)
   * - 'disk': Read from file system (default)
   * - 'virtual': Read from Neo4j _rawContent
   */
  contentSourceType?: ContentSourceType;
  /**
   * Callback when a file transitions to 'linked' state
   * Used to resolve PENDING_IMPORT → CONSUMES relations
   */
  onFileLinked?: (filePath: string) => Promise<void>;
  /**
   * Callback to create a mentioned file (for unresolved imports)
   */
  onCreateMentionedFile?: (
    targetPath: string,
    importedBy: {
      filePath: string;
      scopeUuid?: string;
      symbols: string[];
      importPath: string;
    }
  ) => Promise<{ created: boolean; fileState: string }>;
  /**
   * Callback to check if a file exists in the graph and get its state
   */
  onGetFileState?: (absolutePath: string) => Promise<string | null>;

  /**
   * Parser-specific options for documents and media files.
   * These options are passed to DocumentParser and MediaParser for Vision-enhanced parsing.
   */
  parserOptions?: ParserOptionsConfig;
}

// ============================================
// FileProcessor
// ============================================

export class FileProcessor {
  private neo4jClient: Neo4jClient;
  private adapter: UniversalSourceAdapter;
  private stateMachine: FileStateMachine;
  private projectId: string;
  private projectRoot?: string;
  private verbose: boolean;
  private concurrency: number;
  private config: FileProcessorConfig;
  private contentProvider: IContentProvider;
  private parserOptions?: ParserOptionsConfig;

  constructor(config: FileProcessorConfig) {
    this.config = config;
    this.neo4jClient = config.neo4jClient;
    this.adapter = config.adapter || new UniversalSourceAdapter();
    this.stateMachine = config.stateMachine || new FileStateMachine(config.neo4jClient);
    this.projectId = config.projectId;
    this.projectRoot = config.projectRoot;
    this.verbose = config.verbose || false;
    this.concurrency = config.concurrency || 10;

    // Initialize content provider:
    // 1. Use explicit contentProvider if provided
    // 2. Otherwise create from contentSourceType (defaults to 'disk')
    this.contentProvider = config.contentProvider ||
      createContentProvider(
        config.contentSourceType || 'disk',
        config.neo4jClient,
        config.projectId
      );

    // Store parser options for document/media parsing with Vision
    this.parserOptions = config.parserOptions;
  }

  /**
   * Update parser options (for per-call configuration in ingestVirtualFiles)
   */
  setParserOptions(options: ParserOptionsConfig | undefined): void {
    this.parserOptions = options;
  }

  /**
   * Process a single file through the complete pipeline:
   * 1. Transition: discovered → parsing
   * 2. Read file content
   * 3. Check hash (skip if unchanged)
   * 4. Parse with UniversalSourceAdapter
   * 5. Transition: parsing → parsed
   * 6. Delete old scopes
   * 7. Create new scopes in Neo4j (batch)
   * 8. Transition: parsed → relations
   * 9. Extract and create references
   * 10. Transition: relations → linked
   */
  async processFile(file: FileInfo): Promise<ProcessResult> {
    const startTime = Date.now();

    try {
      // 0. Re-check current state from database (in case it was updated since queuing)
      // This prevents race conditions where:
      // - read_file calls touchFile (state="discovered")
      // - Watcher queues the file for processing
      // - read_file calls updateMediaContent which sets state="linked"
      // - Watcher starts processFile with stale state info
      const currentStateResult = await this.neo4jClient.run(
        `MATCH (f:File {uuid: $uuid}) RETURN f._state as state`,
        { uuid: file.uuid }
      );

      if (currentStateResult.records.length > 0) {
        const currentState = currentStateResult.records[0].get('state');
        // Skip if file is already being processed or was processed by another path
        // - 'parsing': being processed by updateMediaContent or another processFile call
        // - 'linked': content nodes created, waiting for embeddings
        // - 'embedded': fully processed with embeddings
        if (currentState === 'parsing' || currentState === 'linked' || currentState === 'embedded') {
          // File already processed by another path (e.g., read_file → updateMediaContent)
          if (this.verbose) {
            console.log(`[FileProcessor] Skipping ${file.absolutePath}: already in state '${currentState}'`);
          }
          return { status: 'skipped', scopesCreated: 0, relationshipsCreated: 0, referencesCreated: 0 };
        }
      }

      // 1. Transition to parsing state
      await this.stateMachine.transition(file.uuid, 'parsing');

      // 2. Read file content using content provider
      let content: string;
      try {
        const contentFile: ContentFileInfo = {
          uuid: file.uuid,
          absolutePath: file.absolutePath,
          projectId: this.projectId,
          state: file.state,
        };
        content = await this.contentProvider.readContent(contentFile);
      } catch (err: any) {
        // File may have been deleted (disk) or _rawContent missing (virtual)
        if (err.code === 'ENOENT' || err.message?.includes('No _rawContent')) {
          await this.deleteFileAndScopes(file.absolutePath);
          return { status: 'deleted', scopesCreated: 0, relationshipsCreated: 0, referencesCreated: 0 };
        }
        throw err;
      }

      // 3. Compute and check hash
      const newHash = this.computeHash(content);
      if (file.hash === newHash) {
        // File unchanged - transition directly to linked
        await this.stateMachine.transition(file.uuid, 'linked', { contentHash: newHash });
        return { status: 'skipped', scopesCreated: 0, relationshipsCreated: 0, referencesCreated: 0, newHash };
      }

      // 4. Parse the file
      const fileName = path.basename(file.absolutePath);
      const isVirtualMode = this.config.contentSourceType === 'virtual';

      let parseResult;
      if (isVirtualMode) {
        // Virtual mode: pass content directly to avoid disk read
        parseResult = await this.adapter.parse({
          source: {
            type: 'virtual',
            virtualFiles: [{ path: file.absolutePath, content }],
          },
          projectId: this.projectId,
          parserOptions: this.parserOptions,
        });
      } else {
        parseResult = await this.adapter.parse({
          source: {
            type: 'code',
            root: path.dirname(file.absolutePath),
            include: [fileName],
          },
          projectId: this.projectId,
          parserOptions: this.parserOptions,
        });
      }

      // 5. Transition to parsed state
      await this.stateMachine.transition(file.uuid, 'parsed', { contentHash: newHash });

      // 6. Create/update scopes (batch with MERGE - incremental)
      let scopesCreated = 0;
      let scopesSkipped = 0;
      let relationshipsCreated = 0;
      let createdNodes: Array<{ uuid: string; label: string }> = [];
      const newNodeUuids = new Set<string>();

      if (parseResult?.graph && parseResult.graph.nodes.length > 0) {
        // Prepare nodes with proper properties and _contentHash
        const preparedNodes = this.prepareNodes(parseResult.graph.nodes, file.absolutePath);

        // Collect UUIDs of nodes from the parse (to detect orphans later)
        for (const node of preparedNodes) {
          newNodeUuids.add(node.properties.uuid as string);
        }

        // Batch create/update nodes using MERGE (skips unchanged nodes)
        const createResult = await this.createNodesBatch(preparedNodes, file.absolutePath);
        scopesCreated = createResult.count;
        scopesSkipped = createResult.skippedCount;
        createdNodes = createResult.createdNodes;

        // Batch create relationships from the graph
        if (parseResult.graph.relationships && parseResult.graph.relationships.length > 0) {
          relationshipsCreated = await this.createRelationshipsBatch(parseResult.graph.relationships);
        }
      }

      // 7. Delete orphan nodes (nodes in DB that are no longer in the parse)
      const orphansDeleted = await this.deleteOrphanScopes(file.absolutePath, newNodeUuids);

      // 8. Transition to relations state
      await this.stateMachine.transition(file.uuid, 'relations');

      // 9. Extract and create references
      let referencesCreated = 0;
      try {
        referencesCreated = await this.processFileReferences(file.absolutePath, content, file.uuid);
      } catch (err: any) {
        if (this.verbose) {
          console.warn(`[FileProcessor] Error processing references for ${fileName}: ${err.message}`);
        }
      }

      // 10. Transition to linked state
      await this.stateMachine.transition(file.uuid, 'linked');
      await this.updateFileHash(file.absolutePath, newHash, content.split('\n').length);

      // Notify that file was linked (to resolve PENDING_IMPORT relations)
      if (this.config.onFileLinked) {
        try {
          await this.config.onFileLinked(file.absolutePath);
        } catch (err: any) {
          if (this.verbose) {
            console.warn(`[FileProcessor] Error in onFileLinked for ${fileName}: ${err.message}`);
          }
        }
      }

      if (this.verbose) {
        const duration = Date.now() - startTime;
        const changes = scopesCreated > 0 ? `${scopesCreated} changed` : '';
        const unchanged = scopesSkipped > 0 ? `${scopesSkipped} unchanged` : '';
        const deleted = orphansDeleted > 0 ? `${orphansDeleted} deleted` : '';
        const summary = [changes, unchanged, deleted].filter(Boolean).join(', ') || 'no changes';
        console.log(`[FileProcessor] Parsed ${fileName}: ${summary}, ${relationshipsCreated} rels, ${referencesCreated} refs (${duration}ms)`);
      }

      return {
        status: 'parsed',
        scopesCreated,
        relationshipsCreated,
        referencesCreated,
        newHash,
        createdNodes,
      };
    } catch (err: any) {
      // Transition to error state
      await this.stateMachine.transition(file.uuid, 'error', {
        errorType: 'parse',
        errorMessage: err.message,
      });

      if (this.verbose) {
        console.error(`[FileProcessor] Error processing ${file.absolutePath}: ${err.message}`);
      }

      return {
        status: 'error',
        scopesCreated: 0,
        relationshipsCreated: 0,
        referencesCreated: 0,
        error: err.message,
      };
    }
  }

  /**
   * Batch process multiple files with concurrency control
   */
  async processBatch(files: FileInfo[]): Promise<BatchResult> {
    const startTime = Date.now();
    const limit = pLimit(this.concurrency);

    let processed = 0;
    let skipped = 0;
    let deleted = 0;
    let errors = 0;
    let totalScopesCreated = 0;
    let totalRelationshipsCreated = 0;

    const results = await Promise.all(
      files.map(file =>
        limit(async () => {
          const result = await this.processFile(file);
          return result;
        })
      )
    );

    for (const result of results) {
      switch (result.status) {
        case 'parsed':
          processed++;
          totalScopesCreated += result.scopesCreated;
          totalRelationshipsCreated += result.relationshipsCreated;
          break;
        case 'skipped':
          skipped++;
          break;
        case 'deleted':
          deleted++;
          break;
        case 'error':
          errors++;
          break;
      }
    }

    return {
      processed,
      skipped,
      deleted,
      errors,
      totalScopesCreated,
      totalRelationshipsCreated,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Process multiple files through the complete pipeline with ONE adapter.parse() call.
   *
   * Optimizations:
   * - Parallel file reading with pLimit
   * - Single adapter.parse() call for all files
   * - Graph splitting by absolutePath
   * - Batch state transitions
   * - Parallel node/relationship creation
   */
  async processBatchFiles(files: FileInfo[]): Promise<BatchResult> {
    const startTime = Date.now();

    if (files.length === 0) {
      return {
        processed: 0,
        skipped: 0,
        deleted: 0,
        errors: 0,
        totalScopesCreated: 0,
        totalRelationshipsCreated: 0,
        durationMs: 0,
      };
    }

    console.log(`[FileProcessor] 🚀 Starting batch processing of ${files.length} files (concurrency=${this.concurrency})`);

    const limit = pLimit(this.concurrency);

    // 1. Parallel: read files + compute hashes using content provider
    const fileData = await Promise.all(
      files.map(f =>
        limit(async () => {
          try {
            const contentFile: ContentFileInfo = {
              uuid: f.uuid,
              absolutePath: f.absolutePath,
              projectId: this.projectId,
              state: f.state,
            };
            const content = await this.contentProvider.readContent(contentFile);
            const newHash = this.computeHash(content);
            const storedHash = await this.getStoredHash(f.absolutePath);
            return { file: f, content, newHash, storedHash, error: null as Error | null, deleted: false };
          } catch (err: any) {
            // Handle missing files: disk (ENOENT) or virtual (No _rawContent)
            if (err.code === 'ENOENT' || err.message?.includes('No _rawContent')) {
              return { file: f, content: null, newHash: null, storedHash: null, error: null, deleted: true };
            }
            return { file: f, content: null, newHash: null, storedHash: null, error: err as Error, deleted: false };
          }
        })
      )
    );

    // 2. Filter: unchanged files, deleted files, error files
    const toProcess = fileData.filter(d => d.content && d.newHash !== d.storedHash);
    const skipped = fileData.filter(d => d.content && d.newHash === d.storedHash);
    const deleted = fileData.filter(d => d.deleted);
    const errors = fileData.filter(d => d.error);

    // Handle deleted files
    for (const d of deleted) {
      await this.deleteFileAndScopes(d.file.absolutePath);
    }

    // Handle unchanged files - transition directly to linked
    for (const d of skipped) {
      await this.stateMachine.transition(d.file.uuid, 'linked', { contentHash: d.newHash! });
    }

    if (toProcess.length === 0) {
      return {
        processed: 0,
        skipped: skipped.length,
        deleted: deleted.length,
        errors: errors.length,
        totalScopesCreated: 0,
        totalRelationshipsCreated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    console.log(`[FileProcessor] Processing ${toProcess.length} changed files (${skipped.length} skipped, ${deleted.length} deleted)`);

    // 3. Batch transition to 'parsing'
    await this.stateMachine.transitionBatch(
      toProcess.map(d => d.file.uuid),
      'parsing'
    );

    // 4. ONE adapter.parse() call with ALL files
    const fileNames = toProcess.map(d => {
      if (this.projectRoot) {
        return path.relative(this.projectRoot, d.file.absolutePath);
      }
      return path.basename(d.file.absolutePath);
    });

    // Determine the common root for parsing
    const parseRoot = this.projectRoot || path.dirname(toProcess[0].file.absolutePath);

    let parseResult;
    try {
      // Detect if we're in virtual mode (content in Neo4j, not on disk)
      const isVirtualMode = this.config.contentSourceType === 'virtual';

      if (isVirtualMode) {
        // Build virtualFiles array from already-read content
        const virtualFiles = toProcess.map(d => ({
          path: d.file.absolutePath,
          content: d.content!,
        }));

        console.log(`[FileProcessor] 🔄 Calling adapter.parse() with ${virtualFiles.length} virtual files`);
        parseResult = await this.adapter.parse({
          source: {
            type: 'virtual',
            virtualFiles,
          },
          projectId: this.projectId,
          parserOptions: this.parserOptions,
        });
      } else {
        console.log(`[FileProcessor] 🔄 Calling adapter.parse() with ${fileNames.length} files from disk`);
        parseResult = await this.adapter.parse({
          source: {
            type: 'code',
            root: parseRoot,
            include: fileNames,
          },
          projectId: this.projectId,
          parserOptions: this.parserOptions,
        });
      }
    } catch (err: any) {
      console.error(`[FileProcessor] ❌ Batch parse failed: ${err.message}`);
      // Transition all files to error state
      for (const d of toProcess) {
        await this.stateMachine.transition(d.file.uuid, 'error', {
          errorType: 'parse',
          errorMessage: err.message,
        });
      }
      return {
        processed: 0,
        skipped: skipped.length,
        deleted: deleted.length,
        errors: toProcess.length,
        totalScopesCreated: 0,
        totalRelationshipsCreated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // 5. Batch transition to 'parsed'
    await this.stateMachine.transitionBatch(
      toProcess.map(d => d.file.uuid),
      'parsed'
    );

    // 6. Split graph by absolutePath
    const graphsByFile = this.splitGraphByFile(parseResult?.graph);

    // 7. GLOBAL BATCH: Collect all nodes and relationships from all files
    console.log(`[FileProcessor] 📦 Collecting nodes/relationships from ${toProcess.length} files...`);

    const allNodes: PreparedNode[] = [];
    const allRelationships: ParsedRelationship[] = [];
    const nodeUuidsByFile = new Map<string, Set<string>>();

    // 7a. Process file-specific nodes
    for (const d of toProcess) {
      const fileGraph = graphsByFile.get(d.file.absolutePath);
      nodeUuidsByFile.set(d.file.absolutePath, new Set<string>());

      if (fileGraph && fileGraph.nodes.length > 0) {
        const preparedNodes = this.prepareNodes(fileGraph.nodes, d.file.absolutePath);

        // Collect UUIDs for orphan detection per file
        for (const node of preparedNodes) {
          nodeUuidsByFile.get(d.file.absolutePath)!.add(node.properties.uuid as string);
        }

        allNodes.push(...preparedNodes);
      }

      if (fileGraph?.relationships && fileGraph.relationships.length > 0) {
        allRelationships.push(...fileGraph.relationships);
      }
    }

    // 7b. Process global/structural nodes (Directory, ExternalLibrary, Project)
    const globalGraph = graphsByFile.get('__GLOBAL__');
    if (globalGraph && globalGraph.nodes.length > 0) {
      console.log(`[FileProcessor] 📂 Adding ${globalGraph.nodes.length} global nodes (Directory, ExternalLibrary, Project)`);
      const globalNodes = this.prepareGlobalNodes(globalGraph.nodes);
      allNodes.push(...globalNodes);

      if (globalGraph.relationships.length > 0) {
        allRelationships.push(...globalGraph.relationships);
      }
    }

    console.log(`[FileProcessor] 📊 Total: ${allNodes.length} nodes, ${allRelationships.length} relationships`);

    // 8. Create ALL nodes in ONE batch (one query per label type)
    let totalScopesCreated = 0;
    try {
      console.log(`[FileProcessor] 🔨 Creating nodes (global batch)...`);
      const nodeResult = await this.createNodesBatchGlobal(allNodes);
      totalScopesCreated = nodeResult.count;
      console.log(`[FileProcessor] ✅ Nodes created: ${nodeResult.count} (${nodeResult.skippedCount} unchanged)`);
    } catch (err: any) {
      console.error(`[FileProcessor] ❌ Node creation failed: ${err.message}`);
      // Transition all files to error state
      for (const d of toProcess) {
        await this.stateMachine.transition(d.file.uuid, 'error', {
          errorType: 'parse',
          errorMessage: err.message,
        });
      }
      return {
        processed: 0,
        skipped: skipped.length,
        deleted: deleted.length,
        errors: toProcess.length,
        totalScopesCreated: 0,
        totalRelationshipsCreated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // 9. Create ALL relationships in ONE batch (one query per relationship type)
    // Build uuid->label map for fast indexed lookups (100x faster than unlabeled MATCH!)
    const uuidToLabel = new Map<string, string>();
    for (const node of allNodes) {
      uuidToLabel.set(node.properties.uuid as string, node.label);
    }

    let totalRelationshipsCreated = 0;
    try {
      console.log(`[FileProcessor] 🔗 Creating relationships (global batch)...`);
      totalRelationshipsCreated = await this.createRelationshipsBatchWithLabels(allRelationships, uuidToLabel);
      console.log(`[FileProcessor] ✅ Relationships created: ${totalRelationshipsCreated}`);
    } catch (err: any) {
      console.error(`[FileProcessor] ❌ Relationship creation failed: ${err.message}`);
      // Continue - nodes were created, relationships failed
    }

    // 10. Per-file cleanup (orphan deletion, hash update, references)
    console.log(`[FileProcessor] 🧹 Per-file cleanup (${toProcess.length} files)...`);
    const processResults = await Promise.all(
      toProcess.map(d =>
        limit(async () => {
          try {
            const newNodeUuids = nodeUuidsByFile.get(d.file.absolutePath) || new Set<string>();

            // Delete orphan nodes for this file
            await this.deleteOrphanScopes(d.file.absolutePath, newNodeUuids);

            // Update file hash
            await this.updateFileHash(d.file.absolutePath, d.newHash!, d.content!.split('\n').length);

            // Process references
            let referencesCreated = 0;
            try {
              referencesCreated = await this.processFileReferences(d.file.absolutePath, d.content!, d.file.uuid);
            } catch (err: any) {
              if (this.verbose) {
                console.warn(`[FileProcessor] Error processing references: ${err.message}`);
              }
            }

            return { file: d.file, referencesCreated, error: null };
          } catch (err: any) {
            return { file: d.file, referencesCreated: 0, error: err };
          }
        })
      )
    );

    // Separate successes and failures
    const successes = processResults.filter(r => !r.error);
    const failures = processResults.filter(r => r.error);

    // Handle failures
    for (const { file, error } of failures) {
      if (error) {
        await this.stateMachine.transition(file.uuid, 'error', {
          errorType: 'relations',
          errorMessage: error.message,
        });
      }
    }

    // 11. Batch transition successful files to 'linked'
    if (successes.length > 0) {
      // Transition to 'relations' first, then 'linked'
      await this.stateMachine.transitionBatch(
        successes.map(s => s.file.uuid),
        'relations'
      );
      await this.stateMachine.transitionBatch(
        successes.map(s => s.file.uuid),
        'linked'
      );
    }

    // Notify that files were linked
    if (this.config.onFileLinked) {
      for (const { file } of successes) {
        try {
          await this.config.onFileLinked(file.absolutePath);
        } catch (err: any) {
          if (this.verbose) {
            console.warn(`[FileProcessor] Error in onFileLinked: ${err.message}`);
          }
        }
      }
    }

    // totalScopesCreated and totalRelationshipsCreated are already set from global batch operations

    const result = {
      processed: successes.length,
      skipped: skipped.length,
      deleted: deleted.length,
      errors: errors.length + failures.length,
      totalScopesCreated,
      totalRelationshipsCreated,
      durationMs: Date.now() - startTime,
    };

    console.log(`[FileProcessor] ✅ Batch complete: ${result.processed} processed, ${result.skipped} skipped, ${result.errors} errors (${result.durationMs}ms)`);

    return result;
  }

  /**
   * Split a parsed graph by file absolutePath
   */
  private splitGraphByFile(graph?: ParsedGraph): Map<string, { nodes: ParsedNode[]; relationships: ParsedRelationship[] }> {
    const byFile = new Map<string, { nodes: ParsedNode[]; relationships: ParsedRelationship[] }>();

    if (!graph) return byFile;

    // Special key for global/structural nodes (Directory, ExternalLibrary, Project)
    const GLOBAL_KEY = '__GLOBAL__';
    byFile.set(GLOBAL_KEY, { nodes: [], relationships: [] });

    // Labels that are "global" (not tied to a specific source file)
    const globalLabels = new Set(['Directory', 'ExternalLibrary', 'Project']);

    // Group nodes by absolutePath (or GLOBAL for structural nodes)
    for (const node of graph.nodes) {
      const isGlobal = node.labels.some(l => globalLabels.has(l));

      if (isGlobal) {
        // Global nodes go to special bucket
        byFile.get(GLOBAL_KEY)!.nodes.push(node);
      } else {
        // File-specific nodes grouped by absolutePath
        const absPath = node.properties.absolutePath as string;
        if (!absPath) continue;
        if (!byFile.has(absPath)) {
          byFile.set(absPath, { nodes: [], relationships: [] });
        }
        byFile.get(absPath)!.nodes.push(node);
      }
    }

    // Map node ID to file for relationship routing
    const nodeToFile = new Map<string, string>();
    for (const [file, data] of byFile) {
      for (const node of data.nodes) {
        nodeToFile.set(node.id, file);
      }
    }

    // Route relationships to source node's file (or GLOBAL if source is global)
    if (graph.relationships) {
      for (const rel of graph.relationships) {
        const file = nodeToFile.get(rel.from);
        if (file && byFile.has(file)) {
          byFile.get(file)!.relationships.push(rel);
        }
      }
    }

    return byFile;
  }

  /**
   * Check if a file needs processing (hash changed)
   *
   * @param absolutePath - File path
   * @param currentHash - Optional current hash (for optimization)
   * @param fileUuid - Optional file UUID (required for virtual files)
   */
  async needsProcessing(
    absolutePath: string,
    currentHash?: string,
    fileUuid?: string
  ): Promise<{
    needsProcessing: boolean;
    newHash: string;
    reason?: 'new' | 'changed' | 'error_retry';
  }> {
    // Read current file content using content provider
    let content: string;
    try {
      const contentFile: ContentFileInfo = {
        uuid: fileUuid || '',
        absolutePath,
        projectId: this.projectId,
      };
      content = await this.contentProvider.readContent(contentFile);
    } catch (err: any) {
      // File doesn't exist (disk) or no content (virtual)
      if (err.code === 'ENOENT' || err.message?.includes('No _rawContent')) {
        return { needsProcessing: false, newHash: '', reason: undefined };
      }
      throw err;
    }

    const newHash = this.computeHash(content);

    // Check stored hash
    const storedHash = await this.getStoredHash(absolutePath);

    if (!storedHash) {
      return { needsProcessing: true, newHash, reason: 'new' };
    }

    if (storedHash !== newHash) {
      return { needsProcessing: true, newHash, reason: 'changed' };
    }

    // Check if file is in error state (retry)
    const state = await this.getFileState(absolutePath);
    if (state === 'error') {
      return { needsProcessing: true, newHash, reason: 'error_retry' };
    }

    return { needsProcessing: false, newHash };
  }

  /**
   * Create or update File node in Neo4j
   */
  async ensureFileNode(absolutePath: string, options?: {
    projectRoot?: string;
    state?: FileState;
  }): Promise<{ uuid: string; created: boolean }> {
    const fileName = path.basename(absolutePath);
    const extension = path.extname(absolutePath).slice(1);
    const relativePath = options?.projectRoot
      ? path.relative(options.projectRoot, absolutePath)
      : fileName;

    const fileUuid = UniqueIDHelper.GenerateFileUUID(absolutePath);
    const result = await this.neo4jClient.run(`
      MERGE (f:File {absolutePath: $absolutePath})
      ON CREATE SET
        f.uuid = $fileUuid,
        f.name = $name,
        f.extension = $extension,
        f.file = $relativePath,
        f.path = $relativePath,
        f.projectId = $projectId,
        f._state = $state,
        f._stateUpdatedAt = datetime()
      ON MATCH SET
        f.name = $name,
        f.extension = $extension,
        f._pending = null
      RETURN f.uuid AS uuid, f._state IS NULL AS created
    `, {
      absolutePath,
      fileUuid,
      name: fileName,
      extension,
      relativePath,
      projectId: this.projectId,
      state: options?.state || 'discovered',
    });

    const record = result.records[0];
    return {
      uuid: record.get('uuid'),
      created: record.get('created') || false,
    };
  }

  /**
   * Get relative path from absolute path
   */
  getRelativePath(absolutePath: string): string {
    if (this.projectRoot) {
      return path.relative(this.projectRoot, absolutePath);
    }
    return path.basename(absolutePath);
  }

  // ============================================
  // Batch Operations (Optimized)
  // ============================================

  /**
   * Create or update nodes in batch using MERGE
   *
   * Incremental strategy:
   * - Uses MERGE with deterministic UUIDs (no duplicates)
   * - Compares _contentHash to skip unchanged nodes
   * - Only sets _state='linked' on new/changed nodes (needs embedding)
   * - Preserves existing state for unchanged nodes (e.g., 'ready')
   *
   * Returns count and list of created/updated nodes (for state machine transitions)
   */
  private async createNodesBatchGlobal(nodes: PreparedNode[]): Promise<{
    count: number;
    createdNodes: Array<{ uuid: string; label: string }>;
    skippedCount: number;
  }> {
    if (nodes.length === 0) return { count: 0, createdNodes: [], skippedCount: 0 };

    // Group nodes by label for efficient batch creation
    const nodesByLabel = new Map<string, PreparedNode[]>();
    for (const node of nodes) {
      const label = node.label;
      if (!nodesByLabel.has(label)) {
        nodesByLabel.set(label, []);
      }
      nodesByLabel.get(label)!.push(node);
    }

    let totalCreated = 0;
    let totalSkipped = 0;
    const createdNodes: Array<{ uuid: string; label: string }> = [];

    // Create/update nodes for each label type - ONE query per label for ALL files
    for (const [label, labelNodes] of nodesByLabel) {
      // Skip File and Project nodes - they are already managed elsewhere
      if (label === 'File' || label === 'Project') {
        continue;
      }

      const nodeProps = labelNodes.map(n => ({
        uuid: n.properties.uuid,
        contentHash: n.properties._contentHash,
        filePath: n.properties.absolutePath, // Each node carries its own file path
        props: n.properties,
      }));

      // Use MERGE for incremental updates
      // DEFINED_IN relationship uses the node's own filePath (not a global parameter)
      const result = await this.neo4jClient.run(`
        UNWIND $nodes AS nodeData
        MERGE (n:${label} {uuid: nodeData.uuid})
        ON CREATE SET
          n = nodeData.props,
          n._state = 'linked',
          n._linkedAt = datetime(),
          n._wasCreated = true
        ON MATCH SET
          n._wasCreated = false,
          n._wasUpdated = CASE WHEN n._contentHash <> nodeData.contentHash OR n._contentHash IS NULL THEN true ELSE false END
        WITH n, nodeData, n.usesChunks AS preservedUsesChunks
        WHERE n._wasCreated = true OR n._wasUpdated = true
        SET n = nodeData.props,
            n._state = 'linked',
            n._linkedAt = datetime(),
            n.usesChunks = preservedUsesChunks,
            n._pending = null  // Clear placeholder flag when real node arrives
        WITH n, nodeData
        MATCH (f:File {absolutePath: nodeData.filePath})
        MERGE (n)-[:DEFINED_IN]->(f)
        RETURN n._wasCreated AS wasCreated, n._wasUpdated AS wasUpdated, n.uuid AS uuid
      `, { nodes: nodeProps });

      let created = 0;
      let updated = 0;
      for (const record of result.records) {
        const wasCreated = record.get('wasCreated');
        const wasUpdated = record.get('wasUpdated');
        const uuid = record.get('uuid');

        if (wasCreated) {
          created++;
          createdNodes.push({ uuid, label });
        } else if (wasUpdated) {
          updated++;
          createdNodes.push({ uuid, label });
        }
      }

      totalCreated += created + updated;
      totalSkipped += labelNodes.length - (created + updated);

      if (this.verbose && (created > 0 || updated > 0)) {
        console.log(`[FileProcessor] ${label}: ${created} created, ${updated} updated, ${labelNodes.length - created - updated} unchanged`);
      }
    }

    // Clean up temporary flags in a single query (no filePath filter needed)
    await this.neo4jClient.run(`
      MATCH (n)
      WHERE n._wasCreated IS NOT NULL OR n._wasUpdated IS NOT NULL
      REMOVE n._wasCreated, n._wasUpdated
    `);

    return { count: totalCreated, createdNodes, skippedCount: totalSkipped };
  }

  /**
   * Create or update nodes in a batch for a single file using MERGE
   * NOTE: This method is kept for backward compatibility. For multi-file batching,
   * use createNodesBatchGlobal() instead.
   */
  private async createNodesBatch(nodes: PreparedNode[], filePath: string): Promise<{
    count: number;
    createdNodes: Array<{ uuid: string; label: string }>;
    skippedCount: number;
  }> {
    if (nodes.length === 0) return { count: 0, createdNodes: [], skippedCount: 0 };

    // Group nodes by label for efficient batch creation
    const nodesByLabel = new Map<string, PreparedNode[]>();
    for (const node of nodes) {
      const label = node.label;
      if (!nodesByLabel.has(label)) {
        nodesByLabel.set(label, []);
      }
      nodesByLabel.get(label)!.push(node);
    }

    let totalCreated = 0;
    let totalSkipped = 0;
    const createdNodes: Array<{ uuid: string; label: string }> = [];

    // Create/update nodes for each label type
    for (const [label, labelNodes] of nodesByLabel) {
      // Skip File and Project nodes - they are already managed elsewhere:
      // - File nodes are created by touchFile() or ensureFileNode()
      // - Project nodes should NOT be created for touched-files (orphan files)
      // Creating them here would cause duplicates with different UUIDs
      if (label === 'File' || label === 'Project') {
        continue;
      }

      const nodeProps = labelNodes.map(n => ({
        uuid: n.properties.uuid,
        contentHash: n.properties._contentHash,
        props: n.properties,
      }));

      // Use MERGE for incremental updates
      // - ON CREATE: set all properties + _state='linked' (needs embedding)
      // - ON MATCH: only update if _contentHash changed, reset to 'linked' state
      // This ensures unchanged nodes keep their state (e.g., 'ready') and embeddings
      // IMPORTANT: Preserve usesChunks so embedding service can detect when to cleanup chunks
      const result = await this.neo4jClient.run(`
        UNWIND $nodes AS nodeData
        MERGE (n:${label} {uuid: nodeData.uuid})
        ON CREATE SET
          n = nodeData.props,
          n._state = 'linked',
          n._linkedAt = datetime(),
          n._wasCreated = true
        ON MATCH SET
          n._wasCreated = false,
          n._wasUpdated = CASE WHEN n._contentHash <> nodeData.contentHash OR n._contentHash IS NULL THEN true ELSE false END
        WITH n, nodeData, n.usesChunks AS preservedUsesChunks
        WHERE n._wasCreated = true OR n._wasUpdated = true
        SET n = nodeData.props,
            n._state = 'linked',
            n._linkedAt = datetime(),
            n.usesChunks = preservedUsesChunks,
            n._pending = null  // Clear placeholder flag when real node arrives
        WITH n
        MATCH (f:File {absolutePath: $filePath})
        MERGE (n)-[:DEFINED_IN]->(f)
        RETURN n._wasCreated AS wasCreated, n._wasUpdated AS wasUpdated, n.uuid AS uuid
      `, { nodes: nodeProps, filePath });

      let created = 0;
      let updated = 0;
      for (const record of result.records) {
        const wasCreated = record.get('wasCreated');
        const wasUpdated = record.get('wasUpdated');
        const uuid = record.get('uuid');

        if (wasCreated) {
          created++;
          createdNodes.push({ uuid, label });
        } else if (wasUpdated) {
          updated++;
          createdNodes.push({ uuid, label }); // Also track updated nodes for state machine
        }
      }

      totalCreated += created + updated;
      totalSkipped += labelNodes.length - (created + updated);

      if (this.verbose && (created > 0 || updated > 0)) {
        console.log(`[FileProcessor] ${label}: ${created} created, ${updated} updated, ${labelNodes.length - created - updated} unchanged`);
      }
    }

    // Clean up temporary flags
    await this.neo4jClient.run(`
      MATCH (n)-[:DEFINED_IN]->(:File {absolutePath: $filePath})
      WHERE n._wasCreated IS NOT NULL OR n._wasUpdated IS NOT NULL
      REMOVE n._wasCreated, n._wasUpdated
    `, { filePath });

    return { count: totalCreated, createdNodes, skippedCount: totalSkipped };
  }

  /**
   * Create or update relationships in batch using MERGE
   * Uses MERGE to avoid duplicate relationships during incremental ingestion
   */
  private async createRelationshipsBatch(relationships: ParsedRelationship[]): Promise<number> {
    if (relationships.length === 0) return 0;

    // Group relationships by type for efficient batch creation
    const relsByType = new Map<string, ParsedRelationship[]>();
    for (const rel of relationships) {
      if (!relsByType.has(rel.type)) {
        relsByType.set(rel.type, []);
      }
      relsByType.get(rel.type)!.push(rel);
    }

    let totalCreated = 0;

    // Create/update relationships for each type
    for (const [relType, typeRels] of relsByType) {
      const relData = typeRels.map(r => ({
        from: r.from,
        to: r.to,
        props: r.properties || {},
      }));

      // Use MERGE to avoid duplicates during incremental ingestion
      const result = await this.neo4jClient.run(`
        UNWIND $rels AS relData
        MATCH (source {uuid: relData.from}), (target {uuid: relData.to})
        MERGE (source)-[r:${relType}]->(target)
        ON CREATE SET r = relData.props
        ON MATCH SET r += relData.props
        RETURN count(r) AS created
      `, { rels: relData });

      const created = result.records[0]?.get('created');
      totalCreated += (typeof created === 'number' ? created : created?.toNumber?.() || 0);
    }

    return totalCreated;
  }

  /**
   * Create relationships with labeled MATCH for 100x faster index lookups
   * Groups by (relType, fromLabel, toLabel) for optimal query batching
   * Pre-queries labels for unknown UUIDs to avoid slow unlabeled MATCH
   */
  private async createRelationshipsBatchWithLabels(
    relationships: ParsedRelationship[],
    uuidToLabel: Map<string, string>
  ): Promise<number> {
    if (relationships.length === 0) return 0;

    // Step 1: Collect all UUIDs that aren't in our map (cross-file references)
    const unknownUuids = new Set<string>();
    for (const rel of relationships) {
      if (!uuidToLabel.has(rel.from)) unknownUuids.add(rel.from);
      if (!uuidToLabel.has(rel.to)) unknownUuids.add(rel.to);
    }

    // Step 1b: Create placeholder nodes for targets that have targetLabel/targetProps
    // This ensures all targets exist before creating relationships (no silent failures!)
    const placeholdersByLabel = new Map<string, Array<{ uuid: string; props: Record<string, unknown> }>>();
    for (const rel of relationships) {
      if (rel.targetLabel && rel.targetProps && unknownUuids.has(rel.to)) {
        if (!placeholdersByLabel.has(rel.targetLabel)) {
          placeholdersByLabel.set(rel.targetLabel, []);
        }
        // Avoid duplicates
        const existing = placeholdersByLabel.get(rel.targetLabel)!;
        if (!existing.some(p => p.uuid === rel.to)) {
          existing.push({
            uuid: rel.to,
            props: {
              ...rel.targetProps,
              uuid: rel.to,
              projectId: this.projectId,
            }
          });
        }
      }
    }

    // Create placeholders by label (one UNWIND query per label type)
    if (placeholdersByLabel.size > 0) {
      let totalPlaceholders = 0;
      const placeholderCounts: string[] = [];

      for (const [label, placeholders] of placeholdersByLabel) {
        if (placeholders.length === 0) continue;

        await this.neo4jClient.run(`
          UNWIND $nodes AS nodeData
          MERGE (n:${label} {uuid: nodeData.uuid})
          ON CREATE SET
            n = nodeData.props,
            n._pending = true,
            n._state = 'linked',
            n._linkedAt = datetime()
          ON MATCH SET
            n._pending = null
        `, { nodes: placeholders });

        totalPlaceholders += placeholders.length;
        placeholderCounts.push(`${label}: ${placeholders.length}`);

        // Update uuidToLabel map with the created placeholders
        for (const p of placeholders) {
          uuidToLabel.set(p.uuid, label);
          unknownUuids.delete(p.uuid); // No longer unknown
        }
      }

      console.log(`[FileProcessor] 📦 Created ${totalPlaceholders} placeholder nodes (${placeholderCounts.join(', ')})`);
    }

    // Step 2: Pre-query labels for unknown UUIDs from Neo4j using LABELED queries (fast!)
    if (unknownUuids.size > 0) {
      console.log(`[FileProcessor] 🔍 Pre-querying labels for ${unknownUuids.size} cross-file references...`);
      const unknownArray = Array.from(unknownUuids);

      // Query each label type separately for indexed lookups
      const labelsToCheck = [
        'File', 'Directory', 'Project', 'ExternalLibrary',
        'Scope', 'MarkdownSection', 'MarkdownDocument', 'CodeBlock',
        'DataFile', 'PackageJson', 'WebDocument', 'WebPage',
        'ImageFile', 'MediaFile', 'ThreeDFile', 'DocumentFile',
        'Stylesheet', 'VueSFC', 'SvelteComponent'
      ];

      for (const label of labelsToCheck) {
        // Skip if all UUIDs are already resolved
        const remaining = unknownArray.filter(uuid => !uuidToLabel.has(uuid));
        if (remaining.length === 0) break;

        const result = await this.neo4jClient.run(`
          MATCH (n:${label})
          WHERE n.uuid IN $uuids
          RETURN n.uuid AS uuid, '${label}' AS label
        `, { uuids: remaining });

        for (const record of result.records) {
          const uuid = record.get('uuid');
          if (uuid) {
            uuidToLabel.set(uuid, label);
          }
        }
      }

      const resolved = unknownArray.filter(uuid => uuidToLabel.has(uuid)).length;
      const unresolved = unknownArray.length - resolved;
      console.log(`[FileProcessor] ✅ Labels resolved: ${resolved}/${unknownArray.length} (${unresolved} unresolved)`);
    }

    // Step 3: Group relationships by (type, fromLabel, toLabel) for specific indexed queries
    const relsByTypeAndLabels = new Map<string, Array<{ from: string; to: string; props: Record<string, unknown> }>>();

    for (const rel of relationships) {
      const fromLabel = uuidToLabel.get(rel.from) || null; // null = truly unknown (shouldn't happen often now)
      const toLabel = uuidToLabel.get(rel.to) || null;
      const key = `${rel.type}|${fromLabel || '_'}|${toLabel || '_'}`;

      if (!relsByTypeAndLabels.has(key)) {
        relsByTypeAndLabels.set(key, []);
      }
      relsByTypeAndLabels.get(key)!.push({
        from: rel.from,
        to: rel.to,
        props: rel.properties || {},
      });
    }

    const batchSize = 500;
    let totalCreated = 0;

    // Log unlabeled matches (slow queries)
    let unlabeledCount = 0;
    let labeledCount = 0;
    for (const [key, rels] of relsByTypeAndLabels) {
      const [, fromLabelKey, toLabelKey] = key.split('|');
      if (fromLabelKey === '_' || toLabelKey === '_') {
        unlabeledCount += rels.length;
        console.log(`[FileProcessor] ⚠️  UNLABELED: ${rels.length} ${key.split('|')[0]} (${fromLabelKey}→${toLabelKey})`);
      } else {
        labeledCount += rels.length;
      }
    }
    if (unlabeledCount > 0) {
      console.log(`[FileProcessor] 📊 Relationships: ${labeledCount} labeled (fast), ${unlabeledCount} unlabeled (slow)`);
    }

    // Step 4: Process each relationship type+label combination SEQUENTIALLY (avoids deadlocks)
    for (const [key, rels] of relsByTypeAndLabels) {
      const [relType, fromLabelKey, toLabelKey] = key.split('|');
      const fromLabel = fromLabelKey === '_' ? null : fromLabelKey;
      const toLabel = toLabelKey === '_' ? null : toLabelKey;

      // Use labeled MATCH for indexed lookups (100x faster!)
      const fromMatch = fromLabel ? `(source:${fromLabel} {uuid: relData.from})` : `(source {uuid: relData.from})`;
      const toMatch = toLabel ? `(target:${toLabel} {uuid: relData.to})` : `(target {uuid: relData.to})`;

      for (let i = 0; i < rels.length; i += batchSize) {
        const batch = rels.slice(i, i + batchSize);

        const result = await this.neo4jClient.run(`
          UNWIND $rels AS relData
          MATCH ${fromMatch}
          MATCH ${toMatch}
          MERGE (source)-[r:${relType}]->(target)
          SET r += relData.props
        `, { rels: batch });

        totalCreated += batch.length;
      }

      const fromDisplay = fromLabel || 'Node';
      const toDisplay = toLabel || 'Node';
      console.log(`   🔗 ${rels.length} ${relType} (${fromDisplay}→${toDisplay})`);
    }

    return totalCreated;
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Prepare nodes for batch insertion
   * Computes _contentHash from _name + _content + _description for incrementality
   */
  private prepareNodes(nodes: ParsedNode[], filePath: string): PreparedNode[] {
    const relativePath = this.getRelativePath(filePath);

    return nodes.map(node => {
      // Compute _contentHash from normalized fields for incrementality
      const _name = node.properties._name as string || '';
      const _content = node.properties._content as string || '';
      const _description = node.properties._description as string || '';
      const _contentHash = this.computeHash(`${_name}|${_content}|${_description}`);

      return {
        label: node.labels[0] || 'Scope',
        properties: {
          ...node.properties,
          uuid: node.id || crypto.randomUUID(),
          projectId: this.projectId,
          file: relativePath,
          absolutePath: filePath,
          _contentHash,
          // Don't set _state here - it will be set to 'linked' only if content changed
        },
      };
    });
  }

  /**
   * Prepare global/structural nodes (Directory, ExternalLibrary, Project)
   * These nodes keep their original absolutePath and don't get file-specific properties
   */
  private prepareGlobalNodes(nodes: ParsedNode[]): PreparedNode[] {
    return nodes.map(node => {
      const label = node.labels[0] || 'Directory';

      // For global nodes, use their existing properties without overwriting
      return {
        label,
        properties: {
          ...node.properties,
          uuid: node.id || crypto.randomUUID(),
          projectId: this.projectId,
          // Keep original absolutePath and path from the parser
        },
      };
    });
  }

  /**
   * Compute content hash
   */
  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  /**
   * Get stored hash for a file
   */
  private async getStoredHash(absolutePath: string): Promise<string | null> {
    const result = await this.neo4jClient.run(`
      MATCH (f:File {absolutePath: $absolutePath, projectId: $projectId})
      RETURN f.hash AS hash
    `, { absolutePath, projectId: this.projectId });

    return result.records[0]?.get('hash') || null;
  }

  /**
   * Get file state
   */
  private async getFileState(absolutePath: string): Promise<FileState | null> {
    const result = await this.neo4jClient.run(`
      MATCH (f:File {absolutePath: $absolutePath, projectId: $projectId})
      RETURN f._state AS state
    `, { absolutePath, projectId: this.projectId });

    return result.records[0]?.get('state') || null;
  }

  /**
   * Update file hash and line count
   */
  private async updateFileHash(absolutePath: string, hash: string, lineCount?: number): Promise<void> {
    await this.neo4jClient.run(`
      MATCH (f:File {absolutePath: $absolutePath, projectId: $projectId})
      SET f.hash = $hash,
          f.lineCount = $lineCount
    `, { absolutePath, projectId: this.projectId, hash, lineCount: lineCount || null });
  }

  /**
   * Delete file scopes (all nodes for this file) + their EmbeddingChunks
   * @deprecated Use deleteOrphanScopes for incremental ingestion
   */
  private async deleteFileScopes(absolutePath: string): Promise<void> {
    await this.neo4jClient.run(`
      MATCH (n)-[:DEFINED_IN]->(f:File {absolutePath: $absolutePath})
      WHERE n.projectId = $projectId
      // First delete any EmbeddingChunk children
      OPTIONAL MATCH (n)-[:HAS_EMBEDDING_CHUNK]->(chunk:EmbeddingChunk)
      DETACH DELETE chunk
      WITH n
      DETACH DELETE n
    `, { absolutePath, projectId: this.projectId });
  }

  /**
   * Delete orphan scopes - nodes in DB that are no longer in the parse
   * Used for incremental ingestion to clean up deleted sections
   *
   * @param absolutePath - File path
   * @param currentUuids - Set of UUIDs from the current parse
   * @returns Number of nodes deleted
   */
  private async deleteOrphanScopes(absolutePath: string, currentUuids: Set<string>): Promise<number> {
    if (currentUuids.size === 0) {
      // No nodes in parse = delete all scopes + their EmbeddingChunks
      const result = await this.neo4jClient.run(`
        MATCH (n)-[:DEFINED_IN]->(f:File {absolutePath: $absolutePath})
        WHERE n.projectId = $projectId
        // First delete any EmbeddingChunk children
        OPTIONAL MATCH (n)-[:HAS_EMBEDDING_CHUNK]->(chunk:EmbeddingChunk)
        DETACH DELETE chunk
        WITH n
        DETACH DELETE n
        RETURN count(*) AS deleted
      `, { absolutePath, projectId: this.projectId });

      const deleted = result.records[0]?.get('deleted');
      return typeof deleted === 'number' ? deleted : deleted?.toNumber?.() || 0;
    }

    // Delete nodes that are not in the current parse + their EmbeddingChunks
    const result = await this.neo4jClient.run(`
      MATCH (n)-[:DEFINED_IN]->(f:File {absolutePath: $absolutePath})
      WHERE n.projectId = $projectId AND NOT n.uuid IN $uuids
      // First delete any EmbeddingChunk children
      OPTIONAL MATCH (n)-[:HAS_EMBEDDING_CHUNK]->(chunk:EmbeddingChunk)
      DETACH DELETE chunk
      WITH n
      DETACH DELETE n
      RETURN count(*) AS deleted
    `, { absolutePath, projectId: this.projectId, uuids: Array.from(currentUuids) });

    const deleted = result.records[0]?.get('deleted');
    return typeof deleted === 'number' ? deleted : deleted?.toNumber?.() || 0;
  }

  /**
   * Delete file and all its scopes
   */
  private async deleteFileAndScopes(absolutePath: string): Promise<void> {
    // Delete scopes first
    await this.deleteFileScopes(absolutePath);

    // Delete the file node
    await this.neo4jClient.run(`
      MATCH (f:File {absolutePath: $absolutePath, projectId: $projectId})
      DETACH DELETE f
    `, { absolutePath, projectId: this.projectId });

    if (this.verbose) {
      console.log(`[FileProcessor] Deleted ${absolutePath} (file not found)`);
    }
  }

  /**
   * Process file imports and create references
   */
  private async processFileReferences(
    filePath: string,
    content: string,
    fileUuid: string
  ): Promise<number> {
    // Extract references
    const refs = extractReferences(content, filePath);
    if (refs.length === 0) {
      return 0;
    }

    // Resolve references to absolute paths
    const projectPath = this.projectRoot || path.dirname(filePath);
    const resolvedRefs = await resolveAllReferences(refs, filePath, projectPath);

    // Process each reference
    let created = 0;

    if (this.config.onGetFileState && this.config.onCreateMentionedFile) {
      // Orphan file mode - handle PENDING_IMPORT creation
      for (const ref of resolvedRefs) {
        const targetState = await this.config.onGetFileState(ref.absolutePath);

        if (targetState === 'linked' || targetState === 'embedded') {
          // Target is already linked - create relation directly
          const result = await createReferenceRelations(
            this.neo4jClient,
            fileUuid,
            filePath,
            [ref],
            this.projectId,
            { useAbsolutePath: true, createPending: false }
          );
          created += result.created;
        } else {
          // Target not linked - create mentioned file + PENDING_IMPORT
          await this.config.onCreateMentionedFile(ref.absolutePath, {
            filePath,
            symbols: ref.symbols,
            importPath: ref.source,
          });
          created++;
        }
      }
    } else {
      // Project file mode - use batch reference creation
      const result = await createReferenceRelations(
        this.neo4jClient,
        fileUuid,
        filePath,
        resolvedRefs,
        this.projectId,
        { useAbsolutePath: true, createPending: true }
      );
      created = result.created;
    }

    return created;
  }
}

// ============================================
// Internal Types
// ============================================

interface PreparedNode {
  label: string;
  properties: Record<string, any>;
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a FileProcessor for orphan files (touched-files)
 */
export function createOrphanFileProcessor(
  neo4jClient: Neo4jClient,
  options?: Partial<FileProcessorConfig>
): FileProcessor {
  return new FileProcessor({
    neo4jClient,
    projectId: 'touched-files',
    verbose: false,
    concurrency: 10,
    ...options,
  });
}

/**
 * Create a FileProcessor for project files
 */
export function createProjectFileProcessor(
  neo4jClient: Neo4jClient,
  projectId: string,
  projectRoot: string,
  options?: Partial<FileProcessorConfig>
): FileProcessor {
  return new FileProcessor({
    neo4jClient,
    projectId,
    projectRoot,
    verbose: false,
    concurrency: 10,
    ...options,
  });
}
