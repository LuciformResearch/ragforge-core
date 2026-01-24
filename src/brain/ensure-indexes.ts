/**
 * Centralized Index Management for RagForge
 *
 * This module provides functions to ensure all required Neo4j indexes exist.
 * Indexes are organized by category:
 *
 * 1. Base Indexes - UUID, projectId, absolutePath, state
 * 2. Fulltext Indexes - unified_fulltext for _name, _content, _description
 * 3. Vector Indexes - based on MULTI_EMBED_CONFIGS for semantic search
 * 4. Conversation Indexes - for conversation memory (optional)
 *
 * Usage:
 *   import { ensureAllIndexes } from './ensure-indexes.js';
 *   await ensureAllIndexes(neo4jClient, { dimension: 3072 });
 *
 * For community-docs or other apps with custom indexes:
 *   await ensureBaseIndexes(neo4jClient);
 *   await ensureFulltextIndexes(neo4jClient);
 *   await ensureVectorIndexes(neo4jClient, { dimension: 3072 });
 *   // Then add your own custom indexes
 *
 * @since 2026-01-16
 */

import type { Neo4jClient } from '../runtime/client/neo4j-client.js';
import { MULTI_EMBED_CONFIGS } from './embedding-service.js';

// ============================================
// Types
// ============================================

/**
 * Interface for embedding service dimension detection
 */
export interface EmbeddingDimensionProvider {
  getDimensions(): Promise<number | null>;
}

export interface EnsureIndexesOptions {
  /** Vector embedding dimension (default: 3072 for Gemini) */
  dimension?: number;
  /** Embedding service to auto-detect dimension (takes priority over explicit dimension) */
  embeddingService?: EmbeddingDimensionProvider;
  /** Verbose logging */
  verbose?: boolean;
  /** Skip vector indexes (useful if no embedding service) */
  skipVectorIndexes?: boolean;
  /** Skip conversation indexes */
  skipConversationIndexes?: boolean;
}

export interface IndexStats {
  created: number;
  skipped: number;
  errors: number;
  recreated: number;
}

