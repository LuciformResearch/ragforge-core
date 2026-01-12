/**
 * Incremental Ingestion Module
 *
 * Provides utilities for incremental code ingestion based on content hashes.
 * Uses UniversalSourceAdapter for all file types (code, documents, media, data).
 */

import type { Neo4jClient } from '../client/neo4j-client.js';
import type { ParsedGraph, ParsedNode, ParsedRelationship, SourceConfig, SourceAdapter } from './types.js';
import { UniversalSourceAdapter } from './universal-source-adapter.js';
import { ChangeTracker } from './change-tracker.js';
import { isStructuralNode } from '../../utils/node-schema.js';
import { addSchemaVersion } from '../../utils/schema-version.js';
import { createHash } from 'crypto';
import fg from 'fast-glob';
import * as pathModule from 'path';
import * as fs from 'fs/promises';
import {
  extractReferences,
  resolveAllReferences,
  createReferenceRelations,
  resolvePendingImports,
  type ResolvedReference,
  type RelationType,
} from '../../brain/reference-extractor.js';
import {
  FileStateMachine,
  FileStateMigration,
  type FileState,
  type FileStateInfo,
} from '../../brain/file-state-machine.js';
import {
  FileProcessor,
  type FileInfo,
  type BatchResult as FileProcessorBatchResult,
} from '../../brain/file-processor.js';
import { STATE_PROPERTIES as P } from '../../ingestion/state-types.js';

export interface IncrementalStats {
  unchanged: number;
  updated: number;
  created: number;
  deleted: number;
}

/**
 * Callback for reporting ingestion progress
 * @param phase - Current phase (nodes, relationships, etc.)
 * @param current - Current item number
 * @param total - Total items in this phase
 * @param message - Human-readable status message
 */
export type ProgressCallback = (
  phase: string,
  current: number,
  total: number,
  message?: string
) => void;

export interface IngestionOptions {
  /** Project ID to scope the ingestion */
  projectId?: string;
  /** Dry run - don't actually modify the database */
  dryRun?: boolean;
  /** Verbose logging */
  verbose?: boolean;
  /** Enable change tracking with diffs */
  trackChanges?: boolean;
  /** Clean up orphaned relationships */
  cleanupRelationships?: boolean;
  /** Pre-queried UUID mapping for UUID preservation during re-ingestion */
  existingUUIDMapping?: Map<string, Array<{ uuid: string; file: string; type: string }>>;
  /** Progress callback for streaming updates */
  onProgress?: ProgressCallback;
}

// Singleton adapter instance (reused across calls)
let universalAdapter: UniversalSourceAdapter | null = null;

/**
 * Get or create the universal source adapter
 */
function getAdapter(): SourceAdapter {
  if (!universalAdapter) {
    universalAdapter = new UniversalSourceAdapter();
  }
  return universalAdapter;
}

export class IncrementalIngestionManager {
  private changeTracker: ChangeTracker;
  private _stateMachine?: FileStateMachine;
  private _stateMigration?: FileStateMigration;
  private _fileProcessors: Map<string, FileProcessor> = new Map();

  constructor(private client: Neo4jClient) {
    this.changeTracker = new ChangeTracker(client);
  }

  /**
   * Get the file state machine (lazy initialized)
   * Use this to track file states through the ingestion pipeline
   */
  get stateMachine(): FileStateMachine {
    if (!this._stateMachine) {
      this._stateMachine = new FileStateMachine(this.client);
    }
    return this._stateMachine;
  }

  /**
   * Get the state migration helper (lazy initialized)
   * Use this to migrate existing data to the state machine model
   */
  get stateMigration(): FileStateMigration {
    if (!this._stateMigration) {
      this._stateMigration = new FileStateMigration(this.client);
    }
    return this._stateMigration;
  }

  /**
   * Get or create a FileProcessor for a specific project
   * FileProcessor provides optimized batch operations for file processing
   *
   * @param projectId - Project ID
   * @param projectRoot - Project root path
   * @param options - Optional configuration
   */
  getFileProcessor(
    projectId: string,
    projectRoot: string,
    options?: {
      verbose?: boolean;
      concurrency?: number;
    }
  ): FileProcessor {
    const cacheKey = `${projectId}:${projectRoot}`;

    if (!this._fileProcessors.has(cacheKey)) {
      this._fileProcessors.set(cacheKey, new FileProcessor({
        neo4jClient: this.client,
        stateMachine: this.stateMachine,
        projectId,
        projectRoot,
        verbose: options?.verbose ?? false,
        concurrency: options?.concurrency ?? 10,
      }));
    }

    return this._fileProcessors.get(cacheKey)!;
  }

  /**
   * Reprocess files using FileProcessor with state machine integration
   *
   * This is the recommended method for reprocessing files as it:
   * - Uses UNWIND batching for optimal performance
   * - Integrates with FileStateMachine for tracking
   * - Handles state transitions automatically
   *
   * @param projectId - Project ID
   * @param projectRoot - Project root path
   * @param files - Files to reprocess (array of {absolutePath, uuid, hash, state})
   * @param options - Processing options
   */
  async reprocessFilesWithStateMachine(
    projectId: string,
    projectRoot: string,
    files: FileInfo[],
    options?: {
      verbose?: boolean;
      concurrency?: number;
    }
  ): Promise<FileProcessorBatchResult> {
    const processor = this.getFileProcessor(projectId, projectRoot, options);
    return processor.processBatch(files);
  }

  /**
   * Get files that need reprocessing (in 'discovered' state) for a project
   * These files are pending parsing in the state machine pipeline
   */
  async getFilesNeedingReprocessing(projectId: string): Promise<FileInfo[]> {
    const stateInfo = await this.stateMachine.getFilesInState(projectId, 'discovered');

    if (stateInfo.length === 0) return [];

    // Fetch additional file details
    const uuids = stateInfo.map(s => s.uuid);
    const result = await this.client.run(
      `MATCH (f:File)
       WHERE f.uuid IN $uuids
       RETURN f.uuid AS uuid, f.absolutePath AS absolutePath, f.name AS name,
              f.extension AS extension, f.hash AS hash, f.state AS state`,
      { uuids }
    );

    return result.records.map(r => ({
      uuid: r.get('uuid'),
      absolutePath: r.get('absolutePath'),
      name: r.get('name'),
      extension: r.get('extension'),
      hash: r.get('hash'),
      state: r.get('state') || 'discovered',
    }));
  }

  /**
   * Get existing hashes and content for a set of node UUIDs
   * Used for incremental ingestion to detect changes and generate diffs
   *
   * Works with ALL content node types:
   * - Scope, DataFile, MediaFile, DocumentFile
   * - VueSFC, SvelteComponent, Stylesheet
   * - MarkdownDocument, CodeBlock, DataSection
   *
   * @param nodeIds - UUIDs to look up
   * @param projectId - Optional project ID to filter by
   */
  async getExistingHashes(
    nodeIds: string[],
    projectId?: string
  ): Promise<Map<string, { uuid: string; hash: string; source?: string; textContent?: string; name?: string; file?: string; labels?: string[]; schemaDirty?: boolean }>> {
    if (nodeIds.length === 0) {
      return new Map();
    }

    // Query ALL nodes by UUID (not just Scope)
    // Optionally filter by projectId
    const query = projectId
      ? `
        MATCH (n)
        WHERE n.uuid IN $nodeIds AND n.projectId = $projectId
        RETURN n.uuid AS uuid, n.hash AS hash, n.source AS source, n.textContent AS textContent, n.name AS name, n.file AS file, labels(n) AS labels, n.schemaDirty AS schemaDirty
        `
      : `
        MATCH (n)
        WHERE n.uuid IN $nodeIds
        RETURN n.uuid AS uuid, n.hash AS hash, n.source AS source, n.textContent AS textContent, n.name AS name, n.file AS file, labels(n) AS labels, n.schemaDirty AS schemaDirty
        `;

    const result = await this.client.run(query, { nodeIds, projectId });

    const hashes = new Map<string, { uuid: string; hash: string; source?: string; textContent?: string; name?: string; file?: string; labels?: string[]; schemaDirty?: boolean }>();
    for (const record of result.records) {
      hashes.set(record.get('uuid'), {
        uuid: record.get('uuid'),
        hash: record.get('hash'),
        source: record.get('source'),
        textContent: record.get('textContent'),
        name: record.get('name'),
        file: record.get('file'),
        labels: record.get('labels'),
        schemaDirty: record.get('schemaDirty')
      });
    }
    return hashes;
  }

  /**
   * Get existing File nodes with their rawContentHash for a project
   * Used for pre-parsing incremental check
   *
   * @param projectId - Project ID to query
   * @returns Map of relative file path -> rawContentHash
   */
  async getExistingFileHashes(projectId: string): Promise<Map<string, string>> {
    const query = `
      MATCH (f:File)-[:BELONGS_TO]->(p:Project {projectId: $projectId})
      WHERE f.rawContentHash IS NOT NULL
      RETURN f.path AS path, f.rawContentHash AS hash
    `;

    const result = await this.client.run(query, { projectId });

    const hashes = new Map<string, string>();
    for (const record of result.records) {
      const filePath = record.get('path');
      const hash = record.get('hash');
      if (filePath && hash) {
        hashes.set(filePath, hash);
      }
    }
    return hashes;
  }

  /**
   * Update rawContentHash for File nodes AFTER successful ingestion
   *
   * This ensures atomicity: if ingestion is interrupted (e.g., daemon killed during build),
   * the hash won't be updated, so next sync will correctly detect the file as changed
   * and re-ingest all nodes.
   *
   * @param hashes - Map of relative file path -> new hash
   * @param projectId - Project ID to filter files
   * @param verbose - Enable verbose logging
   */
  async updateFileHashes(
    hashes: Map<string, string>,
    projectId: string,
    verbose: boolean = false
  ): Promise<void> {
    if (hashes.size === 0) return;

    // Convert to array for UNWIND
    const hashUpdates = Array.from(hashes.entries()).map(([path, hash]) => ({
      path,
      hash
    }));

    // Batch update all File hashes in a single query
    const result = await this.client.run(
      `
      UNWIND $updates AS update
      MATCH (f:File {path: update.path})-[:BELONGS_TO]->(p:Project {projectId: $projectId})
      SET f.rawContentHash = update.hash
      RETURN count(f) AS updated
      `,
      { updates: hashUpdates, projectId }
    );

    const updatedCount = result.records[0]?.get('updated')?.toNumber() ?? 0;

    if (verbose && updatedCount > 0) {
      console.log(`   🔒 Updated ${updatedCount} file hashes (atomicity checkpoint)`);
    }
  }

