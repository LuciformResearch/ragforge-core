/**
 * Embedding Service
 *
 * Reusable service for generating and caching embeddings.
 * Supports MULTIPLE embeddings per node:
 * - embedding_name: for searching by file names, function signatures
 * - embedding_content: for searching by actual content/source code
 * - embedding_description: for searching by docstrings, descriptions
 *
 * Used by:
 * - BrainManager.quickIngest (initial ingestion)
 * - IngestionQueue.afterIngestion (file watcher)
 * - MediaAnalyzer (image/3D descriptions)
 *
 * @since 2025-12-07 - Multi-embedding support added
 */

import * as crypto from 'crypto';
import neo4j from 'neo4j-driver';
import type { Neo4jClient } from '../runtime/client/neo4j-client.js';
import { GeminiEmbeddingProvider, type EmbeddingProviderInterface } from '../runtime/embedding/embedding-provider.js';
import { OllamaEmbeddingProvider } from '../runtime/embedding/ollama-embedding-provider.js';
import { chunkText, needsChunking, type TextChunk } from '../runtime/embedding/text-chunker.js';
import { getRecordEmbeddingExtractors } from '../utils/node-schema.js';
import {
  NodeStateMachine,
  STATE_PROPERTIES as P,
  getRecordExtractors,
  areParsersRegistered,
} from '../ingestion/index.js';

/**
 * Threshold for chunking large content (in characters)
 * Content larger than this will be split into overlapping chunks
 */
const CHUNKING_THRESHOLD = 3000;

/**
 * Chunk size for embeddings (target size per chunk)
 */
const EMBEDDING_CHUNK_SIZE = 2000;

/**
 * Overlap between chunks for context continuity
 */
const EMBEDDING_CHUNK_OVERLAP = 200;

/**
 * Named embedding types for semantic search
 */
export type EmbeddingType = 'name' | 'content' | 'description' | 'all';

/**
 * Configuration for a single embedding field
 */
export interface EmbeddingFieldConfig {
  /** Embedding property name (e.g., 'embedding_name', 'embedding_content') */
  propertyName: string;
  /** Hash property for this embedding (e.g., 'embedding_name_hash') */
  hashProperty: string;
  /** Function to extract text from a record for this embedding */
  textExtractor: (record: any) => string;
}

/**
 * Configuration for a node type with multiple embeddings
 */
export interface MultiEmbedNodeTypeConfig {
  /** Label for logging */
  label: string;
  /** Cypher query to fetch nodes (must return uuid and all needed fields) */
  query: string;
  /** Multiple embedding configurations */
  embeddings: EmbeddingFieldConfig[];
  /** Maximum results to process (default: 2000) */
  limit?: number;
}

/**
 * Legacy configuration for a node type (single embedding)
 * @deprecated Use MultiEmbedNodeTypeConfig instead
 */
export interface EmbedNodeTypeConfig {
  /** Label for logging */
  label: string;
  /** Cypher query to fetch nodes (must return uuid, embedding_hash, and text fields) */
  query: string;
  /** Function to extract text from a record */
  textExtractor: (record: any) => string;
  /** Maximum results to process (default: 2000) */
  limit?: number;
}

/**
 * Result of embedding generation
 */
export interface EmbeddingResult {
  /** Total nodes processed */
  totalNodes: number;
  /** Nodes that were embedded (new or changed) */
  embeddedCount: number;
  /** Nodes skipped (cached) */
  skippedCount: number;
  /** Time taken in ms */
  durationMs: number;
}

/**
 * Options for embedding generation
 */
export interface GenerateEmbeddingsOptions {
  /** Project ID to filter nodes */
  projectId: string;
  /** Only embed nodes with embedding_hash mismatch (default: true) */
  incrementalOnly?: boolean;
  /** Node types to embed (default: all standard types) */
  nodeTypes?: EmbedNodeTypeConfig[];
  /** Maximum text length before truncation (default: 4000) */
  maxTextLength?: number;
  /** Batch size for Neo4j updates (default: 50) */
  batchSize?: number;
  /** Verbose logging (default: false) */
  verbose?: boolean;
}

/**
 * Options for multi-embedding generation
 */
export interface GenerateMultiEmbeddingsOptions {
  /** Project ID to filter nodes */
  projectId: string;
  /** Only embed nodes with embedding_hash mismatch (default: true) */
  incrementalOnly?: boolean;
  /** Node types to embed (default: MULTI_EMBED_CONFIGS) */
  nodeTypes?: MultiEmbedNodeTypeConfig[];
  /** Specific embedding types to generate (default: all) */
  embeddingTypes?: ('name' | 'content' | 'description')[];
  /** Maximum text length before truncation (default: 4000) */
  maxTextLength?: number;
  /** Batch size for Neo4j updates (default: 50) */
  batchSize?: number;
  /** Verbose logging (default: false) */
  verbose?: boolean;
}

/**
 * Result of multi-embedding generation
 */
export interface MultiEmbeddingResult {
  /** Total nodes processed */
  totalNodes: number;
  /** Embeddings generated per type */
  embeddedByType: {
    name: number;
    content: number;
    description: number;
  };
  /** Total embeddings generated */
  totalEmbedded: number;
  /** Embeddings skipped (cached) */
  skippedCount: number;
  /** Time taken in ms */
  durationMs: number;
}

/**
 * Represents a single embedding task to be batched
 * Used internally for collecting all tasks before batch embedding
 */
interface EmbeddingTask {
  /** Type of task: 'small' for direct embed, 'chunk' for chunked content */
  type: 'small' | 'chunk';
  /** Node UUID */
  uuid: string;
  /** Text to embed */
  text: string;
  /** Hash of the text for caching */
  hash: string;
  /** Node label (Scope, File, etc.) */
  label: string;
  /** Embedding property name (embedding_name, embedding_content, embedding_description) */
  embeddingProp: string;
  /** Embedding type (name, content, description) */
  embeddingType: 'name' | 'content' | 'description';
  /** For chunks: parent node UUID */
  parentUuid?: string;
  /** For chunks: chunk index */
  chunkIndex?: number;
  /** For chunks: position info */
  startChar?: number;
  endChar?: number;
  startLine?: number;
  endLine?: number;
  /** For chunks: page number from parent (for documents) */
  pageNum?: number | null;
  /** Embedding result (filled after embedding) */
  embedding?: number[];
}

/**
 * Nodes that need their dirty flag cleared after embedding
 */
interface NodeToMarkDone {
  uuid: string;
  label: string;
  /** For chunked nodes: number of chunks created */
  chunkCount?: number;
  /** For chunked nodes: hash of the full content (for incremental skip detection) */
  contentHash?: string;
}

/**
 * Hash content for change detection
 */
export function hashContent(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
}

/**
 * Build embedding field configs.
 *
 * Source of truth:
 * 1. Parser-registry (new system) - if parsers are registered
 * 2. node-schema.ts FIELD_MAPPING (legacy fallback)
 *
 * This ensures gradual migration to the new parser system.
 */
