/**
 * Source Adapter Types
 *
 * Types and interfaces for RagForge source adapters that parse various
 * sources (code, documents, APIs, etc.) into Neo4j graph structures.
 */

/**
 * A virtual file that exists only in memory (not on disk).
 * Used for scalable deployments where files are stored in databases/S3.
 *
 * @example
 * const file: VirtualFile = {
 *   path: '/docs/api.ts',
 *   content: Buffer.from('export function hello() {}'),
 * };
 */
export interface VirtualFile {
  /**
   * Virtual path for the file (used for naming and import resolution).
   * Should look like a real path, e.g., '/project/src/utils.ts'
   */
  path: string;

  /**
   * File content as a Buffer or string.
   * Buffer is preferred for binary files (images, PDFs).
   * String is fine for text files (code, markdown).
   */
  content: Buffer | string;

  /**
   * Optional MIME type hint.
   * If not provided, will be inferred from the file extension.
   */
  mimeType?: string;

  /**
   * Optional file metadata (e.g., upload timestamp, original filename).
   */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for a source to be parsed
 *
 * Supports multiple source types with auto-detection:
 * - 'files': Local files (code, documents, media) - parser auto-detected by extension
 * - 'virtual': In-memory files (for scalable/serverless deployments)
 * - 'database': Database (PostgreSQL, Neo4j, MongoDB, etc.)
 * - 'api': REST/GraphQL API
 * - 'web': Web pages (crawler)
 */
export interface SourceConfig {
  /**
   * Type of source to ingest
   * - 'files': Local files on disk
   * - 'virtual': In-memory files (VirtualFile[])
   * Legacy 'code' and 'document' types are mapped to 'files'
   */
  type: 'files' | 'virtual' | 'database' | 'api' | 'web' | 'code' | 'document' | string;

  /**
   * @deprecated Adapter is now auto-detected based on file extension.
   * Kept for backward compatibility but ignored.
   */
  adapter?: string;

  /** Root directory or path to source (for type: 'files') */
  root?: string;

  /** Glob patterns to include (for type: 'files') */
  include?: string[];

  /** Glob patterns to exclude (for type: 'files') */
  exclude?: string[];

  /**
   * Virtual files to parse (for type: 'virtual').
   * Each file contains its path and content in memory.
   * No disk I/O - ideal for serverless/scalable deployments.
   */
  virtualFiles?: VirtualFile[];

  /** Track changes and store diffs in Neo4j (default: false) */
  track_changes?: boolean;

  /** Database connection (for type: 'database') */
  connection?: {
    driver?: string;
    uri: string;
    tables?: string[];
    excludeTables?: string[];
  };

  /** API config (for type: 'api') */
  api?: {
    baseUrl: string;
    endpoints?: string[];
    headers?: Record<string, string>;
    format?: string;
  };

  /** Web crawler config (for type: 'web') */
  web?: {
    url: string;
    depth?: number;
    maxPages?: number;
    includePatterns?: string[];
    excludePatterns?: string[];
  };

  /** Adapter-specific options */
  options?: Record<string, any>;
}

/**
 * A node to be created in Neo4j
 */
export interface ParsedNode {
  /** Node label(s) */
  labels: string[];

  /** Unique identifier for the node */
  id: string;

  /** All properties for this node */
  properties: Record<string, any>;
}

/**
 * A relationship to be created in Neo4j
 */
export interface ParsedRelationship {
  /** Relationship type */
  type: string;

  /** Source node ID */
  from: string;

  /** Target node ID */
  to: string;

  /** Optional relationship properties */
  properties?: Record<string, any>;
}

/**
 * Complete parsed graph structure ready for Neo4j ingestion
 */
export interface ParsedGraph {
  /** All nodes to be created */
  nodes: ParsedNode[];

  /** All relationships to be created */
  relationships: ParsedRelationship[];

  /** Metadata about the parsing operation */
  metadata: {
    /** Total files parsed */
    filesProcessed: number;

    /** Total nodes generated */
    nodesGenerated: number;

    /** Total relationships generated */
    relationshipsGenerated: number;

    /** Time taken to parse (ms) */
    parseTimeMs: number;

    /** Any warnings during parsing */
    warnings?: string[];
  };
}

/**
 * Statistics about incremental update
 */
export interface UpdateStats {
  /** Nodes added */
  nodesAdded: number;

  /** Nodes updated */
  nodesUpdated: number;

  /** Nodes deleted */
  nodesDeleted: number;

  /** Relationships added */
  relationshipsAdded: number;

  /** Relationships deleted */
  relationshipsDeleted: number;
}

/**
 * Result of parsing source with incremental update info
 */
export interface ParseResult {
  /** The parsed graph */
  graph: ParsedGraph;

  /** Incremental update statistics (if applicable) */
  updateStats?: UpdateStats;

  /** Whether this was an incremental update */
  isIncremental: boolean;
}

/**
 * Options for parsing
 */
export interface ParseOptions {
  /** Source configuration */
  source: SourceConfig;

  /** Whether to perform incremental update */
  incremental?: boolean;

  /** Neo4j connection for incremental updates */
  neo4jUri?: string;
  neo4jUser?: string;
  neo4jPassword?: string;
  neo4jDatabase?: string;

  /** Project ID to use for Project node (generated by ProjectRegistry.generateId()) */
  projectId?: string;

  /** Progress callback */
  onProgress?: (progress: ParseProgress) => void;

  /**
   * Files to skip (relative paths).
   * Used for incremental ingestion - skip files that haven't changed.
   */
  skipFiles?: Set<string>;

  /**
   * Pre-existing UUID mapping from database.
   * Used for cross-file import resolution when doing incremental ingestion.
   * Maps symbol name -> array of candidates with uuid, file, and type.
   */
  existingUUIDMapping?: Map<string, Array<{ uuid: string; file: string; type: string }>>;
}

/**
 * Progress information during parsing
 */
export interface ParseProgress {
  /** Current phase */
  phase: 'discovering' | 'parsing' | 'building_graph' | 'complete';

  /** Current file being processed */
  currentFile?: string;

  /** Files processed so far */
  filesProcessed: number;

  /** Total files to process */
  totalFiles: number;

  /** Percentage complete (0-100) */
  percentComplete: number;
}

/**
 * Abstract base class for source adapters
 */
export class SourceAdapter {
  /** Type of source this adapter handles */
  readonly type: string = '';

  /** Name of this specific adapter implementation */
  readonly adapterName: string = '';

  /**
   * Parse source into Neo4j graph structure
   */
  async parse(options: ParseOptions): Promise<ParseResult> {
    throw new Error('Not implemented');
  }

  /**
   * Validate source configuration before parsing
   */
  async validate(config: SourceConfig): Promise<ValidationResult> {
    throw new Error('Not implemented');
  }
}

/**
 * Validation result
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;

  /** Validation errors */
  errors?: string[];

  /** Validation warnings */
  warnings?: string[];
}
