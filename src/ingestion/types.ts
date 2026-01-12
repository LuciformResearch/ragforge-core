/**
 * Ingestion System Types
 *
 * Shared types for the ingestion orchestrator, metadata preserver,
 * orphan watcher, and change queue components.
 */

// Re-export types from adapters that are still relevant
export type {
  ParsedNode,
  ParsedRelationship,
  ParsedGraph,
  ParseProgress,
} from '../runtime/adapters/types.js';

// =============================================================================
// File Change Types
// =============================================================================

/**
 * Represents a file change event
 */
export interface FileChange {
  /** Absolute path to the file */
  path: string;

  /** Type of change */
  changeType: 'created' | 'updated' | 'deleted';

  /** Project ID this file belongs to (undefined = orphan/touched-files) */
  projectId?: string;
}

/**
 * Batch of changes ready for processing
 */
export interface ChangeBatch {
  /** Changes grouped by project */
  byProject: Map<string, FileChange[]>;

  /** Timestamp when batch was created */
  createdAt: Date;

  /** Total number of changes */
  totalChanges: number;
}

// =============================================================================
// Ingestion Options & Stats
// =============================================================================

/**
 * Options for the re-ingestion process
 */
export interface ReingestOptions {
  /** Project ID (optional, auto-detected from file path if not provided) */
  projectId?: string;

  /** Whether to generate embeddings for new/changed content (default: true) */
  generateEmbeddings?: boolean;

  /** Enable verbose logging (default: false) */
  verbose?: boolean;

  /** Track file changes in Neo4j (default: false) */
  trackChanges?: boolean;

  /** Force re-ingestion even if file hash unchanged (default: false) */
  force?: boolean;
}

/**
 * Options for initial project ingestion
 */
export interface ProjectIngestionOptions extends ReingestOptions {
  /** Glob patterns to include */
  include?: string[];

  /** Glob patterns to exclude */
  exclude?: string[];

  /** Custom project name (default: directory name) */
  projectName?: string;

  /** Analyze images with vision AI (default: false) */
  analyzeImages?: boolean;

  /** Analyze 3D models (default: false) */
  analyze3D?: boolean;

  /** Run OCR on scanned documents (default: false) */
  ocrDocuments?: boolean;
}

/**
 * Statistics returned from ingestion operations
 */
export interface IngestionStats {
  /** Files that were unchanged (hash match) */
  unchanged: number;

  /** Files that were updated (content changed) */
  updated: number;

  /** Files that were newly created */
  created: number;

  /** Files that were deleted */
  deleted: number;

  /** Nodes created in Neo4j */
  nodesCreated?: number;

  /** Nodes updated in Neo4j */
  nodesUpdated?: number;

  /** Embeddings generated */
  embeddingsGenerated?: number;

  /** Embeddings preserved (not regenerated) */
  embeddingsPreserved?: number;

  /** Time taken in milliseconds */
  durationMs?: number;

  /** Any warnings during processing */
  warnings?: string[];

  /** Any errors during processing */
  errors?: string[];
}

// =============================================================================
// Metadata Preservation Types
// =============================================================================

/**
 * Metadata captured from a node before deletion/update
 * Used to restore embeddings and UUIDs after re-ingestion
 */
export interface NodeMetadata {
  /** Node UUID */
  uuid: string;

  /** Absolute file path */
  file: string;

  /** Node type (Scope, MarkdownSection, etc.) */
  type: string;

  /** Node name (function name, section heading, etc.) */
  name?: string;

  /** Start line in file */
  startLine?: number;

  /** End line in file */
  endLine?: number;

  /** Content hash (to detect changes) */
  contentHash?: string;

  // --- Embeddings ---

  /** Name embedding vector */
  embedding_name?: number[];

  /** Content embedding vector */
  embedding_content?: number[];

  /** Description embedding vector */
  embedding_description?: number[];

  // --- Embedding Hashes (for change detection) ---

  /** Hash of content used to generate name embedding */
  embedding_name_hash?: string;

  /** Hash of content used to generate content embedding */
  embedding_content_hash?: string;

  /** Hash of content used to generate description embedding */
  embedding_description_hash?: string;

  // --- Provider Info (for compatibility detection) ---

  /** Provider that generated the embeddings */
  embedding_provider?: string;

  /** Model that generated the embeddings */
  embedding_model?: string;
}

/**
 * All metadata captured for a batch of files
 */
export interface CapturedMetadata {
  /** Metadata indexed by node UUID */
  byUuid: Map<string, NodeMetadata>;

  /** Metadata indexed by symbol name (for UUID reuse during parsing) */
  bySymbolKey: Map<string, NodeMetadata[]>;

  /** Provider currently configured in the system */
  currentProvider?: string;

  /** Model currently configured in the system */
  currentModel?: string;

  /** Timestamp when capture was performed */
  capturedAt: Date;
}

/**
 * Entry in the UUID mapping passed to parsers
 * Allows parsers to reuse existing UUIDs for unchanged symbols
 */
export interface UuidEntry {
  /** Existing UUID to reuse */
  uuid: string;

  /** File where this symbol was defined */
  file: string;

  /** Type of symbol (function, class, interface, etc.) */
  type: string;
}

/**
 * Mapping of symbol keys to UUID candidates
 * Key format: `${file}:${name}` or `${file}:${name}:${startLine}`
 */
export type UuidMapping = Map<string, UuidEntry[]>;

// =============================================================================
// Restore Result Types
// =============================================================================

/**
 * Result of restoring metadata after re-ingestion
 */
export interface RestoreResult {
  /** Number of nodes that had embeddings restored */
  embeddingsRestored: number;