function buildEmbeddingConfigs(label: string, hasDescription: boolean = true): EmbeddingFieldConfig[] {
  // Use parser-registry extractors if parsers are registered
  // Otherwise fall back to legacy node-schema extractors
  const extractors = areParsersRegistered()
    ? getRecordExtractors(label)
    : getRecordEmbeddingExtractors(label);

  const configs: EmbeddingFieldConfig[] = [
    {
      propertyName: 'embedding_name',
      hashProperty: 'embedding_name_hash',
      textExtractor: extractors.name,
    },
  ];

  // Only add content embedding if the mapping returns non-null content
  // (some types like MarkdownDocument, ThreeDFile don't have distinct content)
  configs.push({
    propertyName: 'embedding_content',
    hashProperty: 'embedding_content_hash',
    textExtractor: extractors.content,
  });

  if (hasDescription) {
    configs.push({
      propertyName: 'embedding_description',
      hashProperty: 'embedding_description_hash',
      textExtractor: extractors.description,
    });
  }

  return configs;
}

/**
 * Multi-embedding configurations for all node types
 *
 * Each node type has up to 3 embeddings:
 * - embedding_name: file names, function names, signatures (for "find X")
 * - embedding_content: actual source code, text content (for "code that does X")
 * - embedding_description: docstrings, descriptions, metadata (for "documented as X")
 *
 * Uses FIELD_MAPPING from node-schema.ts as the source of truth for field extraction.
 */
export const MULTI_EMBED_CONFIGS: MultiEmbedNodeTypeConfig[] = [
  {
    label: 'Scope',
    query: `MATCH (s:Scope {projectId: $projectId})
            RETURN s.uuid AS uuid, s.name AS name, s.signature AS signature,
                   s.source AS source, s.docstring AS docstring,
                   s.embedding_name_hash AS embedding_name_hash,
                   s.embedding_content_hash AS embedding_content_hash,
                   s.embedding_description_hash AS embedding_description_hash,
                   s.embedding_provider AS embedding_provider,
                   s.embedding_model AS embedding_model,
                   s.${P.state} AS _state
            ORDER BY s.file, s.startLine`,
    embeddings: buildEmbeddingConfigs('Scope', true),
  },
  {
    label: 'File',
    query: `MATCH (f:File {projectId: $projectId})
            WHERE f.source IS NOT NULL
            RETURN f.uuid AS uuid, f.path AS path, f.name AS name, f.source AS source,
                   f.embedding_name_hash AS embedding_name_hash,
                   f.embedding_content_hash AS embedding_content_hash,
                   f.embedding_provider AS embedding_provider,
                   f.embedding_model AS embedding_model,
                   f.${P.state} AS _state`,
    embeddings: buildEmbeddingConfigs('File', false),
  },
  {
    label: 'MarkdownDocument',
    query: `MATCH (m:MarkdownDocument {projectId: $projectId})
            RETURN m.uuid AS uuid, m.file AS file, m.title AS title,
                   m.frontMatter AS frontMatter,
                   m.embedding_name_hash AS embedding_name_hash,
                   m.embedding_content_hash AS embedding_content_hash,
                   m.embedding_description_hash AS embedding_description_hash,
                   m.embedding_provider AS embedding_provider,
                   m.embedding_model AS embedding_model,
                   m.${P.state} AS _state`,
    embeddings: buildEmbeddingConfigs('MarkdownDocument', true),
  },
  {
    label: 'MarkdownSection',
    query: `MATCH (s:MarkdownSection {projectId: $projectId})
            RETURN s.uuid AS uuid, s.title AS title, s.content AS content, s.ownContent AS ownContent,
                   s.startLine AS startLine, s.endLine AS endLine, s.pageNum AS pageNum,
                   s.embedding_name_hash AS embedding_name_hash,
                   s.embedding_content_hash AS embedding_content_hash,
                   s.embedding_provider AS embedding_provider,
                   s.embedding_model AS embedding_model,
                   s.${P.state} AS _state`,
    embeddings: buildEmbeddingConfigs('MarkdownSection', false),
  },
  {
    label: 'CodeBlock',
    query: `MATCH (c:CodeBlock {projectId: $projectId})
            WHERE c.code IS NOT NULL AND size(c.code) > 10
            RETURN c.uuid AS uuid, c.language AS language, c.code AS code,
                   c.startLine AS startLine, c.endLine AS endLine,
                   c.embedding_name_hash AS embedding_name_hash,
                   c.embedding_content_hash AS embedding_content_hash,
                   c.embedding_provider AS embedding_provider,
                   c.embedding_model AS embedding_model,
                   c.${P.state} AS _state`,
    embeddings: buildEmbeddingConfigs('CodeBlock', false),
  },
  {
    label: 'DataFile',
    query: `MATCH (d:DataFile {projectId: $projectId})
            RETURN d.uuid AS uuid, d.path AS path, d.file AS file,
                   d.rawContent AS rawContent, d.preview AS preview, d.structure AS structure,
                   d.embedding_name_hash AS embedding_name_hash,
                   d.embedding_content_hash AS embedding_content_hash,
                   d.embedding_provider AS embedding_provider,
                   d.embedding_model AS embedding_model,
                   d.${P.state} AS _state`,
    embeddings: buildEmbeddingConfigs('DataFile', false),
  },
  {
    label: 'WebPage',
    query: `MATCH (w:WebPage {projectId: $projectId})
            RETURN w.uuid AS uuid, w.url AS url, w.title AS title, w.textContent AS textContent,
                   w.metaDescription AS metaDescription, w.description AS description,
                   w.embedding_name_hash AS embedding_name_hash,
                   w.embedding_content_hash AS embedding_content_hash,
                   w.embedding_description_hash AS embedding_description_hash,
                   w.embedding_provider AS embedding_provider,
                   w.embedding_model AS embedding_model,
                   w.${P.state} AS _state`,
    embeddings: buildEmbeddingConfigs('WebPage', true),
  },
  {
    label: 'MediaFile',
    query: `MATCH (m:MediaFile {projectId: $projectId})
            WHERE m.textContent IS NOT NULL OR m.description IS NOT NULL
            RETURN m.uuid AS uuid, m.path AS path, m.file AS file,
                   m.textContent AS textContent, m.ocrText AS ocrText, m.description AS description,
                   m.embedding_name_hash AS embedding_name_hash,
                   m.embedding_content_hash AS embedding_content_hash,
                   m.embedding_description_hash AS embedding_description_hash,
                   m.embedding_provider AS embedding_provider,
                   m.embedding_model AS embedding_model,
                   m.${P.state} AS _state`,
    embeddings: buildEmbeddingConfigs('MediaFile', true),
  },
  {
    label: 'ThreeDFile',
    query: `MATCH (t:ThreeDFile {projectId: $projectId})
            WHERE t.textContent IS NOT NULL OR t.description IS NOT NULL
            RETURN t.uuid AS uuid, t.path AS path, t.file AS file,
                   t.textContent AS textContent, t.description AS description,
                   t.embedding_name_hash AS embedding_name_hash,
                   t.embedding_content_hash AS embedding_content_hash,
                   t.embedding_description_hash AS embedding_description_hash,
                   t.embedding_provider AS embedding_provider,
                   t.embedding_model AS embedding_model,
                   t.${P.state} AS _state`,
    embeddings: buildEmbeddingConfigs('ThreeDFile', true),
  },
  {
    label: 'DocumentFile',
    query: `MATCH (d:DocumentFile {projectId: $projectId})
            WHERE d.textContent IS NOT NULL
            RETURN d.uuid AS uuid, d.file AS file, d.path AS path, d.format AS format,
                   d.textContent AS textContent, d.extractedText AS extractedText, d.title AS title,
                   d.embedding_name_hash AS embedding_name_hash,
                   d.embedding_content_hash AS embedding_content_hash,
                   d.embedding_description_hash AS embedding_description_hash,
                   d.embedding_provider AS embedding_provider,
                   d.embedding_model AS embedding_model,
                   d.${P.state} AS _state`,
    embeddings: buildEmbeddingConfigs('DocumentFile', true),
  },
];

