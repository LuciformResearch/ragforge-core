/**
 * MetadataPreserver - Centralized capture/restore of node metadata
 *
 * This class handles the preservation of embeddings, UUIDs, and other metadata
 * during file re-ingestion. It provides a single point of responsibility for:
 *
 * 1. Capturing metadata BEFORE nodes are deleted
 * 2. Restoring metadata AFTER new nodes are created
 * 3. Detecting provider/model mismatches
 * 4. Building UUID mappings for parser reuse
 */

import type { Driver, Session } from 'neo4j-driver';
import type {
  NodeMetadata,
  CapturedMetadata,
  UuidMapping,
  UuidEntry,
  RestoreResult,
} from './types.js';

/**
 * Node types that support embedding preservation
 */
const EMBEDDABLE_NODE_TYPES = [
  'Scope',           // Code: functions, classes, interfaces, etc.
  'MarkdownSection', // Markdown: sections with headings
  'CodeBlock',       // Markdown: code blocks within markdown
  'WebPage',         // Web: crawled pages
  'DocumentFile',    // Documents: PDF, DOCX, etc.
  'ImageFile',       // Images with descriptions
  'ThreeDFile',      // 3D models with descriptions
  'DataFile',        // JSON/YAML/XML files
];

/**
 * Configuration for metadata preservation
 */
export interface PreserverConfig {
  /** Enable verbose logging */
  verbose?: boolean;

  /** Current embedding provider (for mismatch detection) */
  currentProvider?: string;

  /** Current embedding model (for mismatch detection) */
  currentModel?: string;

  /** Whether to skip restore on provider mismatch (default: true) */
  skipOnProviderMismatch?: boolean;
}

export class MetadataPreserver {
  private driver: Driver;
  private config: PreserverConfig;

  constructor(driver: Driver, config: PreserverConfig = {}) {
    this.driver = driver;
    this.config = {
      skipOnProviderMismatch: true,
      ...config,
    };
  }

  /**
   * Update the current provider/model configuration
   */
  setProviderInfo(provider: string, model: string): void {
    this.config.currentProvider = provider;
    this.config.currentModel = model;
  }

  /**
   * Capture metadata for all nodes in the specified files BEFORE deletion
   *
   * @param files - Array of file paths (relative to project root)
   * @param projectId - Optional project ID to filter by
   * @returns Captured metadata ready for restoration
   */
  async captureForFiles(
    files: string[],
    projectId?: string
  ): Promise<CapturedMetadata> {
    const session = this.driver.session();

    try {
      const captured: CapturedMetadata = {
        byUuid: new Map(),
        bySymbolKey: new Map(),
        currentProvider: this.config.currentProvider,
        currentModel: this.config.currentModel,
        capturedAt: new Date(),
      };

      if (files.length === 0) {
        return captured;
      }

      // Build the query to capture all embeddable node types
      // We query all types in one go for efficiency
      const nodeTypeQueries = EMBEDDABLE_NODE_TYPES.map(type => {
        const fileField = this.getFileFieldForType(type);
        const whereClause = projectId
          ? `WHERE n.projectId = $projectId AND n.${fileField} IN $files`
          : `WHERE n.${fileField} IN $files`;

        return `
          MATCH (n:${type})
          ${whereClause}
          RETURN
            n.uuid AS uuid,
            n.${fileField} AS file,
            '${type}' AS type,
            n.name AS name,
            n.startLine AS startLine,
            n.endLine AS endLine,
            n.contentHash AS contentHash,
            n.embedding_name AS embedding_name,
            n.embedding_content AS embedding_content,
            n.embedding_description AS embedding_description,
            n.embedding_name_hash AS embedding_name_hash,
            n.embedding_content_hash AS embedding_content_hash,
            n.embedding_description_hash AS embedding_description_hash,
            n.embedding_provider AS embedding_provider,
            n.embedding_model AS embedding_model
        `;
      }).join(' UNION ALL ');

      const result = await session.run(nodeTypeQueries, { files, projectId });

      for (const record of result.records) {
        const metadata: NodeMetadata = {
          uuid: record.get('uuid'),
          file: record.get('file'),
          type: record.get('type'),
          name: record.get('name'),
          startLine: this.toNumber(record.get('startLine')),
          endLine: this.toNumber(record.get('endLine')),
          contentHash: record.get('contentHash'),
          embedding_name: this.toArray(record.get('embedding_name')),
          embedding_content: this.toArray(record.get('embedding_content')),
          embedding_description: this.toArray(record.get('embedding_description')),
          embedding_name_hash: record.get('embedding_name_hash'),
          embedding_content_hash: record.get('embedding_content_hash'),
          embedding_description_hash: record.get('embedding_description_hash'),
          embedding_provider: record.get('embedding_provider'),
          embedding_model: record.get('embedding_model'),
        };

        // Index by UUID
        captured.byUuid.set(metadata.uuid, metadata);

        // Index by symbol key for UUID reuse during parsing
        const symbolKey = this.buildSymbolKey(metadata);
        const existing = captured.bySymbolKey.get(symbolKey) || [];
        existing.push(metadata);
        captured.bySymbolKey.set(symbolKey, existing);
      }

      if (this.config.verbose) {
        console.log(`   🔒 Captured metadata for ${captured.byUuid.size} nodes from ${files.length} files`);
        this.logCaptureStats(captured);
      }

      return captured;
    } finally {
      await session.close();
    }
  }