  /**
   * Compute raw content hash for a file (SHA-256)
   * Fast operation - just reads file and hashes it, no parsing
   */
  static async computeFileHash(filePath: string): Promise<string> {
    const fs = await import('fs/promises');
    const content = await fs.readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Filter files to only those that have changed (based on rawContentHash)
   *
   * This is the KEY optimization for incremental ingestion:
   * - Reads file content (fast)
   * - Computes hash (fast)
   * - Compares with DB hash (fast)
   * - Only changed files will be parsed (expensive operation skipped for unchanged)
   *
   * @param config - Source configuration with include/exclude patterns
   * @param projectId - Project ID to compare against
   * @param verbose - Enable verbose logging
   * @returns Object with changedFiles (to parse) and unchangedFiles (to skip)
   */
  async filterChangedFiles(
    config: SourceConfig,
    projectId: string,
    verbose: boolean = false
  ): Promise<{
    allFiles: string[];
    changedFiles: string[];
    unchangedFiles: Set<string>;
    newHashes: Map<string, string>;
    rootPath: string;
  }> {
    const fs = await import('fs/promises');
    const pLimit = (await import('p-limit')).default;

    const rootPath = config.root || process.cwd();
    const patterns = config.include || ['**/*'];
    const ignore = config.exclude || [
      '**/node_modules/**',
      '**/dist/**',
      '**/.git/**',
      '**/.ragforge/**',
    ];

    // 1. Discover all files matching patterns
    const allFiles = await fg(patterns, {
      cwd: rootPath,
      ignore,
      absolute: true,
    });

    if (verbose) {
      console.log(`🔍 Discovered ${allFiles.length} files`);
    }

    // 2. Get existing hashes from DB
    const existingHashes = await this.getExistingFileHashes(projectId);
    if (verbose) {
      console.log(`📊 Found ${existingHashes.size} files with hashes in database`);
    }

    // 3. Compute hashes for current files in parallel (fast - just read + hash)
    const limit = pLimit(20); // Higher concurrency since we're just reading
    const newHashes = new Map<string, string>();
    const changedFiles: string[] = [];
    const unchangedFiles = new Set<string>();

    await Promise.all(
      allFiles.map(file =>
        limit(async () => {
          try {
            const relPath = pathModule.relative(rootPath, file);
            const hash = await IncrementalIngestionManager.computeFileHash(file);
            newHashes.set(relPath, hash);

            const existingHash = existingHashes.get(relPath);
            if (existingHash === hash) {
              // File unchanged - skip parsing
              unchangedFiles.add(relPath);
            } else {
              // File new or changed - needs parsing
              changedFiles.push(file);
            }
          } catch (err) {
            // File might have been deleted, include it for processing
            changedFiles.push(file);
          }
        })
      )
    );

    // 4. Check for files with schemaDirty nodes - these need re-ingestion even if file unchanged
    const schemaDirtyFiles = await this.getFilesWithDirtySchema(projectId);
    if (schemaDirtyFiles.size > 0) {
      let forcedCount = 0;
      for (const dirtyFile of schemaDirtyFiles) {
        if (unchangedFiles.has(dirtyFile)) {
          unchangedFiles.delete(dirtyFile);
          // Find the absolute path and add to changedFiles
          const absPath = pathModule.join(rootPath, dirtyFile);
          if (!changedFiles.includes(absPath)) {
            changedFiles.push(absPath);
            forcedCount++;
          }
        }
      }
      if (verbose) {
        console.log(`🔄 Found ${schemaDirtyFiles.size} files with outdated schema, forced ${forcedCount} to re-ingest`);
      }
    }

    if (verbose) {
      console.log(`✅ Hash comparison: ${changedFiles.length} changed, ${unchangedFiles.size} unchanged`);
      if (unchangedFiles.size > 0 && changedFiles.length === 0) {
        console.log(`⚡ All files unchanged - skipping parsing entirely`);
      }
    }

    return { allFiles, changedFiles, unchangedFiles, newHashes, rootPath };
  }

  /**
   * Get files that have nodes with schemaDirty = true
   * These files need to be re-ingested even if their content hash hasn't changed
   */
  private async getFilesWithDirtySchema(projectId: string): Promise<Set<string>> {
    const result = await this.client.run(
      `MATCH (n)
       WHERE n.projectId = $projectId AND n.schemaDirty = true AND n.file IS NOT NULL
       RETURN DISTINCT n.file AS file`,
      { projectId }
    );

    const files = new Set<string>();
    for (const record of result.records) {
      const file = record.get('file');
      if (file) {
        files.add(file);
      }
    }
    return files;
  }

  /**
   * Delete nodes and their relationships
   * Used to clean up orphaned nodes when files are deleted
   *
   * Works with ALL content node types (not just Scope)
   */
  async deleteNodes(uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    // Delete ANY node by UUID (not just Scope)
    await this.client.run(
      `
      MATCH (n)
      WHERE n.uuid IN $uuids
      DETACH DELETE n
      `,
      { uuids }
    );
  }

  /**
   * Delete all nodes associated with a file path
   * Used when a file is deleted (unlink event)
   *
   * Deletes:
   * - File node itself
   * - All content nodes with matching file property (Scope, DocumentFile, etc.)
   * - All related nodes (via cascade relationships like HAS_PARENT, CONTAINS, etc.)
   *
   * @returns Number of nodes deleted
   */
  async deleteNodesForFile(filePath: string): Promise<number> {
    // First, find all nodes associated with this file
    // This includes:
    // - Nodes with file = filePath (Scope, Chunk, etc.)
    // - Nodes with absolutePath = filePath (canonical identifier)
    // - Nodes with path = filePath (File node legacy)
    // - Nodes with file = filePath (legacy)
    // - Nodes with source_file = filePath (some adapters use this)
    const result = await this.client.run(
      `
      MATCH (n)
      WHERE n.absolutePath = $filePath
         OR n.file = $filePath
         OR n.path = $filePath
         OR n.source_file = $filePath
      DETACH DELETE n
      RETURN count(n) AS deleted
      `,
      { filePath }
    );

    return result.records[0]?.get('deleted')?.toNumber() || 0;
  }

  /**
   * Delete all nodes for multiple files at once
   * More efficient than calling deleteNodesForFile in a loop
   */
  async deleteNodesForFiles(filePaths: string[]): Promise<number> {
    if (filePaths.length === 0) return 0;

    const result = await this.client.run(
      `
      MATCH (n)
      WHERE n.absolutePath IN $filePaths
         OR n.file IN $filePaths
         OR n.path IN $filePaths
         OR n.source_file IN $filePaths
      DETACH DELETE n
      RETURN count(n) AS deleted
      `,
      { filePaths }
    );

    return result.records[0]?.get('deleted')?.toNumber() || 0;
  }

  /**
   * Delete outgoing relationships from nodes before re-upserting
   * This ensures stale relationships are cleaned up when content changes
   *
   * @param uuids - Node UUIDs to clean relationships from
   * @param relationshipTypes - Optional list of relationship types to delete (default: all outgoing)
   */
  async deleteOutgoingRelationships(
    uuids: string[],
    relationshipTypes?: string[]
  ): Promise<number> {
    if (uuids.length === 0) return 0;

    let query: string;
    if (relationshipTypes && relationshipTypes.length > 0) {
      // Delete specific relationship types
      const relTypePattern = relationshipTypes.join('|');
      query = `
        MATCH (n)-[r:${relTypePattern}]->()
        WHERE n.uuid IN $uuids
        DELETE r
        RETURN count(r) AS deleted
      `;
    } else {
      // Delete ALL outgoing relationships
      query = `
        MATCH (n)-[r]->()
        WHERE n.uuid IN $uuids
        DELETE r
        RETURN count(r) AS deleted
      `;
    }

    const result = await this.client.run(query, { uuids });
    return result.records[0]?.get('deleted')?.toNumber() || 0;
  }

  /**
   * Ingest nodes and relationships into Neo4j
   * Uses UNWIND batching for optimal performance
   *
   * SIMPLIFIED: No more capture/restore of embeddings.
   * - SET n += props preserves properties not in props (like embeddings)
   * - State machine tracks when embeddings need regeneration via _state = 'linked'
   *
   * @param markForEmbedding - If true, marks content nodes with _state = 'linked'
   */
  private async ingestNodes(
    nodes: ParsedNode[],
    relationships: ParsedRelationship[],
    markForEmbedding: boolean = false,
    onProgress?: ProgressCallback
  ): Promise<void> {
    if (nodes.length === 0 && relationships.length === 0) {
      return;
    }

    // Batch nodes by label type for efficient UNWIND processing
    const nodesByLabel = new Map<string, Array<{ uuid: string; props: any }>>();

    for (const node of nodes) {
      const labels = node.labels.join(':');
      const props = { ...node.properties };

      // Add schemaVersion to content nodes (for detecting schema changes)
      addSchemaVersion(node.labels, props);

      if (!nodesByLabel.has(labels)) {
        nodesByLabel.set(labels, []);
      }
      nodesByLabel.get(labels)!.push({ uuid: node.id, props });
    }

    // Create nodes using UNWIND batching (one query per label type)
    let processedNodes = 0;
    const totalNodes = nodes.length;
    for (const [labels, nodeData] of nodesByLabel) {
      if (nodeData.length === 0) continue;

      // Determine unique field based on node type
      const labelsArray = labels.split(':');
      const isMediaFile = labelsArray.includes('MediaFile') || labelsArray.includes('ImageFile')
        || labelsArray.includes('ThreeDFile') || labelsArray.includes('DocumentFile');
      const isFileOrDirectory = (labelsArray.includes('File') || labelsArray.includes('Directory')) && !isMediaFile;
      const isProject = labelsArray.includes('Project');
      const isContentNode = labelsArray.includes('Scope') || labelsArray.includes('MarkdownSection')
        || labelsArray.includes('CodeBlock') || labelsArray.includes('DataSection')
        || labelsArray.includes('WebPage') || isMediaFile;

      let uniqueField: string;
      let uniqueValue: string;
      if (isFileOrDirectory) {
        uniqueField = 'path';
        uniqueValue = 'nodeData.props.path';
      } else if (isProject) {
        uniqueField = 'projectId';
        uniqueValue = 'nodeData.props.projectId';
      } else {
        uniqueField = 'uuid';
        uniqueValue = 'nodeData.uuid';
      }

      // Build state machine SET clause for content nodes
      const stateClause = (markForEmbedding && isContentNode)
        ? `, n.${P.state} = 'linked', n.${P.stateChangedAt} = datetime()`
        : '';

      // MERGE with += preserves existing embeddings (they're not in props)
      // No need for capture/restore - embeddings stay on the node
      await this.client.run(
        `
        UNWIND $nodes AS nodeData
        MERGE (n:${labels} {${uniqueField}: ${uniqueValue}})
        SET n += nodeData.props${stateClause}
        `,
        { nodes: nodeData }
      );

      processedNodes += nodeData.length;
      console.log(`   📦 Upserted ${nodeData.length} ${labels} nodes (${processedNodes}/${totalNodes})`);
      onProgress?.('nodes', processedNodes, totalNodes, `Upserted ${nodeData.length} ${labels} nodes`);
    }

    // Create relationships using UNWIND batching (batches of 500)
    // Optimization: Build uuid->labels map for indexed MATCH queries
    if (relationships.length > 0) {
      console.log(`   🔗 Creating ${relationships.length} relationships...`);

      // Build uuid -> primary label map for fast indexed lookups
      const uuidToLabel = new Map<string, string>();
      for (const node of nodes) {
        // Use first label as primary (most specific)
        const primaryLabel = node.labels[0] || 'Node';
        uuidToLabel.set(node.id, primaryLabel);
      }

      const batchSize = 500;
      // Group by relationship type AND label combination for optimized queries
      const relsByTypeAndLabels = new Map<string, Array<{ from: string; to: string; props: any }>>();

      for (const rel of relationships) {
        const fromLabel = uuidToLabel.get(rel.from) || null; // null = cross-file, use unlabeled match
        const toLabel = uuidToLabel.get(rel.to) || null;     // null = cross-file, use unlabeled match
        // Key includes rel type + labels for specific queries
        const key = `${rel.type}|${fromLabel || '_'}|${toLabel || '_'}`;

        if (!relsByTypeAndLabels.has(key)) {
          relsByTypeAndLabels.set(key, []);
        }
        relsByTypeAndLabels.get(key)!.push({
          from: rel.from,
          to: rel.to,
          props: rel.properties || {}
        });
      }

      // Process each relationship type+label combination in batches
      let processedRels = 0;
      for (const [key, rels] of relsByTypeAndLabels) {
        const [relType, fromLabelKey, toLabelKey] = key.split('|');
        // '_' means cross-file (unknown label), use unlabeled MATCH (slower but works)
        const fromLabel = fromLabelKey === '_' ? null : fromLabelKey;
        const toLabel = toLabelKey === '_' ? null : toLabelKey;

        for (let i = 0; i < rels.length; i += batchSize) {
          const batch = rels.slice(i, i + batchSize);

          // Use labeled MATCH for indexed lookups when possible (100x faster!)
          // For cross-file refs, use unlabeled MATCH (slower but necessary)
          const fromMatch = fromLabel ? `(from:${fromLabel} {uuid: relData.from})` : `(from {uuid: relData.from})`;
          const toMatch = toLabel ? `(to:${toLabel} {uuid: relData.to})` : `(to {uuid: relData.to})`;

          await this.client.run(
            `
            UNWIND $rels AS relData
            MATCH ${fromMatch}
            MATCH ${toMatch}
            MERGE (from)-[r:${relType}]->(to)
            SET r += relData.props
            `,
            { rels: batch }
          );

          processedRels += batch.length;
        }
        const fromDisplay = fromLabel || 'Node';
        const toDisplay = toLabel || 'Node';
        console.log(`   🔗 ${rels.length} ${relType} (${fromDisplay}→${toDisplay}) [${processedRels}/${relationships.length}]`);
        onProgress?.('relationships', processedRels, relationships.length, `Created ${rels.length} ${relType} relationships`);
      }
    }

    console.log(`   ✅ Upsert complete: ${totalNodes} nodes, ${relationships.length} relationships`);
    onProgress?.('complete', totalNodes, totalNodes, `Upsert complete: ${totalNodes} nodes, ${relationships.length} relationships`);
  }

  /**
   * Incremental ingestion - only updates changed content nodes
   *
   * Strategy:
   * 1. Fetch existing hashes from DB (ALL content node types)
   * 2. Filter nodes: only keep changed/new ones
   * 3. Delete orphaned nodes (files removed from codebase)
   * 4. Clean up outgoing relationships for modified nodes
   * 5. Upsert changed nodes
   * 6. Update relationships for affected nodes
   * 7. Track changes and generate diffs (if enabled)
   *
   * Supports: Scope, DataFile, MediaFile, DocumentFile, VueSFC,
   *           SvelteComponent, Stylesheet, MarkdownDocument, CodeBlock
   */
  async ingestIncremental(
    graph: ParsedGraph,
    options: IngestionOptions = {}
  ): Promise<IncrementalStats> {
    const { projectId, dryRun, verbose = false, trackChanges, cleanupRelationships = true } = options;
    const { nodes, relationships } = graph;

    if (verbose) {
      console.log('🔍 Analyzing changes...');
      if (projectId) {
        console.log(`   Project: ${projectId}`);
      }
    }

    // Add projectId to all nodes if specified
    if (projectId) {
      for (const node of nodes) {
        node.properties.projectId = projectId;
      }
    }

    // 1. Get ALL content nodes (not just Scope)
    // Content nodes have a hash property and are not structural (File, Directory, Project)
    const contentNodes = nodes.filter(n =>
      n.properties.hash !== undefined &&
      !isStructuralNode(n)
    );
    const nodeIds = contentNodes.map(n => n.id);
    const existingHashes = await this.getExistingHashes(nodeIds, projectId);

    if (verbose) {
      console.log(`   Found ${existingHashes.size} existing content nodes in database`);
    }

    // 2. Classify nodes
    const unchanged: string[] = [];
    const modified: ParsedNode[] = [];
    const created: ParsedNode[] = [];

    for (const node of contentNodes) {
      const uuid = node.id;
      const existing = existingHashes.get(uuid);
      const currentHash = node.properties.hash as string;

      if (!existing) {
        created.push(node);
      } else if (existing.hash !== currentHash || existing.schemaDirty === true) {
        // Treat schemaDirty nodes as modified even if hash unchanged
        modified.push(node);
      } else {
        unchanged.push(uuid);
      }
    }

    // 3. Find deleted nodes (in DB but not in current parse)
    const currentIds = new Set(nodeIds);
    const deleted = Array.from(existingHashes.keys())
      .filter(id => !currentIds.has(id));

    if (verbose) {
      console.log(`   Changes detected:`);
      console.log(`     Created: ${created.length}`);
      console.log(`     Updated: ${modified.length}`);
      console.log(`     Unchanged: ${unchanged.length}`);
      console.log(`     Deleted: ${deleted.length}`);
    }

    const stats = {
      unchanged: unchanged.length,
      updated: modified.length,
      created: created.length,
      deleted: deleted.length
    };

    if (dryRun) {
      return stats;
    }

    // 4. Delete orphaned nodes
    if (deleted.length > 0) {
      if (verbose) {
        console.log(`\n🗑️  Deleting ${deleted.length} orphaned nodes...`);
      }
      await this.deleteNodes(deleted);
    }

    // 5. Clean up outgoing relationships for modified nodes
    // This ensures stale references are removed before re-upserting
    if (cleanupRelationships && modified.length > 0) {
      const modifiedUuids = modified.map(n => n.id);
      if (verbose) {
        console.log(`\n🔗 Cleaning up relationships for ${modified.length} modified nodes...`);
      }
      const deletedRels = await this.deleteOutgoingRelationships(modifiedUuids);
      if (verbose && deletedRels > 0) {
        console.log(`   Removed ${deletedRels} stale relationships`);
      }
    }

    // 6. Upsert modified + created nodes
    const nodesToUpsert = [...modified, ...created];

    // Always include structural nodes (File, Directory, Project)
    // These should be upserted even if no content changes
    const structuralNodes = nodes.filter(isStructuralNode);

    if (nodesToUpsert.length > 0 || structuralNodes.length > 0) {
      if (verbose) {
        console.log(`\n💾 Upserting ${nodesToUpsert.length} changed content nodes + ${structuralNodes.length} structural nodes...`);
      }

      // Include all node IDs for relationship filtering
      const allNodesToIngest = [...nodesToUpsert, ...structuralNodes];
      const affectedUuids = new Set(allNodesToIngest.map(n => n.id));
      const relevantRelationships = relationships.filter(rel =>
        affectedUuids.has(rel.from) || affectedUuids.has(rel.to)
      );

      await this.ingestNodes(
        allNodesToIngest,
        relevantRelationships,
        true  // Mark changed nodes as embeddingsDirty
      );

      // 6. Track changes and generate diffs (if enabled)
      if (options.trackChanges) {
        if (verbose) {
          console.log(`\n📝 Tracking changes and generating diffs...`);
        }

        // Prepare all changes for batch processing
        const changesToTrack: Array<{
          entityType: string;
          entityUuid: string;
          entityLabel: string;
          oldContent: string | null;
          newContent: string;
          oldHash: string | null;
          newHash: string;
          changeType: 'created' | 'updated' | 'deleted';
          metadata?: Record<string, any>;
        }> = [];

        // Helper to get content from different node types
        const getNodeContent = (node: ParsedNode): string | undefined => {
          // Scope nodes use 'source'
          if (node.labels.includes('Scope')) return node.properties.source as string;
          // Document nodes use 'textContent'
          if (node.labels.includes('DocumentFile') || node.labels.includes('PDFDocument') ||
              node.labels.includes('WordDocument') || node.labels.includes('SpreadsheetDocument')) {
            return node.properties.textContent as string;
          }
          // Markdown sections use 'rawText'
          if (node.labels.includes('MarkdownSection')) return node.properties.rawText as string;
          // Code blocks use 'code'
          if (node.labels.includes('CodeBlock')) return node.properties.code as string;
          // Web pages use 'textContent'
          if (node.labels.includes('WebPage')) return node.properties.textContent as string;
          return undefined;
        };

        // Helper to get entity type from labels
        const getEntityType = (node: ParsedNode): string => {
          if (node.labels.includes('Scope')) return 'Scope';
          if (node.labels.includes('PDFDocument')) return 'PDFDocument';
          if (node.labels.includes('WordDocument')) return 'WordDocument';
          if (node.labels.includes('SpreadsheetDocument')) return 'SpreadsheetDocument';
          if (node.labels.includes('DocumentFile')) return 'DocumentFile';
          if (node.labels.includes('MarkdownSection')) return 'MarkdownSection';
          if (node.labels.includes('CodeBlock')) return 'CodeBlock';
          if (node.labels.includes('WebPage')) return 'WebPage';
          return node.labels[0] || 'Unknown';
        };

        // Add created content nodes
        for (const node of created) {
          const content = getNodeContent(node);
          if (!content) continue; // Skip nodes without trackable content

          const nodeName = node.properties.name as string || node.properties.path as string || node.id;
          const nodeFile = node.properties.file as string || node.properties.path as string || '';
          const newHash = node.properties.hash as string;
          const entityType = getEntityType(node);

          changesToTrack.push({
            entityType,
            entityUuid: node.id,
            entityLabel: nodeFile ? `${nodeFile}:${nodeName}` : nodeName,
            oldContent: null,
            newContent: content,
            oldHash: null,
            newHash,
            changeType: 'created',
            metadata: { name: nodeName, file: nodeFile }
          });
        }

        // Add modified content nodes
        for (const node of modified) {
          const existing = existingHashes.get(node.id);
          if (!existing) continue;

          const content = getNodeContent(node);
          if (!content) continue; // Skip nodes without trackable content

          const nodeName = node.properties.name as string || node.properties.path as string || node.id;
          const nodeFile = node.properties.file as string || node.properties.path as string || '';
          const newHash = node.properties.hash as string;
          const entityType = getEntityType(node);

          changesToTrack.push({
            entityType,
            entityUuid: node.id,
            entityLabel: nodeFile ? `${nodeFile}:${nodeName}` : nodeName,
            oldContent: existing.source || existing.textContent || '',
            newContent: content,
            oldHash: existing.hash,
            newHash,
            changeType: 'updated',
            metadata: { name: nodeName, file: nodeFile }
          });
        }

        // Track all changes in parallel using p-limit (10 concurrent)
        await this.changeTracker.trackEntityChangesBatch(changesToTrack, 10);

        if (verbose) {
          console.log(`   Tracked ${changesToTrack.length} content change(s)`);
        }
      }
    }

    if (verbose && (created.length > 0 || modified.length > 0)) {
      console.log(`\n⚠️  ${created.length + modified.length} scope(s) marked as dirty - embeddings need regeneration`);
    }

    // Update lineCount for File nodes that don't have it (calculate from max scope endLine)
    // This ensures all File nodes have lineCount for agent context
    if (projectId) {
      try {
        await this.client.run(`
          MATCH (f:File {projectId: $projectId})<-[:DEFINED_IN]-(s:Scope)
          WHERE f.lineCount IS NULL
          WITH f, max(s.endLine) as maxLine
          SET f.lineCount = maxLine
        `, { projectId });
      } catch (error) {
        // Non-critical: lineCount is for agent UX, not required
        if (verbose) {
          console.log('   Note: Could not update lineCount for some files');
        }
      }
    }

    return stats;
  }

  /**
   * Ingest files from source configuration
   *
   * OPTIMIZED: Pre-parsing hash check skips unchanged files entirely
   *
   * @param config - Source configuration (code, documents, etc.)
   * @param options - Ingestion options
   *   - incremental: Controls hash checking behavior
   *     - true/'both': Check file hashes AND scope hashes (default)
   *     - 'files': Check file hashes only, skip scope comparison
   *     - 'content': Skip file hash check, but compare scope hashes (for watcher)
   *     - false: No hash checks, direct upsert
   */
  async ingestFromPaths(
    config: SourceConfig,
    options: IngestionOptions & { incremental?: boolean | 'files' | 'content' | 'both' } = {}
  ): Promise<IncrementalStats> {
    const { projectId, verbose = false, dryRun, trackChanges: optTrackChanges } = options;
    const trackChanges = optTrackChanges ?? config.track_changes ?? false;

    // Parse incremental option
    const incrementalOpt = options.incremental ?? true;
    const checkFileHashes = incrementalOpt === true || incrementalOpt === 'both' || incrementalOpt === 'files';
    const checkContentHashes = incrementalOpt === true || incrementalOpt === 'both' || incrementalOpt === 'content';

    if (verbose) {
      const pathCount = config.include?.length || 0;
      const sourceType = config.type === 'code' ? 'code' : 'files';
      console.log(`\n🔄 Ingesting ${sourceType} from ${pathCount} path(s)...`);
      console.log(`   Base path: ${config.root || '.'}`);
      const modeStr = checkFileHashes && checkContentHashes ? 'incremental (files + content)'
        : checkFileHashes ? 'incremental (files only)'
        : checkContentHashes ? 'incremental (content only)'
        : 'full';
      console.log(`   Mode: ${modeStr}`);
      if (projectId) {
        console.log(`   Project: ${projectId}`);
      }
      if (trackChanges) {
        console.log(`   Change tracking: enabled`);
      }
    }

    // When incremental='content', the watcher already knows files changed
    // We need to delete existing nodes BEFORE re-parsing to prevent duplicates
    // config.include contains the list of changed files (relative paths)
    // IMPORTANT: Capture UUIDs and embeddings BEFORE deletion to preserve them
    let watcherEmbeddingCapture: Map<string, Array<{
      uuid: string; file: string; type: string;
      nameHash?: string; contentHash?: string; descHash?: string;
      embeddingName?: number[]; embeddingContent?: number[]; embeddingDescription?: number[];
      embeddingProvider?: string; embeddingModel?: string;
    }>> | undefined;

    if (incrementalOpt === 'content' && config.include && config.include.length > 0 && projectId) {
      const root = config.root || '.';
      const relativePaths = config.include;
      const absolutePaths = relativePaths.map(f => pathModule.resolve(root, f));

      // Capture existing scopes with UUIDs and embeddings BEFORE deletion
      const existingScopesResult = await this.client.run(
        `
        MATCH (s:Scope)
        WHERE s.projectId = $projectId
          AND s.file IN $relativePaths
        RETURN s.uuid AS uuid, s.name AS name, s.file AS file, s.type AS type,
               s.embedding_name_hash AS nameHash, s.embedding_content_hash AS contentHash,
               s.embedding_description_hash AS descHash,
               s.embedding_name AS embeddingName, s.embedding_content AS embeddingContent,
               s.embedding_description AS embeddingDescription,
               s.embedding_provider AS embeddingProvider, s.embedding_model AS embeddingModel
        `,
        { projectId, relativePaths }
      );

      watcherEmbeddingCapture = new Map();
      for (const record of existingScopesResult.records) {
        const name = record.get('name');
        const entry = {
          uuid: record.get('uuid'),
          file: record.get('file'),
          type: record.get('type'),
          nameHash: record.get('nameHash'),
          contentHash: record.get('contentHash'),
          descHash: record.get('descHash'),
          embeddingName: record.get('embeddingName'),
          embeddingContent: record.get('embeddingContent'),
          embeddingDescription: record.get('embeddingDescription'),
          embeddingProvider: record.get('embeddingProvider'),
          embeddingModel: record.get('embeddingModel'),
        };
        const existing = watcherEmbeddingCapture.get(name) || [];
        existing.push(entry);
        watcherEmbeddingCapture.set(name, existing);
      }

      if (verbose && watcherEmbeddingCapture.size > 0) {
        console.log(`   🔒 Captured ${watcherEmbeddingCapture.size} symbols for UUID/embedding preservation`);
      }

      // Now delete existing nodes
      const deletedCount = await this.deleteNodesForFiles(absolutePaths);
      if (verbose && deletedCount > 0) {
        console.log(`   🗑️ Deleted ${deletedCount} nodes from ${absolutePaths.length} changed files`);
      }
    } else if (incrementalOpt === 'content' && config.include && config.include.length > 0) {
      // No projectId - just delete without preservation
      const root = config.root || '.';
      const absolutePaths = config.include.map(f => pathModule.resolve(root, f));
      const deletedCount = await this.deleteNodesForFiles(absolutePaths);
      if (verbose && deletedCount > 0) {
        console.log(`   🗑️ Deleted ${deletedCount} nodes from ${absolutePaths.length} changed files`);
      }
    }

    // ===== PRE-PARSING OPTIMIZATION =====
    // Check file hashes BEFORE parsing to skip unchanged files entirely
    // This is the key optimization that makes re-ingestion fast
    let skipFiles: Set<string> | undefined;
    let newHashes: Map<string, string> | undefined;

    if (checkFileHashes && projectId) {
      const filterStart = Date.now();
      const filterResult = await this.filterChangedFiles(config, projectId, verbose);
      const filterMs = Date.now() - filterStart;

      skipFiles = filterResult.unchangedFiles;
      newHashes = filterResult.newHashes;

      if (verbose) {
        console.log(`   Pre-parsing check took ${filterMs}ms`);
      }

      // If ALL files are unchanged, return early with zero changes
      if (filterResult.changedFiles.length === 0 && filterResult.unchangedFiles.size > 0) {
        if (verbose) {
          console.log(`\n⚡ No files changed - skipping parsing entirely!`);
        }
        return {
          unchanged: filterResult.unchangedFiles.size,
          updated: 0,
          created: 0,
          deleted: 0
        };
      }

      // Delete existing nodes for changed files BEFORE re-parsing
      // This prevents orphan nodes when function signatures change (different UUIDs)
      // NOTE: We pass absolute paths because nodes store absolutePath with full paths
      if (filterResult.changedFiles.length > 0) {
        const deletedCount = await this.deleteNodesForFiles(filterResult.changedFiles);
        if (verbose && deletedCount > 0) {
          console.log(`   🗑️ Deleted ${deletedCount} nodes from ${filterResult.changedFiles.length} changed files`);
        }
      }
    }

    // Create adapter and parse (only changed files if incremental)
    const adapter = getAdapter();

    // Query existing project scopes for cross-file import resolution
    // This is needed for cross-file CONSUMES edges when doing single-file or partial ingestion
    // Also merge with any pre-queried mapping from options (for UUID preservation in reIngestFiles)
    let existingUUIDMapping: Map<string, Array<{ uuid: string; file: string; type: string }>> | undefined;

    // Start with pre-queried mapping if provided (from reIngestFiles for UUID preservation)
    if (options.existingUUIDMapping) {
      existingUUIDMapping = new Map(options.existingUUIDMapping);
      if (verbose) {
        console.log(`   Using ${existingUUIDMapping.size} pre-queried symbols for UUID preservation`);
      }
    }

    // Merge watcher embedding capture (from incremental='content') for UUID preservation
    // This is needed because we deleted the nodes before re-parsing
    if (watcherEmbeddingCapture && watcherEmbeddingCapture.size > 0) {
      if (!existingUUIDMapping) {
        existingUUIDMapping = new Map();
      }
      for (const [name, entries] of watcherEmbeddingCapture) {
        const existing = existingUUIDMapping.get(name) || [];
        for (const entry of entries) {
          const isDuplicate = existing.some(e => e.uuid === entry.uuid);
          if (!isDuplicate) {
            existing.push(entry);
          }
        }
        existingUUIDMapping.set(name, existing);
      }
      if (verbose) {
        console.log(`   Merged ${watcherEmbeddingCapture.size} symbols from watcher for UUID preservation`);
      }
    }

    if (projectId) {
      if (!existingUUIDMapping) {
        existingUUIDMapping = new Map();
      }
      const projectScopesResult = await this.client.run(
        `
        MATCH (s:Scope)
        WHERE s.projectId = $projectId
        RETURN s.uuid AS uuid, s.name AS name, s.file AS file, s.type AS type
        `,
        { projectId }
      );
      let addedFromDb = 0;
      for (const record of projectScopesResult.records) {
        const name = record.get('name');
        const entry = {
          uuid: record.get('uuid'),
          file: record.get('file'),
          type: record.get('type')
        };
        const existing = existingUUIDMapping.get(name) || [];
        // Only add if not already present (pre-queried has priority)
        const isDuplicate = existing.some(e => e.uuid === entry.uuid);
        if (!isDuplicate) {
          existing.push(entry);
          existingUUIDMapping.set(name, existing);
          addedFromDb++;
        }
      }
      if (verbose) {
        console.log(`   Loaded ${addedFromDb} additional symbols from project for cross-file resolution (total: ${existingUUIDMapping.size})`);
      }
    }

    const parseResult = await adapter.parse({
      source: config,
      skipFiles, // Pass unchanged files to skip
      projectId, // Pass generated projectId so Project node uses it as uuid
      existingUUIDMapping, // Pass existing project scopes for cross-file import resolution
      onProgress: undefined
    });

    if (verbose) {
      // Generic entity count (works for both Scope and Document/Chunk)
      const entityCounts = new Map<string, number>();
      for (const node of parseResult.graph.nodes) {
        for (const label of node.labels) {
          entityCounts.set(label, (entityCounts.get(label) || 0) + 1);
        }
      }

      const countStr = Array.from(entityCounts.entries())
        .map(([label, count]) => `${count} ${label}${count !== 1 ? 's' : ''}`)
        .join(', ');
      console.log(`\n✅ Parsed ${countStr} from source`);
    }

    // NOTE: rawContentHash is updated AFTER ingestion completes to ensure atomicity
    // If daemon is killed mid-ingestion, the hash won't be updated, so next sync
    // will correctly detect the file as changed and re-ingest all nodes

    // Ingest with projectId
    if (checkContentHashes) {
      const stats = await this.ingestIncremental(parseResult.graph, {
        projectId,
        verbose,
        dryRun,
        trackChanges
      });

      // Update File hashes AFTER successful ingestion (atomicity fix)
      if (newHashes && projectId && !dryRun) {
        await this.updateFileHashes(newHashes, projectId, verbose);
      }

      // Add skipped files to unchanged count
      if (skipFiles) {
        stats.unchanged += skipFiles.size;
      }

      // Restore embeddings from watcher capture (after nodes are created with same UUIDs)
      if (watcherEmbeddingCapture && watcherEmbeddingCapture.size > 0) {
        const embeddingUpdates: Array<{
          uuid: string;
          nameHash: string | null;
          contentHash: string | null;
          descHash: string | null;
          embeddingName: number[] | null;
          embeddingContent: number[] | null;
          embeddingDescription: number[] | null;
          embeddingProvider: string | null;
          embeddingModel: string | null;
        }> = [];

        for (const [, entries] of watcherEmbeddingCapture) {
          for (const entry of entries) {
            if (entry.nameHash || entry.contentHash || entry.descHash ||
                entry.embeddingName || entry.embeddingContent || entry.embeddingDescription ||
                entry.embeddingProvider || entry.embeddingModel) {
              embeddingUpdates.push({
                uuid: entry.uuid,
                nameHash: entry.nameHash || null,
                contentHash: entry.contentHash || null,
                descHash: entry.descHash || null,
                embeddingName: entry.embeddingName || null,
                embeddingContent: entry.embeddingContent || null,
                embeddingDescription: entry.embeddingDescription || null,
                embeddingProvider: entry.embeddingProvider || null,
                embeddingModel: entry.embeddingModel || null,
              });
            }
          }
        }

        if (embeddingUpdates.length > 0) {
          await this.client.run(
            `
            UNWIND $updates AS u
            MATCH (n {uuid: u.uuid})
            SET n.embedding_name_hash = u.nameHash,
                n.embedding_content_hash = u.contentHash,
                n.embedding_description_hash = u.descHash,
                n.embedding_name = u.embeddingName,
                n.embedding_content = u.embeddingContent,
                n.embedding_description = u.embeddingDescription,
                n.embedding_provider = u.embeddingProvider,
                n.embedding_model = u.embeddingModel
            `,
            { updates: embeddingUpdates }
          );

          if (verbose) {
            console.log(`   🔄 Restored embeddings for ${embeddingUpdates.length} nodes from watcher capture`);
          }
        }
      }

      return stats;
    } else {
      // Full ingestion - add projectId to nodes
      if (projectId) {
        for (const node of parseResult.graph.nodes) {
          node.properties.projectId = projectId;
        }
      }
      await this.ingestNodes(parseResult.graph.nodes, parseResult.graph.relationships);

      // Update File hashes AFTER successful ingestion (atomicity fix)
      if (newHashes && projectId) {
        await this.updateFileHashes(newHashes, projectId, verbose);
      }

      const totalNodes = parseResult.graph.nodes.length;
      return {
        unchanged: 0,
        updated: 0,
        created: totalNodes,
        deleted: 0
      };
    }
  }

  /**
   * Mark embeddings as clean for specified scopes
   * Call this after successfully generating embeddings
   */
  async markEmbeddingsClean(uuids: string[]): Promise<void> {
    if (uuids.length === 0) return;

    await this.client.run(
      `
      MATCH (n:Scope)
      WHERE n.uuid IN $uuids
      SET n.embeddingsDirty = false
      `,
      { uuids }
    );
  }

  /**
   * Get list of scopes with dirty embeddings
   * Useful for selective embedding regeneration
   */
  async getDirtyScopes(): Promise<Array<{ uuid: string; name: string; file: string }>> {
    const result = await this.client.run(
      `
      MATCH (n:Scope)
      WHERE n.embeddingsDirty = true
      RETURN n.uuid AS uuid, n.name AS name, n.file AS file
      `
    );

    return result.records.map(record => ({
      uuid: record.get('uuid'),
      name: record.get('name'),
      file: record.get('file')
    }));
  }

  /**
   * Count scopes with dirty embeddings
   */
  async countDirtyScopes(): Promise<number> {
    const result = await this.client.run(
      `
      MATCH (n:Scope)
      WHERE n.embeddingsDirty = true
      RETURN count(n) AS count
      `
    );

    return result.records[0]?.get('count')?.toNumber() || 0;
  }

  /**
   * Check if a specific scope has dirty embeddings
   */
  async isScopeDirty(uuid: string): Promise<boolean> {
    const result = await this.client.run(
      `
      MATCH (n:Scope {uuid: $uuid})
      RETURN n.embeddingsDirty AS dirty
      `,
      { uuid }
    );

    return result.records[0]?.get('dirty') === true;
  }

  /**
   * Ingest a pre-parsed graph into Neo4j
   * Public wrapper around the private ingestNodes method
   *
   * @param graph - Parsed nodes and relationships
   * @param options - Ingestion options
   */
  async ingestGraph(
    graph: {
      nodes: ParsedNode[];
      relationships: ParsedRelationship[];
    },
    options: { projectId?: string; markDirty?: boolean; onProgress?: ProgressCallback } = {}
  ): Promise<{ nodesCreated: number; relationshipsCreated: number }> {
    const { markDirty = true, onProgress } = options;

    await this.ingestNodes(graph.nodes, graph.relationships, markDirty, onProgress);

    return {
      nodesCreated: graph.nodes.length,
      relationshipsCreated: graph.relationships.length,
    };
  }

  /**
   * Re-ingest multiple files at once (for batch processing agent edits)
   *
   * More efficient than calling reIngestFile in a loop.
   * Handles both creates, updates, and deletes.
   *
   * @param changes - Array of file changes (path + changeType)
   * @param rootPath - Root path for relative path calculation
   * @param options - Ingestion options including projectId
   */
  async reIngestFiles(
    changes: Array<{ path: string; changeType: 'created' | 'updated' | 'deleted' }>,
    rootPath: string,
    options: IngestionOptions = {}
  ): Promise<IncrementalStats> {
    const { projectId, verbose = false, trackChanges } = options;
    const path = await import('path');

    if (changes.length === 0) {
      return { unchanged: 0, updated: 0, created: 0, deleted: 0 };
    }

    if (verbose) {
      console.log(`🔄 Re-ingesting ${changes.length} files...`);
    }

    // Separate deletes from creates/updates
    const deletes = changes.filter(c => c.changeType === 'deleted');
    const upserts = changes.filter(c => c.changeType !== 'deleted');

    let stats: IncrementalStats = { unchanged: 0, updated: 0, created: 0, deleted: 0 };

    // Handle deletes
    if (deletes.length > 0) {
      const relPaths = deletes.map(d => path.relative(rootPath, d.path));

      // Delete all nodes for these files (filtered by projectId if provided)
      const query = projectId
        ? `
          MATCH (n)
          WHERE n.projectId = $projectId
            AND (n.absolutePath IN $relPaths OR n.path IN $relPaths OR n.filePath IN $relPaths OR n.file IN $relPaths)
          DETACH DELETE n
          RETURN count(n) AS deleted
          `
        : `
          MATCH (n)
          WHERE n.absolutePath IN $relPaths OR n.path IN $relPaths OR n.filePath IN $relPaths OR n.file IN $relPaths
          DETACH DELETE n
          RETURN count(n) AS deleted
          `;

      const result = await this.client.run(query, { projectId, relPaths });
      stats.deleted = result.records[0]?.get('deleted')?.toNumber() || 0;

      if (verbose) {
        console.log(`   Deleted ${stats.deleted} nodes for ${deletes.length} files`);
      }
    }

    // Handle creates/updates
    if (upserts.length > 0) {
      const relPaths = upserts.map(u => path.relative(rootPath, u.path));

      // For updates, query existing UUIDs BEFORE deleting (for UUID preservation)
      const updates = upserts.filter(u => u.changeType === 'updated');
      let existingUUIDMapping: Map<string, Array<{ uuid: string; file: string; type: string }>> | undefined;

      if (updates.length > 0 && projectId) {
        const updatePaths = updates.map(u => path.relative(rootPath, u.path));

        // Query existing scopes for these files BEFORE deletion
        // This allows us to preserve UUIDs and embeddings during re-ingestion
        existingUUIDMapping = new Map();
        const existingScopesResult = await this.client.run(
          `
          MATCH (s:Scope)
          WHERE s.projectId = $projectId
            AND s.file IN $updatePaths
          RETURN s.uuid AS uuid, s.name AS name, s.file AS file, s.type AS type,
                 s.embedding_name_hash AS nameHash, s.embedding_content_hash AS contentHash,
                 s.embedding_description_hash AS descHash,
                 s.embedding_name AS embeddingName, s.embedding_content AS embeddingContent,
                 s.embedding_description AS embeddingDescription,
                 s.embedding_provider AS embeddingProvider, s.embedding_model AS embeddingModel
          `,
          { projectId, updatePaths }
        );

        for (const record of existingScopesResult.records) {
          const name = record.get('name');
          const entry = {
            uuid: record.get('uuid'),
            file: record.get('file'),
            type: record.get('type'),
            // Also capture embedding hashes and vectors for preservation
            nameHash: record.get('nameHash'),
            contentHash: record.get('contentHash'),
            descHash: record.get('descHash'),
            embeddingName: record.get('embeddingName'),
            embeddingContent: record.get('embeddingContent'),
            embeddingDescription: record.get('embeddingDescription'),
            embeddingProvider: record.get('embeddingProvider'),
            embeddingModel: record.get('embeddingModel'),
          };
          const existing = existingUUIDMapping.get(name) || [];
          existing.push(entry);
          existingUUIDMapping.set(name, existing);
        }

        if (verbose) {
          console.log(`   Captured ${existingUUIDMapping.size} unique symbols from ${updates.length} files for UUID preservation`);
        }

        // Now delete existing nodes
        const deleteQuery = `
            MATCH (n)
            WHERE n.projectId = $projectId
              AND (n.absolutePath IN $updatePaths OR n.path IN $updatePaths OR n.filePath IN $updatePaths OR n.file IN $updatePaths)
            DETACH DELETE n
            `;

        await this.client.run(deleteQuery, { projectId, updatePaths });
      } else if (updates.length > 0) {
        // No projectId, just delete without UUID preservation
        const updatePaths = updates.map(u => path.relative(rootPath, u.path));
        const deleteQuery = `
            MATCH (n)
            WHERE n.absolutePath IN $updatePaths OR n.path IN $updatePaths OR n.filePath IN $updatePaths OR n.file IN $updatePaths
            DETACH DELETE n
            `;

        await this.client.run(deleteQuery, { updatePaths });
      }

      // Parse and ingest the files, passing existingUUIDMapping for UUID preservation
      const ingestStats = await this.ingestFromPaths(
        {
          type: 'files',
          root: rootPath,
          include: relPaths,
        },
        {
          projectId,
          verbose,
          trackChanges,
          incremental: false, // We already handled incremental logic above
          existingUUIDMapping, // Pass pre-queried UUIDs for preservation
        }
      );

      // Restore embedding hashes and vectors from pre-queried data
      // This is necessary because we deleted the nodes before re-ingestion
      if (existingUUIDMapping && existingUUIDMapping.size > 0) {
        const embeddingUpdates: Array<{
          uuid: string;
          nameHash: string | null;
          contentHash: string | null;
          descHash: string | null;
          embeddingName: number[] | null;
          embeddingContent: number[] | null;
          embeddingDescription: number[] | null;
          embeddingProvider: string | null;
          embeddingModel: string | null;
        }> = [];

        for (const [, entries] of existingUUIDMapping) {
          for (const entry of entries) {
            const e = entry as any; // Access additional embedding properties
            // Only restore if there's at least one embedding, hash, or provider info
            if (e.nameHash || e.contentHash || e.descHash || e.embeddingName || e.embeddingContent || e.embeddingDescription || e.embeddingProvider || e.embeddingModel) {
              embeddingUpdates.push({
                uuid: e.uuid,
                nameHash: e.nameHash || null,
                contentHash: e.contentHash || null,
                descHash: e.descHash || null,
                embeddingName: e.embeddingName || null,
                embeddingContent: e.embeddingContent || null,
                embeddingDescription: e.embeddingDescription || null,
                embeddingProvider: e.embeddingProvider || null,
                embeddingModel: e.embeddingModel || null,
              });
            }
          }
        }

        if (embeddingUpdates.length > 0) {
          // Batch update embedding hashes and vectors
          await this.client.run(
            `
            UNWIND $updates AS u
            MATCH (n {uuid: u.uuid})
            SET n.embedding_name_hash = u.nameHash,
                n.embedding_content_hash = u.contentHash,
                n.embedding_description_hash = u.descHash,
                n.embedding_name = u.embeddingName,
                n.embedding_content = u.embeddingContent,
                n.embedding_description = u.embeddingDescription,
                n.embedding_provider = u.embeddingProvider,
                n.embedding_model = u.embeddingModel
            `,
            { updates: embeddingUpdates }
          );

          if (verbose) {
            console.log(`   Restored embeddings for ${embeddingUpdates.length} nodes`);
          }
        }
      }

      stats.created = ingestStats.created;
      stats.updated = updates.length; // Files we deleted then re-created
    }

    return stats;
  }

  /**
   * Re-ingest a single file (optimized for file tool modifications)
   *
   * This method:
   * 1. Parses only the specified file
   * 2. Deletes scopes that were in the old version but not the new
   * 3. Upserts new/modified scopes
   * 4. Marks affected scopes as embeddingsDirty
   *
   * @param filePath - Absolute path to the file
   * @param sourceConfig - Source configuration (for adapter type, root path)
   * @param options - Optional settings including projectId
   */
  async reIngestFile(
    filePath: string,
    sourceConfig: SourceConfig,
    options: IngestionOptions = {}
  ): Promise<{
    scopesCreated: number;
    scopesUpdated: number;
    scopesDeleted: number;
  }> {
    const verbose = options.verbose ?? false;
    const fs = await import('fs/promises');
    const path = await import('path');

    // Resolve relative path from root
    const root = sourceConfig.root || '.';
    const relativePath = path.relative(root, filePath);

    if (verbose) {
      console.log(`🔄 Re-ingesting file: ${relativePath}`);
    }

    // Check if file exists
    let fileExists = true;
    try {
      await fs.access(filePath);
    } catch {
      fileExists = false;
    }

    // Get existing scopes for this file
    const existingResult = await this.client.run(
      `
      MATCH (s:Scope)
      WHERE s.absolutePath = $filePath OR s.file = $relativePath OR s.file = $filePath
      RETURN s.uuid AS uuid, s.hash AS hash, s.name AS name, s.source AS source
      `,
      { relativePath, filePath }
    );

    const existingScopes = new Map<string, { hash: string; name: string; source?: string }>();
    for (const record of existingResult.records) {
      existingScopes.set(record.get('uuid'), {
        hash: record.get('hash'),
        name: record.get('name'),
        source: record.get('source')
      });
    }

    if (verbose) {
      console.log(`   Found ${existingScopes.size} existing scopes for this file`);
    }

    // If file was deleted, remove all its scopes
    if (!fileExists) {
      const deletedUuids = Array.from(existingScopes.keys());
      if (deletedUuids.length > 0) {
        await this.deleteNodes(deletedUuids);
        if (verbose) {
          console.log(`   ✅ Deleted ${deletedUuids.length} scopes (file removed)`);
        }
      }
      return {
        scopesCreated: 0,
        scopesUpdated: 0,
        scopesDeleted: deletedUuids.length
      };
    }

    // Parse the single file
    const adapter = getAdapter();

    // Read file content
    const content = await fs.readFile(filePath, 'utf-8');

    // Query all existing project scopes for cross-file import resolution
    const existingUUIDMapping = new Map<string, Array<{ uuid: string; file: string; type: string }>>();
    if (options.projectId) {
      const projectScopesResult = await this.client.run(
        `
        MATCH (s:Scope)
        WHERE s.projectId = $projectId
        RETURN s.uuid AS uuid, s.name AS name, s.file AS file, s.type AS type
        `,
        { projectId: options.projectId }
      );
      for (const record of projectScopesResult.records) {
        const name = record.get('name');
        const entry = {
          uuid: record.get('uuid'),
          file: record.get('file'),
          type: record.get('type')
        };
        const existing = existingUUIDMapping.get(name) || [];
        existing.push(entry);
        existingUUIDMapping.set(name, existing);
      }
      if (verbose) {
        console.log(`   Loaded ${existingUUIDMapping.size} unique symbols from project for cross-file resolution`);
      }
    }

    // Create a mini source config for just this file
    const singleFileConfig: SourceConfig = {
      ...sourceConfig,
      include: [relativePath]
    };

    // Parse the file
    const parseResult = await adapter.parse({
      source: singleFileConfig,
      projectId: options.projectId, // Pass projectId for consistency
      existingUUIDMapping, // Pass existing project scopes for cross-file import resolution
      onProgress: undefined
    });

    // Get new scopes
    const newScopes = parseResult.graph.nodes.filter(n => n.labels.includes('Scope'));

    if (verbose) {
      console.log(`   Parsed ${newScopes.length} scopes from file`);
    }

    // Classify changes
    const newScopeIds = new Set(newScopes.map(n => n.id));
    const existingIds = new Set(existingScopes.keys());

    const created = newScopes.filter(n => !existingIds.has(n.id));
    const updated = newScopes.filter(n => {
      const existing = existingScopes.get(n.id);
      return existing && existing.hash !== n.properties.hash;
    });
    const deleted = Array.from(existingIds).filter(id => !newScopeIds.has(id));

    if (verbose) {
      console.log(`   Changes: +${created.length} created, ~${updated.length} updated, -${deleted.length} deleted`);
    }

    // Delete removed scopes
    if (deleted.length > 0) {
      await this.deleteNodes(deleted);
    }

    // Upsert created + updated scopes
    const nodesToUpsert = [...created, ...updated];
    if (nodesToUpsert.length > 0) {
      // Include File node for the file
      const fileNodes = parseResult.graph.nodes.filter(n => n.labels.includes('File'));

      // Get relevant relationships
      const affectedUuids = new Set(nodesToUpsert.map(n => n.id));
      const relevantRelationships = parseResult.graph.relationships.filter(rel =>
        affectedUuids.has(rel.from) || affectedUuids.has(rel.to)
      );

      await this.ingestNodes(
        [...nodesToUpsert, ...fileNodes],
        relevantRelationships,
        true // Mark as embeddingsDirty
      );
    }

    // Track changes if enabled
    if (options.trackChanges && (created.length > 0 || updated.length > 0 || deleted.length > 0)) {
      const changesToTrack: Array<{
        entityType: string;
        entityUuid: string;
        entityLabel: string;
        oldContent: string | null;
        newContent: string;
        oldHash: string | null;
        newHash: string;
        changeType: 'created' | 'updated' | 'deleted';
      }> = [];

      for (const node of created) {
        changesToTrack.push({
          entityType: 'Scope',
          entityUuid: node.id,
          entityLabel: node.properties.name as string,
          oldContent: null,
          newContent: node.properties.source as string,
          oldHash: null,
          newHash: node.properties.hash as string,
          changeType: 'created'
        });
      }

      for (const node of updated) {
        const existing = existingScopes.get(node.id);
        changesToTrack.push({
          entityType: 'Scope',
          entityUuid: node.id,
          entityLabel: node.properties.name as string,
          oldContent: existing?.source || null,
          newContent: node.properties.source as string,
          oldHash: existing?.hash || null,
          newHash: node.properties.hash as string,
          changeType: 'updated'
        });
      }

      for (const uuid of deleted) {
        const existing = existingScopes.get(uuid);
        if (existing) {
          changesToTrack.push({
            entityType: 'Scope',
            entityUuid: uuid,
            entityLabel: existing.name,
            oldContent: existing.source || '',
            newContent: '',
            oldHash: existing.hash,
            newHash: '',
            changeType: 'deleted'
          });
        }
      }

      await this.changeTracker.trackEntityChangesBatch(changesToTrack);
    }

    if (verbose) {
      console.log(`   ✅ Re-ingestion complete`);
    }

    return {
      scopesCreated: created.length,
      scopesUpdated: updated.length,
      scopesDeleted: deleted.length
    };
  }

  // ============================================
  // Reference Extraction
  // ============================================

  /**
   * Process file references for a project
   * Extracts imports/references from file content and creates appropriate relationships
   *
   * This should be called after initial ingestion to create:
   * - CONSUMES relations (code → code)
   * - REFERENCES_ASSET relations (* → images, fonts, etc.)
   * - REFERENCES_DOC relations (* → markdown, documents)
   * - REFERENCES_STYLE relations (* → stylesheets)
   * - REFERENCES_DATA relations (* → JSON, YAML)
   *
   * @param projectId - Project ID to process
   * @param projectPath - Absolute path to the project root
   * @param options - Processing options
   */
  async processFileReferences(
    projectId: string,
    projectPath: string,
    options: {
      /** Only process specific files (relative paths) */
      files?: string[];
      /** Verbose logging */
      verbose?: boolean;
    } = {}
  ): Promise<{ processed: number; created: number; pending: number }> {
    const { files, verbose = false } = options;

    // Get files to process
    let filesToProcess: Array<{ uuid: string; path: string; absolutePath: string }>;

    if (files && files.length > 0) {
      // Process specific files
      const result = await this.client.run(`
        MATCH (f:File {projectId: $projectId})
        WHERE f.file IN $files OR f.path IN $files
        RETURN f.uuid as uuid, f.file as path
      `, { projectId, files });

      filesToProcess = result.records.map(r => ({
        uuid: r.get('uuid'),
        path: r.get('path'),
        absolutePath: pathModule.resolve(projectPath, r.get('path')),
      }));
    } else {
      // Get all files for the project
      const result = await this.client.run(`
        MATCH (f:File {projectId: $projectId})
        WHERE f.file IS NOT NULL
        RETURN f.uuid as uuid, f.file as path
      `, { projectId });

      filesToProcess = result.records.map(r => ({
        uuid: r.get('uuid'),
        path: r.get('path'),
        absolutePath: pathModule.resolve(projectPath, r.get('path')),
      }));
    }

    if (verbose) {
      console.log(`[References] Processing ${filesToProcess.length} files for project ${projectId}`);
    }

    let totalCreated = 0;
    let totalPending = 0;
    let processed = 0;

    for (const file of filesToProcess) {
      try {
        // Read file content
        const content = await fs.readFile(file.absolutePath, 'utf-8');

        // Extract references
        const refs = extractReferences(content, file.absolutePath);
        if (refs.length === 0) {
          continue;
        }

        // Resolve references
        const resolvedRefs = await resolveAllReferences(refs, file.absolutePath, projectPath);
        if (resolvedRefs.length === 0) {
          continue;
        }

        // Get source node UUID (use File node or find primary Scope)
        const sourceResult = await this.client.run(`
          MATCH (f:File {uuid: $fileUuid})
          OPTIONAL MATCH (s:Scope)-[:DEFINED_IN]->(f)
          WHERE s.scopeType IN ['function', 'class', 'module', 'file']
          RETURN f.uuid as fileUuid, collect(s.uuid)[0] as scopeUuid
        `, { fileUuid: file.uuid });

        const record = sourceResult.records[0];
        if (!record) continue;

        // Prefer scope UUID if available, otherwise use file UUID
        const sourceUuid = record.get('scopeUuid') || record.get('fileUuid');

        // Create reference relations
        const result = await createReferenceRelations(
          this.client,
          sourceUuid,
          file.path,
          resolvedRefs,
          projectId,
          { createPending: true, useAbsolutePath: false }
        );

        totalCreated += result.created;
        totalPending += result.pending;
        processed++;

        if (verbose && (result.created > 0 || result.pending > 0)) {
          console.log(`[References] ${file.path}: ${result.created} created, ${result.pending} pending`);
        }
      } catch (err) {
        // Skip files that can't be read (binary, deleted, etc.)
        if (verbose) {
          console.warn(`[References] Skipping ${file.path}: ${err instanceof Error ? err.message : 'unknown error'}`);
        }
      }
    }

    // Try to resolve pending imports from previous ingestions
    const pendingResult = await resolvePendingImports(this.client, projectId);
    if (verbose && pendingResult.resolved > 0) {
      console.log(`[References] Resolved ${pendingResult.resolved} pending imports, ${pendingResult.remaining} remaining`);
    }

    if (verbose) {
      console.log(`[References] Total: ${processed} files processed, ${totalCreated} relations created, ${totalPending} pending`);
    }

    return { processed, created: totalCreated, pending: totalPending };
  }

  /**
   * Process file references for virtual files (in-memory content)
   * Same as processFileReferences but works with content already in memory
   *
   * Useful for:
   * - Uploaded files (ZIP extraction)
   * - Generated content
   * - Any case where files aren't on disk
   *
   * @param projectId - Project ID to process
   * @param virtualFiles - Array of virtual files with path and content
   * @param options - Processing options
   */
  async processVirtualFileReferences(
    projectId: string,
    virtualFiles: Array<{ path: string; content: string }>,
    options: {
      /** Verbose logging */
      verbose?: boolean;
      /** Pre-built map of path → uuid to skip Neo4j lookups (HUGE performance boost) */
      pathToUuidMap?: Map<string, string>;
    } = {}
  ): Promise<{ processed: number; created: number; pending: number }> {
    const { verbose = false, pathToUuidMap } = options;

    if (verbose) {
      console.log(`[References] Processing ${virtualFiles.length} virtual files for project ${projectId}`);
    }

    let totalCreated = 0;
    let totalPending = 0;
    let processed = 0;

    // Map of extension to reference type
    const TYPE_BY_EXT: Record<string, string> = {
      '.md': 'document', '.mdx': 'document', '.markdown': 'document',
      '.pdf': 'document', '.doc': 'document', '.docx': 'document',
      '.txt': 'document', '.rtf': 'document',
      '.png': 'asset', '.jpg': 'asset', '.jpeg': 'asset', '.gif': 'asset',
      '.svg': 'asset', '.webp': 'asset', '.ico': 'asset', '.bmp': 'asset',
      '.css': 'stylesheet', '.scss': 'stylesheet', '.sass': 'stylesheet', '.less': 'stylesheet',
      '.json': 'data', '.yaml': 'data', '.yml': 'data', '.xml': 'data', '.csv': 'data',
    };

    for (const file of virtualFiles) {
      try {
        // Extract references from in-memory content
        const refs = extractReferences(file.content, file.path);
        if (refs.length === 0) {
          continue;
        }

        // For virtual files, resolve paths manually without fs.access checks
        // since virtual files don't exist on disk
        const fileDir = pathModule.dirname(file.path);
        const resolvedRefs: ResolvedReference[] = [];

        // Separate URL refs from file refs
        const urlRefs: ResolvedReference[] = [];

        for (const ref of refs) {
          // Handle URL references
          if (ref.type === 'url' && ref.url) {
            urlRefs.push({
              ...ref,
              absolutePath: ref.url,
              relativePath: ref.url,
              relationType: 'LINKS_TO_URL',
            });
            continue;
          }

          if (!ref.isLocal) continue;

          // Resolve relative path to absolute
          const absolutePath = pathModule.resolve(fileDir, ref.source);
          const relativePath = ref.source;
          const targetExt = pathModule.extname(absolutePath).toLowerCase();
          const targetType = TYPE_BY_EXT[targetExt] || 'code';

          // Determine relation type based on target type and confidence
          let relationType: RelationType;

          // Low confidence references use MENTIONS_FILE
          if (ref.confidence !== undefined && ref.confidence < 0.8) {
            relationType = 'MENTIONS_FILE';
          } else {
            switch (targetType) {
              case 'asset': relationType = 'REFERENCES_ASSET'; break;
              case 'document': relationType = 'REFERENCES_DOC'; break;
              case 'stylesheet': relationType = 'REFERENCES_STYLE'; break;
              case 'data': relationType = 'REFERENCES_DATA'; break;
              default: relationType = 'CONSUMES';
            }
          }

          resolvedRefs.push({
            ...ref,
            absolutePath,
            relativePath,
            relationType,
          });
        }

        // Add URL refs to the resolved refs
        resolvedRefs.push(...urlRefs);

        if (resolvedRefs.length === 0) {
          continue;
        }

        if (verbose) {
          console.log(`[References] ${file.path}: extracted ${resolvedRefs.length} references`);
        }

        // Get the source UUID - use map if available (O(1)), otherwise query Neo4j (slow)
        let sourceUuid: string | undefined;

        if (pathToUuidMap) {
          // Fast path: use pre-built map
          sourceUuid = pathToUuidMap.get(file.path);
          if (!sourceUuid && verbose) {
            console.warn(`[References] No uuid in map for: ${file.path}`);
          }
        } else {
          // Slow path: query Neo4j (only used when map not provided)
          // Using UNION to allow Neo4j to use indexes on each property separately
          const sourceResult = await this.client.run(`
            CALL {
              MATCH (n:Scope)
              WHERE n.projectId = $projectId AND n.file = $filePath
              RETURN n, labels(n) as lbls
              UNION
              MATCH (n:Scope)
              WHERE n.projectId = $projectId AND n.path = $filePath
              RETURN n, labels(n) as lbls
              UNION
              MATCH (n:File)
              WHERE n.projectId = $projectId AND n.path = $filePath
              RETURN n, labels(n) as lbls
              UNION
              MATCH (n:File)
              WHERE n.projectId = $projectId AND n.absolutePath = $filePath
              RETURN n, labels(n) as lbls
              UNION
              MATCH (n:MarkdownDocument)
              WHERE n.projectId = $projectId AND n.path = $filePath
              RETURN n, labels(n) as lbls
              UNION
              MATCH (n:MarkdownSection)
              WHERE n.projectId = $projectId AND n.file = $filePath
              RETURN n, labels(n) as lbls
              UNION
              MATCH (n:MarkdownSection)
              WHERE n.projectId = $projectId AND n.path = $filePath
              RETURN n, labels(n) as lbls
            }
            RETURN n.uuid as uuid, lbls as labels
            ORDER BY CASE
              WHEN 'MarkdownDocument' IN lbls THEN 1
              WHEN 'File' IN lbls THEN 2
              ELSE 3
            END
            LIMIT 1
          `, { projectId, filePath: file.path });

          if (sourceResult.records.length > 0) {
            sourceUuid = sourceResult.records[0].get('uuid');
          } else if (verbose) {
            console.warn(`[References] No node found for virtual file: ${file.path}`);
          }
        }

        if (!sourceUuid) {
          continue;
        }

        // Create reference relations
        const result = await createReferenceRelations(
          this.client,
          sourceUuid,
          file.path,
          resolvedRefs,
          projectId,
          { createPending: true, useAbsolutePath: false }
        );

        totalCreated += result.created;
        totalPending += result.pending;
        processed++;

        if (verbose && (result.created > 0 || result.pending > 0)) {
          console.log(`[References] ${file.path}: ${result.created} created, ${result.pending} pending`);
        }
      } catch (err) {
        if (verbose) {
          console.warn(`[References] Error processing ${file.path}: ${err instanceof Error ? err.message : 'unknown error'}`);
        }
      }
    }

    // Try to resolve pending imports
    const pendingResult = await resolvePendingImports(this.client, projectId);
    if (verbose && pendingResult.resolved > 0) {
      console.log(`[References] Resolved ${pendingResult.resolved} pending imports, ${pendingResult.remaining} remaining`);
    }

    if (verbose) {
      console.log(`[References] Total: ${processed} files processed, ${totalCreated} relations created, ${totalPending} pending`);
    }

    return { processed, created: totalCreated, pending: totalPending };
  }

  // ============================================
  // State Machine Integration
  // ============================================

  /**
   * Get ingestion status for a project using the state machine
   * Shows progress through all lifecycle states
   */
  async getIngestionStatus(projectId: string): Promise<{
    stats: Record<FileState, number>;
    progress: { processed: number; total: number; percentage: number };
    errors: { total: number; retryable: number };
  }> {
    const stats = await this.stateMachine.getStateStats(projectId);
    const progress = await this.stateMachine.getProgress(projectId);
    const errorStats = await this.stateMachine.getErrorStats(projectId);
    const retryable = await this.stateMachine.getRetryableFiles(projectId);

    return {
      stats,
      progress,
      errors: {
        total: stats.error,
        retryable: retryable.length,
      },
    };
  }

  /**
   * Initialize state machine for a project
   * Migrates existing files to have proper state tracking
   */
  async initializeStateMachine(projectId: string, verbose: boolean = false): Promise<{
    needsMigration: boolean;
    migrated: { embedded: number; linked: number; discovered: number };
  }> {
    const needsMigration = await this.stateMigration.needsMigration(projectId);

    if (!needsMigration) {
      return { needsMigration: false, migrated: { embedded: 0, linked: 0, discovered: 0 } };
    }

    if (verbose) {
      console.log(`[StateMachine] Migrating existing files for project ${projectId}...`);
    }

    const migrated = await this.stateMigration.migrateExistingFiles(projectId);

    if (verbose) {
      console.log(`[StateMachine] Migration complete: ${migrated.embedded} embedded, ${migrated.linked} linked, ${migrated.discovered} discovered`);
    }

    return { needsMigration: true, migrated };
  }

  /**
   * Resume processing for files that didn't complete their ingestion cycle
   * This handles:
   * - Files stuck in intermediate states (parsing, relations, embedding)
   * - Files in error state that can be retried
   * - Files in discovered state that need parsing
   *
   * @param projectId - Project ID to resume
   * @param projectPath - Absolute path to project root
   * @param options - Processing options
   */
  async resumeIncomplete(
    projectId: string,
    projectPath: string,
    options: {
      verbose?: boolean;
      maxRetries?: number;
      stuckThresholdMs?: number;
    } = {}
  ): Promise<{
    stuckReset: number;
    parsed: number;
    linked: number;
    embedded: number;
    errors: number;
  }> {
    const { verbose = false, maxRetries = 3, stuckThresholdMs = 5 * 60 * 1000 } = options;

    // Initialize state machine if needed
    await this.initializeStateMachine(projectId, verbose);

    const result = {
      stuckReset: 0,
      parsed: 0,
      linked: 0,
      embedded: 0,
      errors: 0,
    };

    // 1. Reset stuck files
    result.stuckReset = await this.stateMachine.resetStuckFiles(projectId, stuckThresholdMs);
    if (verbose && result.stuckReset > 0) {
      console.log(`[Resume] Reset ${result.stuckReset} stuck files`);
    }

    // 2. Get current state stats
    const stats = await this.stateMachine.getStateStats(projectId);
    if (verbose) {
      console.log(`[Resume] Current state: ${JSON.stringify(stats)}`);
    }

    // 3. Process files in 'discovered' state (need parsing)
    const toParse = await this.stateMachine.getFilesInState(projectId, 'discovered');
    if (toParse.length > 0) {
      if (verbose) {
        console.log(`[Resume] ${toParse.length} files need parsing`);
      }

      for (const file of toParse) {
        try {
          await this.stateMachine.transition(file.uuid, 'parsing');
          // In a full implementation, we'd re-parse the file here
          // For now, mark as parsed since the file content should already be in the graph
          await this.stateMachine.transition(file.uuid, 'parsed');
          result.parsed++;
        } catch (err) {
          await this.stateMachine.transition(file.uuid, 'error', {
            errorType: 'parse',
            errorMessage: err instanceof Error ? err.message : 'Unknown error',
          });
          result.errors++;
        }
      }
    }

    // 4. Process files in 'parsed' state (need relations)
    const toLink = await this.stateMachine.getFilesInState(projectId, 'parsed');
    if (toLink.length > 0) {
      if (verbose) {
        console.log(`[Resume] ${toLink.length} files need relations`);
      }

      // Batch process relations
      const fileUuids = toLink.map((f) => f.uuid);
      await this.stateMachine.transitionBatch(fileUuids, 'relations');

      try {
        // Process references for all files
        await this.processFileReferences(projectId, projectPath, { verbose });

        await this.stateMachine.transitionBatch(fileUuids, 'linked');
        result.linked += toLink.length;
      } catch (err) {
        await this.stateMachine.transitionBatch(fileUuids, 'error', {
          errorType: 'relations',
          errorMessage: err instanceof Error ? err.message : 'Unknown error',
        });
        result.errors += toLink.length;
      }
    }

    // 5. Process files in 'linked' state (need embeddings)
    // Note: Embeddings are typically generated in batch via EmbeddingService
    // Just mark them as ready for embedding
    const toEmbed = await this.stateMachine.getFilesInState(projectId, 'linked');
    if (toEmbed.length > 0 && verbose) {
      console.log(`[Resume] ${toEmbed.length} files ready for embedding (use EmbeddingService to generate)`);
    }

    // 6. Retry files in error state
    const retryable = await this.stateMachine.getRetryableFiles(projectId, maxRetries);
    if (retryable.length > 0) {
      if (verbose) {
        console.log(`[Resume] ${retryable.length} files can be retried`);
      }

      for (const file of retryable) {
        // Reset to discovered to retry from the beginning
        await this.stateMachine.transition(file.uuid, 'discovered');
      }
    }

    if (verbose) {
      console.log(`[Resume] Complete: ${result.parsed} parsed, ${result.linked} linked, ${result.errors} errors`);
    }

    return result;
  }

  /**
   * Mark files as embedded after successful embedding generation
   * Call this after EmbeddingService completes
   */
  async markFilesEmbedded(projectId: string): Promise<number> {
    const linked = await this.stateMachine.getFilesInState(projectId, 'linked');
    if (linked.length === 0) return 0;

    const fileUuids = linked.map((f) => f.uuid);
    return this.stateMachine.transitionBatch(fileUuids, 'embedded');
  }

  /**
   * Get files that need embedding for a project
   */
  async getFilesNeedingEmbedding(projectId: string): Promise<FileStateInfo[]> {
    return this.stateMachine.getFilesInState(projectId, 'linked');
  }

  /**
   * Print ingestion status to console (for debugging)
   */
  async printIngestionStatus(projectId: string): Promise<void> {
    const status = await this.getIngestionStatus(projectId);

    console.log(`\nIngestion Status for ${projectId}:`);
    console.log(`  ✓ Embedded:   ${status.stats.embedded}`);
    console.log(`  → Embedding:  ${status.stats.embedding}`);
    console.log(`  ○ Linked:     ${status.stats.linked}`);
    console.log(`  ○ Relations:  ${status.stats.relations}`);
    console.log(`  ○ Parsed:     ${status.stats.parsed}`);
    console.log(`  ○ Parsing:    ${status.stats.parsing}`);
    console.log(`  ○ Discovered: ${status.stats.discovered}`);
    console.log(`  ✗ Errors:     ${status.stats.error} (${status.errors.retryable} retryable)`);
    console.log(`\nProgress: ${status.progress.processed}/${status.progress.total} (${status.progress.percentage}%)`);
  }
}