interface VectorIndexInfo {
  name: string;
  dimension: number;
  property: string;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get info about an existing vector index (dimension, property)
 * Returns null if index doesn't exist
 */
async function getVectorIndexInfo(
  neo4jClient: Neo4jClient,
  indexName: string
): Promise<VectorIndexInfo | null> {
  try {
    const result = await neo4jClient.run(
      `SHOW INDEXES YIELD name, type, options
       WHERE name = $indexName AND type = 'VECTOR'
       RETURN name, options`,
      { indexName }
    );

    if (result.records.length === 0) {
      return null;
    }

    const record = result.records[0];
    const name = record.get('name') as string;
    const options = record.get('options') as Record<string, any>;

    // Extract dimension from options.indexConfig['vector.dimensions']
    const indexConfig = options?.indexConfig || {};
    const dimension =
      indexConfig['vector.dimensions'] ||
      indexConfig['vectorDimensions'] ||
      0;

    return {
      name,
      dimension: typeof dimension === 'object' && 'toNumber' in dimension
        ? dimension.toNumber()
        : Number(dimension),
      property: '', // Not needed for dimension check
    };
  } catch (err) {
    return null;
  }
}

/**
 * Drop a vector index by name
 */
async function dropVectorIndex(
  neo4jClient: Neo4jClient,
  indexName: string,
  verbose: boolean
): Promise<boolean> {
  try {
    await neo4jClient.run(`DROP INDEX ${indexName}`);
    if (verbose) {
      console.log(`[Indexes] Dropped vector index: ${indexName} (dimension mismatch)`);
    }
    return true;
  } catch (err: any) {
    if (verbose) {
      console.warn(`[Indexes] Failed to drop index ${indexName}: ${err.message}`);
    }
    return false;
  }
}

// ============================================
// Node Labels
// ============================================

/**
 * All node labels that should have UUID indexes
 */
export const UUID_INDEXED_LABELS = [
  'Scope',
  'File',
  'Directory',
  'Project',
  'PackageJson',
  'MarkdownDocument',
  'MarkdownSection',
  'CodeBlock',
  'DataFile',
  'DataSection',
  'MediaFile',
  'ImageFile',
  'ThreeDFile',
  'WebPage',
  'DocumentFile',
  'PDFDocument',
  'WordDocument',
  'SpreadsheetDocument',
  'VueSFC',
  'SvelteComponent',
  'Stylesheet',
  'GenericFile',
  'WebDocument',
  'EmbeddingChunk',
  'ExternalLibrary',
  'Entity',
] as const;

/**
 * All node labels that can have content for fulltext search
 */
export const FULLTEXT_LABELS = [
  'Scope',
  'File',
  'DataFile',
  'DocumentFile',
  'PDFDocument',
  'WordDocument',
  'SpreadsheetDocument',
  'MarkdownDocument',
  'MarkdownSection',
  'MediaFile',
  'ImageFile',
  'ThreeDFile',
  'WebPage',
  'CodeBlock',
  'VueSFC',
  'SvelteComponent',
  'Stylesheet',
  'GenericFile',
  'PackageJson',
  'DataSection',
  'WebDocument',
  'Entity',
  'EmbeddingChunk',
] as const;

/**
 * Labels that should have absolutePath indexes
 */
export const ABSOLUTE_PATH_LABELS = [
  'Scope',
  'File',
  'MarkdownDocument',
  'MarkdownSection',
  'DataFile',
  'MediaFile',
  'ImageFile',
  'Stylesheet',
  'WebPage',
] as const;

// ============================================
// Base Indexes
// ============================================

/**
 * Ensure base property indexes exist (UUID, projectId, absolutePath, state)
 * These are essential for all RagForge operations.
 */
export async function ensureBaseIndexes(
  neo4jClient: Neo4jClient,
  options: { verbose?: boolean } = {}
): Promise<IndexStats> {
  const stats: IndexStats = { created: 0, skipped: 0, errors: 0, recreated: 0 };
  const { verbose = false } = options;

  if (verbose) {
    console.log('[Indexes] Ensuring base indexes...');
  }

  const indexQueries: string[] = [];

  // UUID indexes for all node types
  for (const label of UUID_INDEXED_LABELS) {
    indexQueries.push(
      `CREATE INDEX ${label.toLowerCase()}_uuid IF NOT EXISTS FOR (n:${label}) ON (n.uuid)`
    );
  }

  // ProjectId indexes
  indexQueries.push(
    'CREATE INDEX scope_projectid IF NOT EXISTS FOR (n:Scope) ON (n.projectId)',
    'CREATE INDEX file_projectid IF NOT EXISTS FOR (n:File) ON (n.projectId)',
    'CREATE INDEX entity_projectid IF NOT EXISTS FOR (n:Entity) ON (n.projectId)'
  );

  // Entity-specific indexes
  indexQueries.push(
    'CREATE INDEX entity_type IF NOT EXISTS FOR (n:Entity) ON (n.entityType)',
    'CREATE INDEX entity_name IF NOT EXISTS FOR (n:Entity) ON (n._name)'
  );

  // File state index (for state machine)
  indexQueries.push(
    'CREATE INDEX file_state IF NOT EXISTS FOR (n:File) ON (n.state)'
  );

  // AbsolutePath indexes for fast file lookups
  for (const label of ABSOLUTE_PATH_LABELS) {
    indexQueries.push(
      `CREATE INDEX ${label.toLowerCase()}_absolutepath IF NOT EXISTS FOR (n:${label}) ON (n.absolutePath)`
    );
  }

  // Directory path index
  indexQueries.push(
    'CREATE INDEX directory_path IF NOT EXISTS FOR (n:Directory) ON (n.path)'
  );

  // Relationship indexes (Neo4j 5+)
  // Index on RELATED_TO.type for fast relation filtering by predicate
  indexQueries.push(
    'CREATE INDEX related_to_type IF NOT EXISTS FOR ()-[r:RELATED_TO]-() ON (r.type)'
  );

  // Unique constraints for MERGE operations
  // File uniqueness on (absolutePath, projectId) - critical for incremental ingestion
  const constraintQueries: string[] = [
    'CREATE CONSTRAINT file_path_project_unique IF NOT EXISTS FOR (f:File) REQUIRE (f.absolutePath, f.projectId) IS UNIQUE',
  ];

  // Execute constraint queries first
  for (const query of constraintQueries) {
    try {
      await neo4jClient.run(query);
      stats.created++;
    } catch (err: any) {
      if (err.message?.includes('already exists') || err.message?.includes('equivalent')) {
        stats.skipped++;
      } else {
        stats.errors++;
        if (verbose) {
          console.warn(`[Indexes] Constraint warning: ${err.message}`);
        }
      }
    }
  }

  // Execute all index queries
  for (const query of indexQueries) {
    try {
      await neo4jClient.run(query);
      stats.created++;
    } catch (err: any) {
      if (err.message?.includes('already exists') || err.message?.includes('equivalent index')) {
        stats.skipped++;
      } else {
        stats.errors++;
        if (verbose) {
          console.warn(`[Indexes] Warning: ${err.message}`);
        }
      }
    }
  }

  if (verbose) {
    console.log(`[Indexes] Base indexes: ${stats.created} created, ${stats.skipped} skipped, ${stats.errors} errors`);
  }

  return stats;
}

// ============================================
// Fulltext Indexes
// ============================================

/**
 * Ensure fulltext index exists for unified search across all content types.
 * Uses the normalized _name, _content, _description properties.
 * Also creates a dedicated fulltext index on File._rawContent for grep operations.
 */
export async function ensureFulltextIndexes(
  neo4jClient: Neo4jClient,
  options: { verbose?: boolean } = {}
): Promise<IndexStats> {
  const stats: IndexStats = { created: 0, skipped: 0, errors: 0, recreated: 0 };
  const { verbose = false } = options;

  if (verbose) {
    console.log('[Indexes] Ensuring fulltext indexes...');
  }

  // Unified fulltext index on _name, _content, _description
  try {
    const labelsPart = FULLTEXT_LABELS.join('|');
    const query = `CREATE FULLTEXT INDEX unified_fulltext IF NOT EXISTS FOR (n:${labelsPart}) ON EACH [n._name, n._content, n._description]`;

    await neo4jClient.run(query);
    stats.created++;

    if (verbose) {
      console.log('[Indexes] Unified fulltext index ensured');
    }
  } catch (err: any) {
    if (err.message?.includes('already exists') || err.message?.includes('equivalent index')) {
      stats.skipped++;
      if (verbose) {
        console.log('[Indexes] Unified fulltext index already exists');
      }
    } else {
      stats.errors++;
      console.warn(`[Indexes] Fulltext index warning: ${err.message}`);
    }
  }

  // Fulltext index on File._rawContent for grep operations
  try {
    const grepQuery = `CREATE FULLTEXT INDEX file_rawcontent_fulltext IF NOT EXISTS FOR (n:File) ON EACH [n._rawContent]`;

    await neo4jClient.run(grepQuery);
    stats.created++;

    if (verbose) {
      console.log('[Indexes] File _rawContent fulltext index ensured');
    }
  } catch (err: any) {
    if (err.message?.includes('already exists') || err.message?.includes('equivalent index')) {
      stats.skipped++;
      if (verbose) {
        console.log('[Indexes] File _rawContent fulltext index already exists');
      }
    } else {
      stats.errors++;
      console.warn(`[Indexes] File _rawContent fulltext index warning: ${err.message}`);
    }
  }

  return stats;
}

// ============================================
// Vector Indexes
// ============================================

/**
 * Ensure or recreate a single vector index with correct dimensions.
 * Drops and recreates if dimensions don't match.
 */
async function ensureOrRecreateVectorIndex(
  neo4jClient: Neo4jClient,
  indexName: string,
  label: string,
  property: string,
  targetDimension: number,
  verbose: boolean
): Promise<{ action: 'created' | 'recreated' | 'skipped' | 'error' }> {
  try {
    // Check if index exists and get its dimensions
    const existingIndex = await getVectorIndexInfo(neo4jClient, indexName);

    if (existingIndex) {
      // Index exists - check if dimensions match
      if (existingIndex.dimension === targetDimension) {
        // Dimensions match - skip
        return { action: 'skipped' };
      }

      // Dimensions mismatch - drop and recreate
      if (verbose) {
        console.log(
          `[Indexes] Dimension mismatch for ${indexName}: ` +
            `existing=${existingIndex.dimension}, target=${targetDimension}. Recreating...`
        );
      }

      const dropped = await dropVectorIndex(neo4jClient, indexName, verbose);
      if (!dropped) {
        return { action: 'error' };
      }
    }

    // Create the index (new or after drop)
    const createQuery = `
      CREATE VECTOR INDEX ${indexName} IF NOT EXISTS
      FOR (n:\`${label}\`)
      ON n.\`${property}\`
      OPTIONS {
        indexConfig: {
          \`vector.dimensions\`: ${targetDimension},
          \`vector.similarity_function\`: 'cosine'
        }
      }
    `;

    await neo4jClient.run(createQuery);

    if (verbose) {
      const action = existingIndex ? 'Recreated' : 'Created';
      console.log(`[Indexes] ${action} vector index: ${indexName} (dim: ${targetDimension})`);
    }

    return { action: existingIndex ? 'recreated' : 'created' };
  } catch (err: any) {
    if (verbose) {
      console.warn(`[Indexes] Vector index error for ${indexName}: ${err.message}`);
    }
    return { action: 'error' };
  }
}

/**
 * Ensure vector indexes exist for semantic search.
 * Creates indexes based on MULTI_EMBED_CONFIGS.
 * If an index exists with wrong dimensions, it will be dropped and recreated.
 *
 * Dimension resolution order:
 * 1. embeddingService.getDimensions() if provided
 * 2. explicit dimension parameter
 * 3. default 3072 (Gemini)
 */
export async function ensureVectorIndexes(
  neo4jClient: Neo4jClient,
  options: { dimension?: number; embeddingService?: EmbeddingDimensionProvider; verbose?: boolean } = {}
): Promise<IndexStats> {
  const stats: IndexStats = { created: 0, skipped: 0, errors: 0, recreated: 0 };
  const { embeddingService, verbose = false } = options;

  // Resolve dimension: embeddingService > explicit > default
  let dimension = options.dimension ?? 3072;
  if (embeddingService) {
    const detectedDimension = await embeddingService.getDimensions();
    if (detectedDimension) {
      dimension = detectedDimension;
      if (verbose) {
        console.log(`[Indexes] Auto-detected embedding dimension: ${dimension}`);
      }
    }
  }

  if (verbose) {
    console.log(`[Indexes] Ensuring vector indexes (dimension: ${dimension})...`);
  }

  // Create indexes based on MULTI_EMBED_CONFIGS
  for (const config of MULTI_EMBED_CONFIGS) {
    const label = config.label;

    for (const embeddingConfig of config.embeddings) {
      const embeddingProp = embeddingConfig.propertyName;
      const indexName = `${label.toLowerCase()}_${embeddingProp}_vector`;

      const result = await ensureOrRecreateVectorIndex(
        neo4jClient,
        indexName,
        label,
        embeddingProp,
        dimension,
        verbose
      );

      switch (result.action) {
        case 'created':
          stats.created++;
          break;
        case 'recreated':
          stats.recreated++;
          break;
        case 'skipped':
          stats.skipped++;
          break;
        case 'error':
          stats.errors++;
          break;
      }
    }
  }

  // EmbeddingChunk vector index
  const chunkResult = await ensureOrRecreateVectorIndex(
    neo4jClient,
    'embeddingchunk_embedding_content_vector',
    'EmbeddingChunk',
    'embedding_content',
    dimension,
    verbose
  );

  switch (chunkResult.action) {
    case 'created':
      stats.created++;
      break;
    case 'recreated':
      stats.recreated++;
      break;
    case 'skipped':
      stats.skipped++;
      break;
    case 'error':
      stats.errors++;
      break;
  }

  if (verbose) {
    console.log(
      `[Indexes] Vector indexes: ${stats.created} created, ${stats.recreated} recreated, ` +
        `${stats.skipped} skipped, ${stats.errors} errors`
    );
  }

  return stats;
}

// ============================================
// Conversation Indexes
// ============================================

/**
 * Ensure conversation-related indexes exist.
 * For conversation memory feature.
 */
export async function ensureConversationIndexes(
  neo4jClient: Neo4jClient,
  options: { dimension?: number; embeddingService?: EmbeddingDimensionProvider; verbose?: boolean } = {}
): Promise<IndexStats> {
  const stats: IndexStats = { created: 0, skipped: 0, errors: 0, recreated: 0 };
  const { embeddingService, verbose = false } = options;

  // Resolve dimension: embeddingService > explicit > default
  let dimension = options.dimension ?? 3072;
  if (embeddingService) {
    const detectedDimension = await embeddingService.getDimensions();
    if (detectedDimension) {
      dimension = detectedDimension;
    }
  }

  if (verbose) {
    console.log('[Indexes] Ensuring conversation indexes...');
  }

  // Constraints
  const constraints = [
    'CREATE CONSTRAINT conversation_uuid_unique IF NOT EXISTS FOR (c:Conversation) REQUIRE c.uuid IS UNIQUE',
    'CREATE CONSTRAINT message_uuid_unique IF NOT EXISTS FOR (m:Message) REQUIRE m.uuid IS UNIQUE',
    'CREATE CONSTRAINT summary_uuid_unique IF NOT EXISTS FOR (s:Summary) REQUIRE s.uuid IS UNIQUE',
    'CREATE CONSTRAINT tool_call_uuid_unique IF NOT EXISTS FOR (tc:ToolCall) REQUIRE tc.uuid IS UNIQUE',
    'CREATE CONSTRAINT tool_result_uuid_unique IF NOT EXISTS FOR (tr:ToolResult) REQUIRE tr.uuid IS UNIQUE',
  ];

  // Indexes
  const indexes = [
    'CREATE INDEX conversation_created_at IF NOT EXISTS FOR (c:Conversation) ON (c.created_at)',
    'CREATE INDEX conversation_updated_at IF NOT EXISTS FOR (c:Conversation) ON (c.updated_at)',
    'CREATE INDEX conversation_status IF NOT EXISTS FOR (c:Conversation) ON (c.status)',
    'CREATE INDEX message_timestamp IF NOT EXISTS FOR (m:Message) ON (m.timestamp)',
    'CREATE INDEX summary_level IF NOT EXISTS FOR (s:Summary) ON (s.level)',
    'CREATE INDEX summary_created_at IF NOT EXISTS FOR (s:Summary) ON (s.created_at)',
  ];

  // Execute constraints and indexes
  for (const query of [...constraints, ...indexes]) {
    try {
      await neo4jClient.run(query);
      stats.created++;
    } catch (err: any) {
      if (err.message?.includes('already exists') || err.message?.includes('equivalent')) {
        stats.skipped++;
      } else {
        stats.errors++;
        if (verbose) {
          console.warn(`[Indexes] Conversation index warning: ${err.message}`);
        }
      }
    }
  }

  // Vector indexes for conversation embeddings (with dimension check)
  const vectorIndexes = [
    { name: 'message_embedding_index', label: 'Message', prop: 'embedding' },
    { name: 'summary_embedding_index', label: 'Summary', prop: 'embedding' },
  ];

  for (const idx of vectorIndexes) {
    const result = await ensureOrRecreateVectorIndex(
      neo4jClient,
      idx.name,
      idx.label,
      idx.prop,
      dimension,
      verbose
    );

    switch (result.action) {
      case 'created':
        stats.created++;
        break;
      case 'recreated':
        stats.recreated++;
        break;
      case 'skipped':
        stats.skipped++;
        break;
      case 'error':
        stats.errors++;
        break;
    }
  }

  if (verbose) {
    console.log(
      `[Indexes] Conversation indexes: ${stats.created} created, ${stats.recreated} recreated, ` +
        `${stats.skipped} skipped, ${stats.errors} errors`
    );
  }

  return stats;
}

// ============================================
// All-in-One
// ============================================

/**
 * Ensure all RagForge indexes exist.
 * Convenience function that calls all ensure* functions.
 */
export async function ensureAllIndexes(
  neo4jClient: Neo4jClient,
  options: EnsureIndexesOptions = {}
): Promise<IndexStats> {
  const {
    dimension,
    embeddingService,
    verbose = false,
    skipVectorIndexes = false,
    skipConversationIndexes = false,
  } = options;

  const totalStats: IndexStats = { created: 0, skipped: 0, errors: 0, recreated: 0 };

  if (verbose) {
    console.log('[Indexes] Ensuring all indexes...');
  }

  // Base indexes
  const baseStats = await ensureBaseIndexes(neo4jClient, { verbose });
  totalStats.created += baseStats.created;
  totalStats.skipped += baseStats.skipped;
  totalStats.errors += baseStats.errors;
  totalStats.recreated += baseStats.recreated;

  // Fulltext indexes
  const fulltextStats = await ensureFulltextIndexes(neo4jClient, { verbose });
  totalStats.created += fulltextStats.created;
  totalStats.skipped += fulltextStats.skipped;
  totalStats.errors += fulltextStats.errors;
  totalStats.recreated += fulltextStats.recreated;

  // Vector indexes
  if (!skipVectorIndexes) {
    const vectorStats = await ensureVectorIndexes(neo4jClient, { dimension, embeddingService, verbose });
    totalStats.created += vectorStats.created;
    totalStats.skipped += vectorStats.skipped;
    totalStats.errors += vectorStats.errors;
    totalStats.recreated += vectorStats.recreated;
  }

  // Conversation indexes
  if (!skipConversationIndexes) {
    const convStats = await ensureConversationIndexes(neo4jClient, { dimension, embeddingService, verbose });
    totalStats.created += convStats.created;
    totalStats.skipped += convStats.skipped;
    totalStats.errors += convStats.errors;
    totalStats.recreated += convStats.recreated;
  }

  if (verbose) {
    console.log(
      `[Indexes] Total: ${totalStats.created} created, ${totalStats.recreated} recreated, ` +
        `${totalStats.skipped} skipped, ${totalStats.errors} errors`
    );
  }

  return totalStats;
}