  /**
   * Restore metadata AFTER new nodes are created
   *
   * This method matches new nodes by UUID and restores:
   * - Embeddings (if content hash matches and provider is compatible)
   * - Embedding hashes
   * - Provider/model info
   *
   * @param captured - Previously captured metadata
   * @returns Statistics about what was restored
   */
  async restoreMetadata(captured: CapturedMetadata): Promise<RestoreResult> {
    const session = this.driver.session();

    try {
      const result: RestoreResult = {
        embeddingsRestored: 0,
        embeddingsSkipped: 0,
        providerMismatch: 0,
        matchedUuids: [],
        unmatchedUuids: [],
      };

      if (captured.byUuid.size === 0) {
        return result;
      }

      // Group captured metadata by node type for efficient batch updates
      const byType = new Map<string, NodeMetadata[]>();
      for (const metadata of captured.byUuid.values()) {
        const existing = byType.get(metadata.type) || [];
        existing.push(metadata);
        byType.set(metadata.type, existing);
      }

      // Process each node type
      for (const [type, metadataList] of byType) {
        const restoreData: Array<{
          uuid: string;
          embedding_name: number[] | null;
          embedding_content: number[] | null;
          embedding_description: number[] | null;
          embedding_name_hash: string | null;
          embedding_content_hash: string | null;
          embedding_description_hash: string | null;
          embedding_provider: string | null;
          embedding_model: string | null;
        }> = [];

        for (const metadata of metadataList) {
          // Check if we should restore based on provider compatibility
          const shouldRestore = this.shouldRestoreEmbeddings(metadata, captured);

          if (shouldRestore) {
            // Only restore if there's something to restore
            if (this.hasEmbeddingData(metadata)) {
              restoreData.push({
                uuid: metadata.uuid,
                embedding_name: metadata.embedding_name || null,
                embedding_content: metadata.embedding_content || null,
                embedding_description: metadata.embedding_description || null,
                embedding_name_hash: metadata.embedding_name_hash || null,
                embedding_content_hash: metadata.embedding_content_hash || null,
                embedding_description_hash: metadata.embedding_description_hash || null,
                embedding_provider: metadata.embedding_provider || null,
                embedding_model: metadata.embedding_model || null,
              });
              result.matchedUuids.push(metadata.uuid);
            }
          } else {
            result.providerMismatch++;
          }
        }

        if (restoreData.length > 0) {
          // Batch restore for this type
          // Use COALESCE to not overwrite if node already has embedding
          // (in case parser regenerated something)
          await session.run(
            `
            UNWIND $data AS d
            MATCH (n:${type} {uuid: d.uuid})
            SET n.embedding_name = COALESCE(n.embedding_name, d.embedding_name),
                n.embedding_content = COALESCE(n.embedding_content, d.embedding_content),
                n.embedding_description = COALESCE(n.embedding_description, d.embedding_description),
                n.embedding_name_hash = COALESCE(n.embedding_name_hash, d.embedding_name_hash),
                n.embedding_content_hash = COALESCE(n.embedding_content_hash, d.embedding_content_hash),
                n.embedding_description_hash = COALESCE(n.embedding_description_hash, d.embedding_description_hash),
                n.embedding_provider = COALESCE(n.embedding_provider, d.embedding_provider),
                n.embedding_model = COALESCE(n.embedding_model, d.embedding_model)
            `,
            { data: restoreData }
          );

          result.embeddingsRestored += restoreData.length;

          if (this.config.verbose) {
            console.log(`   🔄 Restored embeddings for ${restoreData.length} ${type} nodes`);
          }
        }
      }

      // Find UUIDs that weren't matched (truly new nodes)
      const allCapturedUuids = new Set(captured.byUuid.keys());
      for (const uuid of result.matchedUuids) {
        allCapturedUuids.delete(uuid);
      }
      result.unmatchedUuids = Array.from(allCapturedUuids);

      if (this.config.verbose) {
        console.log(`   ✅ Metadata restore complete: ${result.embeddingsRestored} restored, ${result.providerMismatch} provider mismatch, ${result.unmatchedUuids.length} unmatched`);
      }

      return result;
    } finally {
      await session.close();
    }
  }