  /** Number of nodes that had embeddings skipped (content changed) */
  embeddingsSkipped: number;

  /** Number of nodes that had embeddings skipped (provider mismatch) */
  providerMismatch: number;

  /** UUIDs that were successfully matched */
  matchedUuids: string[];

  /** UUIDs that could not be matched (new nodes) */
  unmatchedUuids: string[];
}

// =============================================================================
// Orphan File Types
// =============================================================================

/**
 * Special project ID for orphan/touched files
 */
export const ORPHAN_PROJECT_ID = 'touched-files';

/**
 * Configuration for orphan file watching
 */
export interface OrphanWatcherConfig {
  /** Maximum number of files to watch (default: 100) */
  maxFiles?: number;

  /** Retention period in days (default: 7) */
  retentionDays?: number;

  /** Whether to persist watch list to Neo4j (default: true) */
  persistToNeo4j?: boolean;

  /** Batch interval in ms (default: 1000) */
  batchIntervalMs?: number;
}

/**
 * Status of an orphan file
 */
export interface OrphanFileStatus {
  /** Absolute path */
  path: string;

  /** Whether currently being watched */
  isWatched: boolean;

  /** When the file was first accessed */
  firstAccessed: Date;

  /** When the file was last accessed */
  lastAccessed: Date;

  /** When watch started (if watching) */
  watchedSince?: Date;
}

// =============================================================================
// Change Queue Types
// =============================================================================

/**
 * Configuration for the change queue
 */
export interface ChangeQueueConfig {
  /** Batch interval in milliseconds (default: 1000) */
  batchIntervalMs?: number;

  /** Maximum batch size before force flush (default: 100) */
  maxBatchSize?: number;

  /** Callback when batch is ready */
  onBatchReady?: (changes: FileChange[]) => Promise<void>;
}

/**
 * Status of the change queue
 */
export interface QueueStatus {
  /** Number of pending changes */
  pendingCount: number;

  /** Is the queue currently processing */
  isProcessing: boolean;

  /** Time until next batch flush (ms) */
  timeUntilFlush?: number;
}

// =============================================================================
// Orchestrator Types
// =============================================================================

/**
 * Status of the ingestion orchestrator
 */
export interface OrchestratorStatus {
  /** Active project watchers */
  projectWatchers: Array<{
    projectId: string;
    projectPath: string;
    isWatching: boolean;
  }>;

  /** Orphan file watcher status */
  orphanWatcher: {
    isActive: boolean;
    watchedFilesCount: number;
    maxFiles: number;
  };

  /** Change queue status */
  queue: QueueStatus;

  /** Current embedding provider */
  embeddingProvider?: string;

  /** Current embedding model */
  embeddingModel?: string;
}

/**
 * Events emitted by the orchestrator
 */
export interface OrchestratorEvents {
  /** Fired before ingestion starts */
  'ingestion:start': {
    changes: FileChange[];
    projectId?: string;
  };

  /** Fired after ingestion completes */
  'ingestion:complete': {
    stats: IngestionStats;
    projectId?: string;
  };

  /** Fired on ingestion error */
  'ingestion:error': {
    error: Error;
    changes: FileChange[];
    projectId?: string;
  };

  /** Fired when embeddings are preserved (not regenerated) */
  'embeddings:preserved': {
    count: number;
    projectId?: string;
  };

  /** Fired when embeddings are generated */
  'embeddings:generated': {
    count: number;
    projectId?: string;
  };
}

// =============================================================================
// File Type Detection
// =============================================================================

/**
 * Supported file categories
 */
export type FileCategory =
  | 'code'       // .ts, .tsx, .js, .jsx, .py, .vue, .svelte
  | 'markdown'   // .md, .mdx
  | 'document'   // .pdf, .docx, .xlsx
  | 'image'      // .png, .jpg, .gif, .webp, .bmp
  | '3d'         // .glb, .gltf
  | 'data'       // .json, .yaml, .xml, .csv
  | 'web'        // .html, .css, .scss
  | 'unknown';

/**
 * File extension to category mapping
 */
export const FILE_CATEGORY_MAP: Record<string, FileCategory> = {
  // Code
  '.ts': 'code',
  '.tsx': 'code',
  '.js': 'code',
  '.jsx': 'code',
  '.py': 'code',
  '.vue': 'code',
  '.svelte': 'code',

  // Markdown
  '.md': 'markdown',
  '.mdx': 'markdown',

  // Documents
  '.pdf': 'document',
  '.docx': 'document',
  '.xlsx': 'document',
  '.doc': 'document',
  '.xls': 'document',

  // Images
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.svg': 'image',

  // 3D
  '.glb': '3d',
  '.gltf': '3d',
  '.obj': '3d',
  '.fbx': '3d',

  // Data
  '.json': 'data',
  '.yaml': 'data',
  '.yml': 'data',
  '.xml': 'data',
  '.csv': 'data',

  // Web
  '.html': 'web',
  '.htm': 'web',
  '.css': 'web',
  '.scss': 'web',
  '.sass': 'web',
  '.less': 'web',
};

/**
 * Get the category for a file based on its extension
 */
export function getFileCategory(filePath: string): FileCategory {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return FILE_CATEGORY_MAP[ext] || 'unknown';
}

/**
 * Check if a file is a code file
 */
export function isCodeFile(filePath: string): boolean {
  return getFileCategory(filePath) === 'code';
}

/**
 * Check if a file supports embedding generation
 */
export function supportsEmbeddings(filePath: string): boolean {
  const category = getFileCategory(filePath);
  // All categories except unknown support embeddings
  return category !== 'unknown';
}