/**
 * Legacy: Default node type configurations for embedding (single embedding per node)
 * @deprecated Use MULTI_EMBED_CONFIGS for multi-embedding support
 */
export const DEFAULT_EMBED_CONFIGS: EmbedNodeTypeConfig[] = [
  {
    label: 'Scope',
    query: `MATCH (s:Scope {projectId: $projectId})
            RETURN s.uuid AS uuid, s.name AS name, s.signature AS signature,
                   s.source AS source, s.docstring AS docstring, s.embedding_hash AS embedding_hash
            LIMIT $limit`,
    textExtractor: (r) => {
      const parts: string[] = [];
      const sig = r.get('signature');
      const doc = r.get('docstring');
      const src = r.get('source');
      if (sig) parts.push(`Signature: ${sig}`);
      if (doc) parts.push(`Docstring: ${doc}`);
      if (src) parts.push(`Source:\n${src}`);
      return parts.join('\n\n') || r.get('name') || '';
    },
    limit: 2000,
  },
  {
    label: 'File',
    query: `MATCH (f:File {projectId: $projectId})
            WHERE f.source IS NOT NULL AND size(f.source) < 10000
            RETURN f.uuid AS uuid, f.path AS path, f.source AS source, f.embedding_hash AS embedding_hash
            LIMIT $limit`,
    textExtractor: (r) => {
      const path = r.get('path') || '';
      const source = r.get('source') || '';
      return `File: ${path}\n\n${source}`;
    },
    limit: 500,
  },
  {
    label: 'MarkdownDocument',
    query: `MATCH (m:MarkdownDocument {projectId: $projectId})
            RETURN m.uuid AS uuid, m.path AS path, m.rawText AS rawText, m.title AS title, m.embedding_hash AS embedding_hash
            LIMIT $limit`,
    textExtractor: (r) => {
      const title = r.get('title') || '';
      const text = r.get('rawText') || '';
      return title ? `# ${title}\n\n${text}` : text;
    },
    limit: 500,
  },
  {
    label: 'DataFile',
    query: `MATCH (d:DataFile {projectId: $projectId})
            RETURN d.uuid AS uuid, d.path AS path, d.rawContent AS rawContent, d.embedding_hash AS embedding_hash
            LIMIT $limit`,
    textExtractor: (r) => {
      const path = r.get('path') || '';
      const content = r.get('rawContent') || '';
      return `Data file: ${path}\n\n${content}`;
    },
    limit: 500,
  },
  {
    label: 'WebPage',
    query: `MATCH (w:WebPage {projectId: $projectId})
            RETURN w.uuid AS uuid, w.url AS url, w.title AS title, w.textContent AS textContent, w.embedding_hash AS embedding_hash
            LIMIT $limit`,
    textExtractor: (r) => {
      const title = r.get('title') || '';
      const url = r.get('url') || '';
      const text = r.get('textContent') || '';
      return `${title}\nURL: ${url}\n\n${text}`;
    },
    limit: 500,
  },
  {
    label: 'MediaFile',
    query: `MATCH (m:MediaFile {projectId: $projectId})
            WHERE m.textContent IS NOT NULL OR m.description IS NOT NULL
            RETURN m.uuid AS uuid, m.path AS path,
                   COALESCE(m.textContent, m.description) AS description,
                   m.embedding_hash AS embedding_hash
            LIMIT $limit`,
    textExtractor: (r) => {
      const path = r.get('path') || '';
      const description = r.get('description') || '';
      return `Media: ${path}\n\n${description}`;
    },
    limit: 500,
  },
  {
    label: 'ThreeDFile',
    query: `MATCH (t:ThreeDFile {projectId: $projectId})
            WHERE t.textContent IS NOT NULL OR t.description IS NOT NULL
            RETURN t.uuid AS uuid, t.path AS path,
                   COALESCE(t.textContent, t.description) AS description,
                   t.embedding_hash AS embedding_hash
            LIMIT $limit`,
    textExtractor: (r) => {
      const path = r.get('path') || '';
      const description = r.get('description') || '';
      return `3D Model: ${path}\n\n${description}`;
    },
    limit: 200,
  },
  {
    label: 'DocumentFile',
    query: `MATCH (d:DocumentFile {projectId: $projectId})
            WHERE d.textContent IS NOT NULL
            RETURN d.uuid AS uuid, d.file AS file, d.path AS path, d.format AS format,
                   d.textContent AS textContent, d.embedding_hash AS embedding_hash
            LIMIT $limit`,
    textExtractor: (r) => {
      const file = r.get('file') || r.get('path') || '';
      const format = r.get('format') || '';
      const text = r.get('textContent') || '';
      return `Document (${format}): ${file}\n\n${text}`;
    },
    limit: 500,
  },
];

// EmbeddingProviderConfig is imported from types/config.ts (unified config format)
import type { EmbeddingProviderConfig } from '../types/config.js';

// Re-export for convenience
export type { EmbeddingProviderConfig };

/**
 * Embedding Service - generates and caches embeddings for Neo4j nodes
 *
 * Supports multiple embedding providers:
 * - Gemini (cloud, requires API key, best quality)
 * - Ollama (local, free, private)
 */
export class EmbeddingService {
  private embeddingProvider: EmbeddingProviderInterface | null = null;
  private stateMachine: NodeStateMachine | null = null;