  /**
   * Build a UUID mapping for parsers to reuse existing UUIDs
   *
   * @param captured - Previously captured metadata
   * @returns Mapping from symbol key to UUID candidates
   */
  getUuidMapping(captured: CapturedMetadata): UuidMapping {
    const mapping: UuidMapping = new Map();

    for (const [symbolKey, metadataList] of captured.bySymbolKey) {
      const entries: UuidEntry[] = metadataList.map(m => ({
        uuid: m.uuid,
        file: m.file,
        type: m.type,
      }));
      mapping.set(symbolKey, entries);
    }

    return mapping;
  }

  /**
   * Check if a node's embeddings should be restored
   * Based on provider compatibility
   */
  private shouldRestoreEmbeddings(
    metadata: NodeMetadata,
    captured: CapturedMetadata
  ): boolean {
    // If no provider mismatch checking, always restore
    if (!this.config.skipOnProviderMismatch) {
      return true;
    }

    // If the node has no provider info, restore (legacy data)
    if (!metadata.embedding_provider) {
      return true;
    }

    // If we don't know the current provider, restore
    if (!captured.currentProvider) {
      return true;
    }

    // Check if provider matches
    if (metadata.embedding_provider !== captured.currentProvider) {
      if (this.config.verbose) {
        console.log(`   ⚠️ Provider mismatch for ${metadata.uuid}: ${metadata.embedding_provider} != ${captured.currentProvider}`);
      }
      return false;
    }

    return true;
  }

  /**
   * Check if metadata has any embedding data worth restoring
   */
  private hasEmbeddingData(metadata: NodeMetadata): boolean {
    return !!(
      metadata.embedding_name ||
      metadata.embedding_content ||
      metadata.embedding_description ||
      metadata.embedding_name_hash ||
      metadata.embedding_content_hash ||
      metadata.embedding_description_hash ||
      metadata.embedding_provider ||
      metadata.embedding_model
    );
  }

  /**
   * Build a symbol key for UUID reuse
   * Format: file:name or file:name:startLine for ambiguous cases
   */
  private buildSymbolKey(metadata: NodeMetadata): string {
    if (metadata.name) {
      // For named symbols, use file:name
      return `${metadata.file}:${metadata.name}`;
    } else if (metadata.startLine !== undefined) {
      // For unnamed symbols (anonymous functions, etc.), use position
      return `${metadata.file}:_:${metadata.startLine}`;
    } else {
      // Fallback to UUID (won't match new nodes)
      return `${metadata.file}:${metadata.uuid}`;
    }
  }

  /**
   * Get the file field name for a node type
   */
  private getFileFieldForType(type: string): string {
    switch (type) {
      case 'Scope':
        return 'file';
      case 'MarkdownSection':
      case 'CodeBlock':
        return 'file';
      case 'WebPage':
        return 'url';
      case 'DocumentFile':
      case 'ImageFile':
      case 'ThreeDFile':
      case 'DataFile':
        return 'absolutePath';
      default:
        return 'file';
    }
  }

  /**
   * Convert Neo4j integer to number
   */
  private toNumber(value: any): number | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number') return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    return undefined;
  }

  /**
   * Convert Neo4j list to array
   */
  private toArray(value: any): number[] | undefined {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) return value;
    return undefined;
  }

  /**
   * Log capture statistics
   */
  private logCaptureStats(captured: CapturedMetadata): void {
    const stats = new Map<string, { total: number; withEmbeddings: number }>();

    for (const metadata of captured.byUuid.values()) {
      const existing = stats.get(metadata.type) || { total: 0, withEmbeddings: 0 };
      existing.total++;
      if (this.hasEmbeddingData(metadata)) {
        existing.withEmbeddings++;
      }
      stats.set(metadata.type, existing);
    }

    for (const [type, { total, withEmbeddings }] of stats) {
      console.log(`      ${type}: ${total} nodes (${withEmbeddings} with embeddings)`);
    }
  }
}