  /**
   * Create an EmbeddingService
   *
   * @param neo4jClient - Neo4j client for database operations
   * @param config - Provider configuration (gemini or ollama)
   *
   * Legacy signature still supported:
   * @param neo4jClient - Neo4j client
   * @param geminiApiKey - Gemini API key (creates Gemini provider)
   */
  constructor(
    private neo4jClient: Neo4jClient,
    configOrApiKey?: EmbeddingProviderConfig | string
  ) {
    if (typeof configOrApiKey === 'string') {
      // Legacy: string = Gemini API key
      this.embeddingProvider = new GeminiEmbeddingProvider({
        apiKey: configOrApiKey,
        dimension: 3072,
      });
    } else if (configOrApiKey) {
      // Unified config format from types/config.ts
      const provider = configOrApiKey.provider.toLowerCase();

      if (provider === 'gemini') {
        this.embeddingProvider = new GeminiEmbeddingProvider({
          apiKey: configOrApiKey.api_key!,
          dimension: configOrApiKey.dimensions ?? 3072,
        });
      } else if (provider === 'ollama') {
        this.embeddingProvider = new OllamaEmbeddingProvider({
          baseUrl: configOrApiKey.options?.baseUrl ?? configOrApiKey.options?.base_url,
          model: configOrApiKey.model,
          concurrency: configOrApiKey.options?.concurrency ?? configOrApiKey.options?.batchSize ?? 20,
          timeout: configOrApiKey.options?.timeout,
        });
      }
    }
  }

  /**
   * Set a new embedding provider
   */
  setProvider(provider: EmbeddingProviderInterface): void {
    this.embeddingProvider = provider;
  }

  /**
   * Set the state machine for state-based embedding
   * The service uses _state property to track embedding pipeline progress
   */
  setStateMachine(stateMachine: NodeStateMachine): void {
    this.stateMachine = stateMachine;
  }

  /**
   * Check if state machine is configured
   */
  hasStateMachine(): boolean {
    return this.stateMachine !== null;
  }

  /**
   * Get the current provider info
   */
  getProviderInfo(): { name: string; model: string } | null {
    if (!this.embeddingProvider) return null;
    return {
      name: this.embeddingProvider.getProviderName(),
      model: this.embeddingProvider.getModelName(),
    };
  }

  /**
   * Check if embeddings can be generated
   */
  canGenerateEmbeddings(): boolean {
    return this.embeddingProvider !== null;
  }

  /**
   * Generate embeddings for a project
   */
  async generateEmbeddings(options: GenerateEmbeddingsOptions): Promise<EmbeddingResult> {
    const startTime = Date.now();
    const { projectId, verbose = false } = options;
    const incrementalOnly = options.incrementalOnly ?? true;
    const maxTextLength = options.maxTextLength ?? 4000;
    const batchSize = options.batchSize ?? 500; // Larger batches for Neo4j writes
    const nodeTypes = options.nodeTypes ?? DEFAULT_EMBED_CONFIGS;

    if (!this.embeddingProvider) {
      if (verbose) {
        console.warn('[EmbeddingService] No API key configured, skipping embeddings');
      }
      return {
        totalNodes: 0,
        embeddedCount: 0,
        skippedCount: 0,
        durationMs: Date.now() - startTime,
      };
    }

    if (verbose) {
      console.log(`[EmbeddingService] Generating embeddings for project: ${projectId}`);
      console.log(`[EmbeddingService]   Using ${this.embeddingProvider.getModelName()}`);
    }

    let totalNodes = 0;
    let embeddedCount = 0;
    let skippedCount = 0;

    for (const config of nodeTypes) {
      const result = await this.embedNodeType(config, {
        projectId,
        incrementalOnly,
        maxTextLength,
        batchSize,
        verbose,
      });

      totalNodes += result.totalNodes;
      embeddedCount += result.embeddedCount;
      skippedCount += result.skippedCount;
    }

    const durationMs = Date.now() - startTime;

    if (verbose) {
      console.log(`[EmbeddingService] Complete: ${embeddedCount} embedded, ${skippedCount} cached in ${durationMs}ms`);
    }

    return {
      totalNodes,
      embeddedCount,
      skippedCount,
      durationMs,
    };
  }

  /**
   * Generate embeddings for a specific node type
   */
  private async embedNodeType(
    config: EmbedNodeTypeConfig,
    options: {
      projectId: string;
      incrementalOnly: boolean;
      maxTextLength: number;
      batchSize: number;
      verbose: boolean;
    }
  ): Promise<{ totalNodes: number; embeddedCount: number; skippedCount: number }> {
    const { projectId, incrementalOnly, maxTextLength, batchSize, verbose } = options;
    const limit = neo4j.int(config.limit ?? 2000);

    // Fetch nodes
    const result = await this.neo4jClient.run(config.query, { projectId, limit });

    // Extract text and compute hash for each node
    const nodes = result.records.map(r => {
      const text = config.textExtractor(r);
      const truncated = text.length > maxTextLength ? text.substring(0, maxTextLength) + '...' : text;
      return {
        uuid: r.get('uuid'),
        text: truncated,
        newHash: hashContent(truncated),
        existingHash: r.get('embedding_hash') || null,
      };
    }).filter(n => n.text && n.text.length > 10); // Skip empty/tiny texts

    if (nodes.length === 0) {
      return { totalNodes: 0, embeddedCount: 0, skippedCount: 0 };
    }

    // Filter to only nodes that need embedding (no hash or hash changed)
    const nodesToEmbed = incrementalOnly
      ? nodes.filter(n => n.existingHash !== n.newHash)
      : nodes;

    const skipped = nodes.length - nodesToEmbed.length;

    if (nodesToEmbed.length === 0) {
      if (verbose) {
        console.log(`[EmbeddingService]   → ${config.label}: ${nodes.length} nodes (all cached, skipped)`);
      }
      return { totalNodes: nodes.length, embeddedCount: 0, skippedCount: skipped };
    }

    if (verbose) {
      console.log(`[EmbeddingService]   → ${config.label}: ${nodesToEmbed.length} to embed (${skipped} cached)`);
    }

    // Generate embeddings only for nodes that need it
    const embeddings = await this.embeddingProvider!.embed(nodesToEmbed.map(n => n.text));

    // Update nodes in batches with embedding + hash
    for (let i = 0; i < nodesToEmbed.length; i += batchSize) {
      const batch = nodesToEmbed.slice(i, i + batchSize).map((n, idx) => ({
        uuid: n.uuid,
        embedding: embeddings[i + idx],
        embedding_hash: n.newHash,
      }));

      await this.neo4jClient.run(
        `UNWIND $batch AS item
         MATCH (n {uuid: item.uuid})
         SET n.embedding = item.embedding, n.embedding_hash = item.embedding_hash`,
        { batch }
      );
    }

    return {
      totalNodes: nodes.length,
      embeddedCount: nodesToEmbed.length,
      skippedCount: skipped,
    };
  }

  /**
   * Generate embedding for a single text and store it on a node
   */
  async embedSingleNode(uuid: string, text: string): Promise<boolean> {
    if (!this.embeddingProvider) {
      return false;
    }

    const truncated = text.length > 4000 ? text.substring(0, 4000) + '...' : text;
    const hash = hashContent(truncated);

    const embedding = await this.embeddingProvider.embedSingle(truncated);

    await this.neo4jClient.run(
      `MATCH (n {uuid: $uuid})
       SET n.embedding = $embedding, n.embedding_hash = $hash`,
      { uuid, embedding, hash }
    );

    return true;
  }

  // ============================================
  // Multi-Embedding Support
  // ============================================

  /**
   * Generate MULTIPLE embeddings per node for targeted semantic search.
   *
   * OPTIMIZED: Collects ALL tasks from ALL node types first, then batches
   * embedding calls together (500 at a time) for maximum API efficiency.
   * TEST WATCHER: This comment was added to test incremental ingestion.
   *
   * Creates separate embeddings for:
   * - embedding_name: file/function names, signatures (for "find X")
   * - embedding_content: actual code/text content (for "code that does X")
   * - embedding_description: docstrings, descriptions (for "documented as X")
   *
   * This allows the agent to target searches more precisely.
   */
  async generateMultiEmbeddings(options: GenerateMultiEmbeddingsOptions): Promise<MultiEmbeddingResult> {
    const startTime = Date.now();
    const { projectId, verbose = false } = options;
    const incrementalOnly = options.incrementalOnly ?? true;
    const maxTextLength = options.maxTextLength ?? 4000;
    const batchSize = options.batchSize ?? 500;
    const nodeTypes = options.nodeTypes ?? MULTI_EMBED_CONFIGS;
    const embeddingTypes = options.embeddingTypes ?? ['name', 'content', 'description'];

    if (!this.embeddingProvider) {
      if (verbose) {
        console.warn('[EmbeddingService] No API key configured, skipping embeddings');
      }
      return {
        totalNodes: 0,
        embeddedByType: { name: 0, content: 0, description: 0 },
        totalEmbedded: 0,
        skippedCount: 0,
        durationMs: Date.now() - startTime,
      };
    }

    if (verbose) {
      console.log(`[EmbeddingService] Generating multi-embeddings for project: ${projectId}`);
      console.log(`[EmbeddingService]   Using ${this.embeddingProvider.getModelName()}`);
      console.log(`[EmbeddingService]   Embedding types: ${embeddingTypes.join(', ')}`);
    }

    // ========================================
    // PHASE 1: Collect ALL embedding tasks
    // ========================================
    const allTasks: EmbeddingTask[] = [];
    const nodesToMarkDone: NodeToMarkDone[] = [];
    const chunkedNodeUuids: Set<string> = new Set(); // Track nodes that use chunks
    let totalNodes = 0;
    let skippedCount = 0;
    const embeddedByType = { name: 0, content: 0, description: 0 };

    if (verbose) {
      console.log(`[EmbeddingService] Phase 1: Collecting tasks from ${nodeTypes.length} node types...`);
    }

    for (const config of nodeTypes) {
      const collected = await this.collectEmbeddingTasks(config, {
        projectId,
        incrementalOnly,
        maxTextLength,
        embeddingTypes,
        verbose,
      });

      totalNodes += collected.totalNodes;
      skippedCount += collected.skippedCount;
      allTasks.push(...collected.tasks);
      nodesToMarkDone.push(...collected.nodesToMarkDone);
      collected.chunkedNodeUuids.forEach(uuid => chunkedNodeUuids.add(uuid));
    }

    if (allTasks.length === 0) {
      if (verbose) {
        console.log(`[EmbeddingService] No tasks to process (all cached)`);
      }
      return {
        totalNodes,
        embeddedByType,
        totalEmbedded: 0,
        skippedCount,
        durationMs: Date.now() - startTime,
      };
    }

    if (verbose) {
      console.log(`[EmbeddingService]   Collected ${allTasks.length} tasks (${allTasks.filter(t => t.type === 'small').length} small, ${allTasks.filter(t => t.type === 'chunk').length} chunks)`);
    }

    // ========================================
    // PHASE 2: Delete existing chunks for nodes that will be re-chunked
    // ========================================
    if (chunkedNodeUuids.size > 0) {
      if (verbose) {
        console.log(`[EmbeddingService] Phase 2: Deleting existing chunks for ${chunkedNodeUuids.size} nodes...`);
      }
      // Group by label for efficient deletion
      const labelToUuids = new Map<string, string[]>();
      for (const task of allTasks) {
        if (task.type === 'chunk' && task.parentUuid) {
          const label = task.label;
          if (!labelToUuids.has(label)) {
            labelToUuids.set(label, []);
          }
          const uuids = labelToUuids.get(label)!;
          if (!uuids.includes(task.parentUuid)) {
            uuids.push(task.parentUuid);
          }
        }
      }
      for (const [label, uuids] of labelToUuids) {
        await this.neo4jClient.run(
          `MATCH (n:${label})-[:HAS_EMBEDDING_CHUNK]->(c:EmbeddingChunk)
           WHERE n.uuid IN $uuids
           DETACH DELETE c`,
          { uuids }
        );
      }
    }

    // ========================================
    // PHASE 3: Batch embed ALL tasks together
    // ========================================
    const totalTasks = allTasks.length;
    const totalBatches = Math.ceil(totalTasks / batchSize);
    let processedCount = 0;

    console.log(`[Embedding] Starting: ${totalTasks} embeddings to generate (${totalBatches} batches of ${batchSize})`);

    for (let i = 0; i < allTasks.length; i += batchSize) {
      const batch = allTasks.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const progressPct = Math.round((i / totalTasks) * 100);

      console.log(`[Embedding] Batch ${batchNum}/${totalBatches} (${progressPct}% done, ${processedCount}/${totalTasks} embeddings)`);

      // Generate embeddings for this batch
      const texts = batch.map(t => t.text);
      const embeddings = await this.embeddingProvider!.embed(texts);

      processedCount += batch.length;

      // Store embeddings on tasks
      for (let j = 0; j < batch.length; j++) {
        batch[j].embedding = embeddings[j];
      }

      // ========================================
      // PHASE 4: Save this batch to Neo4j and mark nodes done
      // ========================================
      // Group tasks by (label, embeddingProp, type) for efficient Cypher
      const smallTasksByKey = new Map<string, EmbeddingTask[]>();
      const chunkTasksByLabel = new Map<string, EmbeddingTask[]>();

      for (const task of batch) {
        if (task.type === 'small') {
          const key = `${task.label}:${task.embeddingProp}`;
          if (!smallTasksByKey.has(key)) {
            smallTasksByKey.set(key, []);
          }
          smallTasksByKey.get(key)!.push(task);
        } else {
          // Chunks go into EmbeddingChunk nodes
          if (!chunkTasksByLabel.has(task.label)) {
            chunkTasksByLabel.set(task.label, []);
          }
          chunkTasksByLabel.get(task.label)!.push(task);
        }
      }

      // Save small node embeddings
      const providerName = this.embeddingProvider!.getProviderName();
      const modelName = this.embeddingProvider!.getModelName();

      for (const [key, tasks] of smallTasksByKey) {
        const [label, embeddingProp] = key.split(':');
        const saveData = tasks.map(t => ({
          uuid: t.uuid,
          embedding: t.embedding,
          hash: t.hash,
          provider: providerName,
          model: modelName,
        }));

        const cypher = this.buildEmbeddingSaveCypher(embeddingProp, label);
        await this.neo4jClient.run(cypher, { batch: saveData });

        // Count by type
        const embType = tasks[0].embeddingType;
        embeddedByType[embType] += tasks.length;
      }

      // Save chunk embeddings
      for (const [label, tasks] of chunkTasksByLabel) {
        const chunkData = tasks.map(t => ({
          uuid: `${t.parentUuid}_chunk_${t.chunkIndex}`,
          parentUuid: t.parentUuid,
          projectId,
          chunkIndex: t.chunkIndex,
          text: t.text,
          startChar: t.startChar,
          endChar: t.endChar,
          startLine: t.startLine,
          endLine: t.endLine,
          pageNum: t.pageNum,
          embedding: t.embedding,
          hash: t.hash,
          provider: providerName,
          model: modelName,
        }));

        await this.neo4jClient.run(
          `UNWIND $chunks AS chunk
           MATCH (parent:${label} {uuid: chunk.parentUuid})
           CREATE (c:EmbeddingChunk {
             uuid: chunk.uuid,
             projectId: chunk.projectId,
             parentUuid: chunk.parentUuid,
             parentLabel: $parentLabel,
             chunkIndex: chunk.chunkIndex,
             text: chunk.text,
             startChar: chunk.startChar,
             endChar: chunk.endChar,
             startLine: chunk.startLine,
             endLine: chunk.endLine,
             pageNum: chunk.pageNum,
             embedding_content: chunk.embedding,
             embedding_content_hash: chunk.hash,
             embedding_provider: chunk.provider,
             embedding_model: chunk.model,
             ${P.state}: 'ready',
             ${P.stateChangedAt}: datetime(),
             ${P.embeddedAt}: datetime(),
             ${P.embeddingProvider}: chunk.provider,
             ${P.embeddingModel}: chunk.model
           })
           CREATE (parent)-[:HAS_EMBEDDING_CHUNK]->(c)`,
          { chunks: chunkData, parentLabel: label }
        );

        embeddedByType.content += tasks.length;
      }

      // Mark nodes in this batch as done (transition to 'ready' state)
      // Collect unique nodes that were in this batch
      const processedUuids = new Set<string>();
      for (const task of batch) {
        const uuid = task.type === 'chunk' ? task.parentUuid! : task.uuid;
        processedUuids.add(uuid);
      }

      // Find which nodesToMarkDone were processed in this batch and mark them
      const nodesInThisBatch = nodesToMarkDone.filter(n => processedUuids.has(n.uuid));

      // Group by label for efficient updates
      const markDoneByLabel = new Map<string, NodeToMarkDone[]>();
      for (const node of nodesInThisBatch) {
        if (!markDoneByLabel.has(node.label)) {
          markDoneByLabel.set(node.label, []);
        }
        markDoneByLabel.get(node.label)!.push(node);
      }

      for (const [label, nodes] of markDoneByLabel) {
        // Separate chunked nodes from regular nodes
        const chunkedNodes = nodes.filter(n => n.chunkCount !== undefined);
        const regularNodes = nodes.filter(n => n.chunkCount === undefined);

        if (regularNodes.length > 0) {
          await this.neo4jClient.run(
            `UNWIND $uuids AS uuid
             MATCH (n:${label} {uuid: uuid})
             SET n.${P.state} = 'ready',
                 n.${P.stateChangedAt} = datetime(),
                 n.${P.embeddedAt} = datetime()`,
            { uuids: regularNodes.map(n => n.uuid) }
          );
        }

        if (chunkedNodes.length > 0) {
          const chunkData = chunkedNodes.map(n => ({
            uuid: n.uuid,
            chunkCount: neo4j.int(n.chunkCount!),
            contentHash: n.contentHash || null,
          }));
          await this.neo4jClient.run(
            `UNWIND $nodes AS node
             MATCH (n:${label} {uuid: node.uuid})
             SET n.usesChunks = true,
                 n.chunkCount = node.chunkCount,
                 n.embedding_content_hash = node.contentHash,
                 n.${P.state} = 'ready',
                 n.${P.stateChangedAt} = datetime(),
                 n.${P.embeddedAt} = datetime()`,
            { nodes: chunkData }
          );
        }
      }

      // Remove marked nodes from the list to avoid re-marking
      for (const uuid of processedUuids) {
        const idx = nodesToMarkDone.findIndex(n => n.uuid === uuid);
        if (idx !== -1) {
          nodesToMarkDone.splice(idx, 1);
        }
      }

      const batchProgressPct = Math.round((processedCount / totalTasks) * 100);
      console.log(`[Embedding] ✓ Batch ${batchNum}/${totalBatches} complete (${batchProgressPct}%, ${processedCount}/${totalTasks} done)`);
    }

    const durationMs = Date.now() - startTime;
    const totalEmbedded = embeddedByType.name + embeddedByType.content + embeddedByType.description;
    const embedsPerSec = Math.round(totalEmbedded / (durationMs / 1000));

    console.log(`[Embedding] ✓ Complete: ${totalEmbedded} embeddings in ${Math.round(durationMs / 1000)}s (${embedsPerSec}/s)`);
    console.log(`[Embedding]   Breakdown: name=${embeddedByType.name}, content=${embeddedByType.content}, description=${embeddedByType.description}`);

    return {
      totalNodes,
      embeddedByType,
      totalEmbedded,
      skippedCount,
      durationMs,
    };
  }

  /**
   * Wrap a query with state-based filtering
   * Only fetches nodes in 'linked' state (ready for embedding)
   */
  private wrapQueryWithStateFilter(query: string): string {
    // Find the label from the query (e.g., "MATCH (s:Scope" -> "s")
    const matchRegex = /MATCH\s*\((\w+):(\w+)/i;
    const match = query.match(matchRegex);
    if (!match) {
      return query; // Can't parse, return as-is
    }

    const varName = match[1]; // e.g., "s"

    // Check if there's already a WHERE clause
    const hasWhere = /WHERE/i.test(query);

    if (hasWhere) {
      // Add state filter to existing WHERE clause
      return query.replace(
        /WHERE/i,
        `WHERE ${varName}.${P.state} = 'linked' AND`
      );
    } else {
      // Find "RETURN" and insert WHERE before it
      return query.replace(
        /RETURN/i,
        `WHERE ${varName}.${P.state} = 'linked'\n            RETURN`
      );
    }
  }

  /**
   * Collect embedding tasks from a node type (without embedding)
   * Returns tasks ready for batched embedding
   */
  private async collectEmbeddingTasks(
    config: MultiEmbedNodeTypeConfig,
    options: {
      projectId: string;
      incrementalOnly: boolean;
      maxTextLength: number;
      embeddingTypes: ('name' | 'content' | 'description')[];
      verbose: boolean;
    }
  ): Promise<{
    tasks: EmbeddingTask[];
    nodesToMarkDone: NodeToMarkDone[];
    chunkedNodeUuids: Set<string>;
    totalNodes: number;
    skippedCount: number;
  }> {
    const { projectId, incrementalOnly, maxTextLength, embeddingTypes, verbose } = options;

    // Build query parameters
    const params: Record<string, any> = { projectId };
    if (config.limit) {
      params.limit = neo4j.int(config.limit);
    }

    // Apply state filtering - only fetch nodes in 'linked' state
    const query = this.wrapQueryWithStateFilter(config.query);

    // Fetch nodes
    const result = await this.neo4jClient.run(query, params);

    if (result.records.length === 0) {
      return {
        tasks: [],
        nodesToMarkDone: [],
        chunkedNodeUuids: new Set(),
        totalNodes: 0,
        skippedCount: 0,
      };
    }

    const tasks: EmbeddingTask[] = [];
    const nodesToMarkDone: NodeToMarkDone[] = [];
    const chunkedNodeUuids = new Set<string>();
    let skippedCount = 0;
    const label = config.label;

    // Track which nodes need marking done (accumulate across embedding types)
    const nodeNeedsMarking = new Map<string, { needsMarking: boolean; chunkCount?: number; contentHash?: string }>();

    for (const embeddingConfig of config.embeddings) {
      const embeddingType = embeddingConfig.propertyName.replace('embedding_', '') as 'name' | 'content' | 'description';
      if (!embeddingTypes.includes(embeddingType)) {
        continue;
      }

      const isContentEmbedding = embeddingType === 'content';

      // Get current provider info for comparison
      const currentProvider = this.embeddingProvider?.getProviderName() || null;
      const currentModel = this.embeddingProvider?.getModelName() || null;

      // Process each record
      for (const record of result.records) {
        const uuid = record.get('uuid');
        const rawText = embeddingConfig.textExtractor(record);
        const existingHash = incrementalOnly ? (record.get(embeddingConfig.hashProperty) || null) : null;
        const existingProvider = record.get('embedding_provider') || null;
        const existingModel = record.get('embedding_model') || null;
        const nodeState = record.get('_state') || null;

        // Skip empty/tiny texts
        if (!rawText || rawText.length < 5) {
          continue;
        }

        // Check if provider/model changed (requires regeneration even if hash matches)
        // If existingProvider is null but we have an existing hash, it means old embeddings without metadata
        // In that case, we should regenerate to ensure compatibility with current provider
        const hasExistingEmbedding = existingHash !== null;
        const providerMismatch = hasExistingEmbedding && existingProvider !== currentProvider;
        const modelMismatch = hasExistingEmbedding && existingModel !== currentModel;

        // For content: check if needs chunking
        if (isContentEmbedding && needsChunking(rawText, CHUNKING_THRESHOLD)) {
          // Large content - create chunk tasks
          const text = rawText; // Don't truncate for chunking
          const hash = hashContent(text);

          // Check if needs embedding
          // - No hash = new node
          // - Hash mismatch = content changed
          // - Provider/model mismatch = config changed, need to regenerate
          const needsEmbed = incrementalOnly
            ? (existingHash === null || existingHash !== hash || providerMismatch || modelMismatch)
            : true;

          if (!needsEmbed) {
            skippedCount++;
            continue;
          }

          // Log why embedding is needed (for debugging)
          let reason = 'unknown';
          if (existingHash === null) reason = 'no_hash';
          else if (existingHash !== hash) reason = 'hash_mismatch';
          else if (providerMismatch) reason = `provider_changed:${existingProvider}->${currentProvider}`;
          else if (modelMismatch) reason = `model_changed:${existingModel}->${currentModel}`;
          // Safely get node name (some types use 'name', others 'title', others 'path')
          const getField = (field: string) => record.keys?.includes(field) ? record.get(field) : null;
          const nodeName = getField('name') || getField('title') || getField('path') || uuid.substring(0, 8);
          console.log(`[EmbeddingService] Need embed (chunked): ${label}.${embeddingType} "${nodeName}" (${reason})`);

          // Create chunks
          const chunks = chunkText(rawText, {
            chunkSize: EMBEDDING_CHUNK_SIZE,
            overlap: EMBEDDING_CHUNK_OVERLAP,
            strategy: 'paragraph',
          });

          chunkedNodeUuids.add(uuid);

          // Get parent's position info for calculating absolute positions
          const parentStartLine = getField('startLine') as number | null;
          const parentPageNum = getField('pageNum') as number | null;

          for (const chunk of chunks) {
            // Calculate absolute line numbers if parent has startLine
            // chunk.startLine is relative to parent content, so add parent offset
            const absoluteStartLine = parentStartLine != null
              ? parentStartLine + chunk.startLine - 1
              : chunk.startLine;
            const absoluteEndLine = parentStartLine != null
              ? parentStartLine + chunk.endLine - 1
              : chunk.endLine;

            tasks.push({
              type: 'chunk',
              uuid: `${uuid}_chunk_${chunk.index}`,
              parentUuid: uuid,
              text: chunk.text,
              hash: hashContent(chunk.text),
              label,
              embeddingProp: embeddingConfig.propertyName,
              embeddingType,
              chunkIndex: chunk.index,
              startChar: chunk.startChar,
              endChar: chunk.endChar,
              startLine: absoluteStartLine,
              endLine: absoluteEndLine,
              pageNum: parentPageNum,
            });
          }

          // Mark this node for done status with chunk count and content hash
          nodeNeedsMarking.set(uuid, { needsMarking: true, chunkCount: chunks.length, contentHash: hash });
        } else {
          // Small content - direct embed
          const text = rawText.length > maxTextLength
            ? rawText.substring(0, maxTextLength) + '...'
            : rawText;
          const hash = hashContent(text);

          // Check if needs embedding
          // - No hash = new node
          // - Hash mismatch = content changed
          // - Provider/model mismatch = config changed, need to regenerate
          const needsEmbed = incrementalOnly
            ? (existingHash === null || existingHash !== hash || providerMismatch || modelMismatch)
            : true;

          if (!needsEmbed) {
            skippedCount++;
            continue;
          }

          // Log why embedding is needed (for debugging)
          let reason = 'unknown';
          if (existingHash === null) reason = 'no_hash';
          else if (existingHash !== hash) reason = 'hash_mismatch';
          else if (providerMismatch) reason = `provider_changed:${existingProvider}->${currentProvider}`;
          else if (modelMismatch) reason = `model_changed:${existingModel}->${currentModel}`;
          // Safely get node name (some types use 'name', others 'title', others 'path')
          const getField = (field: string) => record.keys?.includes(field) ? record.get(field) : null;
          const nodeName = getField('name') || getField('title') || getField('path') || uuid.substring(0, 8);
          console.log(`[EmbeddingService] Need embed: ${label}.${embeddingType} "${nodeName}" (${reason})`);

          tasks.push({
            type: 'small',
            uuid,
            text,
            hash,
            label,
            embeddingProp: embeddingConfig.propertyName,
            embeddingType,
          });

          // Mark this node for done status (if not already marked with chunks)
          if (!nodeNeedsMarking.has(uuid)) {
            nodeNeedsMarking.set(uuid, { needsMarking: true });
          }
        }
      }
    }

    // Convert nodeNeedsMarking to nodesToMarkDone array
    for (const [uuid, info] of nodeNeedsMarking) {
      if (info.needsMarking) {
        nodesToMarkDone.push({
          uuid,
          label,
          chunkCount: info.chunkCount,
          contentHash: info.contentHash,
        });
      }
    }

    if (verbose && tasks.length > 0) {
      console.log(`[EmbeddingService]   ${label}: ${tasks.length} tasks (${result.records.length} nodes, ${skippedCount} cached)`);
    }

    return {
      tasks,
      nodesToMarkDone,
      chunkedNodeUuids,
      totalNodes: result.records.length,
      skippedCount,
    };
  }
  /**
   * Build Cypher query for saving embeddings to a node
   * Sets embedding data and transitions state to 'ready'
   */
  private buildEmbeddingSaveCypher(embeddingProp: string, label: string): string {
    // Provider metadata
    const providerProps = `, n.embedding_provider = item.provider, n.embedding_model = item.model`;

    // State machine properties - transition to 'ready' state after embedding
    const stateProps = `,
              n.${P.state} = 'ready',
              n.${P.stateChangedAt} = datetime(),
              n.${P.embeddedAt} = datetime(),
              n.${P.embeddingProvider} = item.provider,
              n.${P.embeddingModel} = item.model`;

    if (embeddingProp === 'embedding_name') {
      return `UNWIND $batch AS item
              MATCH (n:${label} {uuid: item.uuid})
              SET n.embedding_name = item.embedding, n.embedding_name_hash = item.hash${providerProps}${stateProps}`;
    } else if (embeddingProp === 'embedding_content') {
      return `UNWIND $batch AS item
              MATCH (n:${label} {uuid: item.uuid})
              SET n.embedding_content = item.embedding, n.embedding_content_hash = item.hash${providerProps}${stateProps}`;
    } else if (embeddingProp === 'embedding_description') {
      return `UNWIND $batch AS item
              MATCH (n:${label} {uuid: item.uuid})
              SET n.embedding_description = item.embedding, n.embedding_description_hash = item.hash${providerProps}${stateProps}`;
    } else {
      // Fallback for legacy 'embedding' property
      return `UNWIND $batch AS item
              MATCH (n:${label} {uuid: item.uuid})
              SET n.embedding = item.embedding, n.embedding_hash = item.hash${providerProps}${stateProps}`;
    }
  }

  /**
   * Get embedding for a query to use in vector search
   */
  async getQueryEmbedding(query: string): Promise<number[] | null> {
    if (!this.embeddingProvider) {
      return null;
    }
    return this.embeddingProvider.embedSingle(query);
  }
}

// ============================================================================
// Standalone utility functions (can be used without EmbeddingService instance)
// ============================================================================

/**
 * Options for ensuring vector indexes
 */
export interface EnsureVectorIndexesOptions {
  /** Vector dimension (1024 for Ollama mxbai, 3072 for Gemini) */
  dimension: number;
  /** Whether to log progress */
  verbose?: boolean;
}

/**
 * Result of ensuring vector indexes
 */
export interface EnsureVectorIndexesResult {
  created: number;
  skipped: number;
  errors: number;
}

/**
 * Ensure vector indexes exist for semantic search.
 *
 * Creates indexes based on MULTI_EMBED_CONFIGS for all node types that support embeddings.
 * This is a standalone function that can be called without a BrainManager instance.
 *
 * @param neo4jClient - Neo4j client to use
 * @param options - Options including dimension
 * @returns Stats about created/skipped indexes
 *
 * @example
 * // For Ollama (1024 dimensions)
 * await ensureVectorIndexes(neo4jClient, { dimension: 1024 });
 *
 * // For Gemini (3072 dimensions)
 * await ensureVectorIndexes(neo4jClient, { dimension: 3072 });
 */
export async function ensureVectorIndexes(
  neo4jClient: Neo4jClient,
  options: EnsureVectorIndexesOptions
): Promise<EnsureVectorIndexesResult> {
  const { dimension, verbose = false } = options;

  if (verbose) {
    console.log(`[EmbeddingService] Ensuring vector indexes (dimension: ${dimension})...`);
  }

  let created = 0;
  let skipped = 0;
  let errors = 0;

  // Create indexes based on actual embedding configurations
  for (const config of MULTI_EMBED_CONFIGS) {
    const label = config.label;

    for (const embeddingConfig of config.embeddings) {
      const embeddingProp = embeddingConfig.propertyName;
      const indexName = `${label.toLowerCase()}_${embeddingProp}_vector`;

      try {
        // Check if index already exists
        const checkResult = await neo4jClient.run(
          `SHOW INDEXES YIELD name WHERE name = $indexName RETURN count(name) as count`,
          { indexName }
        );

        const exists = checkResult.records[0]?.get('count')?.toNumber() > 0;

        if (!exists) {
          const createQuery = `
            CREATE VECTOR INDEX ${indexName} IF NOT EXISTS
            FOR (n:\`${label}\`)
            ON n.\`${embeddingProp}\`
            OPTIONS {
              indexConfig: {
                \`vector.dimensions\`: ${dimension},
                \`vector.similarity_function\`: 'cosine'
              }
            }
          `;

          await neo4jClient.run(createQuery);
          created++;
          if (verbose) {
            console.log(`[EmbeddingService] Created vector index: ${indexName}`);
          }
        } else {
          skipped++;
        }
      } catch (err: any) {
        errors++;
        if (!err.message?.includes('already exists') && !err.message?.includes('does not exist')) {
          if (verbose) {
            console.warn(`[EmbeddingService] Vector index creation warning for ${indexName}: ${err.message}`);
          }
        }
      }
    }
  }

  // Special handling for EmbeddingChunk - embeddings are created at chunk time,
  // but we still need a vector index for semantic search
  const chunkIndexName = 'embeddingchunk_embedding_content_vector';
  try {
    const checkResult = await neo4jClient.run(
      `SHOW INDEXES YIELD name WHERE name = $indexName RETURN count(name) as count`,
      { indexName: chunkIndexName }
    );

    const exists = checkResult.records[0]?.get('count')?.toNumber() > 0;

    if (!exists) {
      const createQuery = `
        CREATE VECTOR INDEX ${chunkIndexName} IF NOT EXISTS
        FOR (n:EmbeddingChunk)
        ON n.embedding_content
        OPTIONS {
          indexConfig: {
            \`vector.dimensions\`: ${dimension},
            \`vector.similarity_function\`: 'cosine'
          }
        }
      `;

      await neo4jClient.run(createQuery);
      created++;
      if (verbose) {
        console.log(`[EmbeddingService] Created vector index: ${chunkIndexName}`);
      }
    } else {
      skipped++;
    }
  } catch (err: any) {
    errors++;
    if (!err.message?.includes('already exists')) {
      if (verbose) {
        console.warn(`[EmbeddingService] Vector index creation warning for ${chunkIndexName}: ${err.message}`);
      }
    }
  }

  if (verbose) {
    console.log(`[EmbeddingService] Vector indexes: ${created} created, ${skipped} already existed, ${errors} errors`);
  }

  return { created, skipped, errors };
}
