/**
 * Parser Types - Unified Interface for All Content Parsers
 *
 * This module defines the interfaces that ALL parsers must implement.
 * It ensures consistency across file types and enables auto-generation
 * of FIELD_MAPPING and embedding configs.
 *
 * @module parser-types
 */

// Import existing types to avoid duplication
import type { NodeState, StateErrorType } from './state-types.js';

// Re-export for convenience
export type { NodeState, StateErrorType };

/**
 * System properties that ALL nodes have.
 * These are managed by the system, not by parsers.
 * All system props use __name__ prefix for clear distinction.
 */
export interface SystemProps {
  // === IDENTITY (no prefix - primary keys) ===
  uuid: string;
  projectId: string;

  // === TIMESTAMPS ===
  __createdAt__: Date;
  __updatedAt__: Date;
  __lastAccessedAt__?: Date;  // null for now, planned for cleanup

  // === STATE MACHINE ===
  __state__: NodeState;
  __stateChangedAt__: Date;
  __parsedAt__?: Date;
  __linkedAt__?: Date;
  __embeddedAt__?: Date;

  // === PROVENANCE ===
  __parserName__: string;
  __schemaVersion__: number;
  __embeddingProvider__?: string;
  __embeddingModel__?: string;

  // === CONTENT VERSIONING ===
  __contentHash__: string;
  __previousContentHash__?: string;
  __contentVersion__: number;

  // === SOURCE ===
  __sourceModifiedAt__?: Date;

  // === ERROR ===
  __errorType__?: StateErrorType;
  __errorMessage__?: string;
  __errorAt__?: Date;
  __retryCount__?: number;
}

/**
 * System property names as constants for type-safe access.
 */
export const SYSTEM_PROPS = {
  // Timestamps
  createdAt: '__createdAt__',
  updatedAt: '__updatedAt__',
  lastAccessedAt: '__lastAccessedAt__',

  // State machine
  state: '__state__',
  stateChangedAt: '__stateChangedAt__',
  parsedAt: '__parsedAt__',
  linkedAt: '__linkedAt__',
  embeddedAt: '__embeddedAt__',

  // Provenance
  parserName: '__parserName__',
  schemaVersion: '__schemaVersion__',
  embeddingProvider: '__embeddingProvider__',
  embeddingModel: '__embeddingModel__',

  // Content versioning
  contentHash: '__contentHash__',
  previousContentHash: '__previousContentHash__',
  contentVersion: '__contentVersion__',

  // Source
  sourceModifiedAt: '__sourceModifiedAt__',

  // Error
  errorType: '__errorType__',
  errorMessage: '__errorMessage__',
  errorAt: '__errorAt__',
  retryCount: '__retryCount__',
} as const;

// ============================================================
// POSITION - Unified location in source
// ============================================================

/**
 * Position within a source file/document.
 * Different types for different source kinds.
 */
export type NodePosition =
  | { type: 'lines'; startLine: number; endLine: number; startChar?: number; endChar?: number }
  | { type: 'page'; page: number; bbox?: { x: number; y: number; width: number; height: number } }
  | { type: 'anchor'; anchor: string }
  | { type: 'whole' };  // Entire file/document

/**
 * Location for navigation (e.g., "go to definition").
 */
export interface GotoLocation {
  path: string;
  line?: number;
  column?: number;
  page?: number;
  anchor?: string;
}

// ============================================================
// BASE NODE PROPERTIES
// ============================================================

/**
 * Base properties that ALL content nodes must have.
 * Parsers must ensure these are set on every node.
 */
export interface BaseNodeProps {
  // === IDENTITY (required) ===
  uuid: string;
  projectId: string;

  // === SOURCE (required) ===
  sourcePath: string;      // Absolute path or URL
  sourceType: 'file' | 'url';

  // === POSITION (optional but standardized) ===
  startLine?: number;      // 1-based
  endLine?: number;
  startChar?: number;      // 0-based offset in file
  endChar?: number;

  // === HIERARCHY (optional) ===
  parentUuid?: string;
  depth?: number;          // 0 = root level

  // === CONTENT HASH (required - for change detection) ===
  contentHash: string;
}

// ============================================================
// FIELD EXTRACTORS - How to get embeddable content
// ============================================================

/**
 * Functions to extract embeddable content from a node.
 * Each parser must define these for every node type it creates.
 */
export interface FieldExtractors {
  /**
   * Extract the name/title/signature.
   * Used for embedding_name - "find the X function/class/section".
   */
  name: (node: Record<string, unknown>) => string;

  /**
   * Extract the main content (code, text, etc.).
   * Used for embedding_content - "code that does X".
   * Return null if no distinct content (e.g., container nodes).
   */
  content: (node: Record<string, unknown>) => string | null;

  /**
   * Extract description/documentation.
   * Used for embedding_description - "documented as X".
   * Return null if no description available.
   */
  description?: (node: Record<string, unknown>) => string | null;

  /**
   * Extract display path for UI.
   * e.g., "src/utils.ts:42" or "docs/readme.md#installation"
   */
  displayPath: (node: Record<string, unknown>) => string;

  /**
   * Get location for navigation.
   * Used by IDE integrations to jump to the node.
   */
  gotoLocation?: (node: Record<string, unknown>) => GotoLocation | null;
}

// ============================================================
// CHUNKING CONFIGURATION
// ============================================================

/**
 * Strategy for splitting large content into chunks.
 */
export type ChunkingStrategy = 'paragraph' | 'sentence' | 'code' | 'fixed';

/**
 * Configuration for content chunking.
 */
export interface ChunkingConfig {
  /** Whether chunking is enabled for this node type */
  enabled: boolean;

  /** Maximum chunk size in characters */
  maxSize: number;

  /** Overlap between chunks in characters */
  overlap?: number;

  /** Strategy for splitting */
  strategy: ChunkingStrategy;
}

// ============================================================
// UUID GENERATION STRATEGY
// ============================================================

/**
 * How to generate deterministic UUIDs for nodes.
 * UUIDs must be reproducible across re-ingestion.
 */
export type UuidStrategy =
  | { type: 'signature'; fields: string[] }  // hash(sourcePath + fields values)
  | { type: 'position' }                      // hash(sourcePath + startLine + name)
  | { type: 'path' }                          // hash(sourcePath only)
  | { type: 'content'; field: string };       // hash(sourcePath + content field)

// ============================================================
// NODE TYPE DEFINITION
// ============================================================

/**
 * Complete definition of a node type.
 * Every parser must provide this for each node type it creates.
 */
export interface NodeTypeDefinition {
  /** Neo4j label (e.g., 'Scope', 'MarkdownSection') */
  label: string;

  /** Human-readable description */
  description?: string;

  /** Does this node type support line-level navigation? */
  supportsLineNavigation: boolean;

  /** Strategy for generating deterministic UUIDs */
  uuidStrategy: UuidStrategy;

  /** Functions to extract embeddable content */
  fields: FieldExtractors;

  /** Which property to use for content hash (change detection) */
  contentHashField: string;

  /** Configuration for chunking large content */
  chunking?: ChunkingConfig;

  /** Additional required properties beyond BaseNodeProps */
  additionalRequiredProps: string[];

  /** Optional: properties that should be indexed in Neo4j */
  indexedProps?: string[];
}

// ============================================================
// PARSER INPUT/OUTPUT
// ============================================================

/**
 * Input to a parser.
 */
export interface ParseInput {
  /** Absolute path to the file (or virtual path for uploaded files) */
  filePath: string;

  /** File content as string (if already read - for text files) */
  content?: string;

  /** File content as Buffer (for binary files like PDF, DOCX) */
  binaryContent?: Buffer;

  /** Project ID */
  projectId: string;

  /** Parser-specific options */
  options?: Record<string, unknown>;
}

/**
 * Options for media parsing (images, 3D models)
 */
export interface MediaParseOptions {
  /**
   * Enable Vision API for analyzing images and 3D model renders.
   * - For images: generates a description using vision analysis
   * - For 3D models: renders views and describes them using vision
   * @default false
   */
  enableVision?: boolean;

  /**
   * Vision analyzer function (required if enableVision is true).
   * Takes image buffer and optional prompt, returns description.
   */
  visionAnalyzer?: (imageBuffer: Buffer, prompt?: string) => Promise<string>;

  /**
   * 3D render function (required for 3D models if enableVision is true).
   * Takes model path, returns rendered image buffers for each view.
   */
  render3D?: (modelPath: string) => Promise<{ view: string; buffer: Buffer }[]>;
}

/**
 * Options for document parsing (PDF, DOCX, etc.)
 */
export interface DocumentParseOptions {
  /**
   * Enable Vision API for analyzing images in the document.
   * When enabled, images are rendered and analyzed with a vision model.
   * @default false
   */
  enableVision?: boolean;

  /**
   * Vision provider to use when enableVision is true.
   * @default 'gemini'
   */
  visionProvider?: 'gemini' | 'claude';

  /**
   * Vision analyzer function (required if enableVision is true).
   * Takes image buffer and optional prompt, returns description.
   */
  visionAnalyzer?: (imageBuffer: Buffer, prompt?: string) => Promise<string>;

  /**
   * Section title detection mode.
   * - 'none': No section titles, just paragraphs
   * - 'detect': Heuristic detection of titles (I., A., Abstract, etc.)
   * - 'llm': Use LLM to analyze document structure
   * @default 'detect'
   */
  sectionTitles?: 'none' | 'detect' | 'llm';

  /**
   * Maximum number of pages to process (for large documents).
   * @default undefined (all pages)
   */
  maxPages?: number;

  /**
   * Minimum paragraph length to keep as separate section.
   * @default 50
   */
  minParagraphLength?: number;

  /**
   * Generate titles for sections that don't have one using LLM.
   * When enabled, sections without titles will get AI-generated titles
   * based on their content.
   * @default false (core), true (community-docs)
   */
  generateTitles?: boolean;

  /**
   * LLM provider for title generation (required if generateTitles is true).
   * Must implement the LLMProvider interface.
   */
  titleGenerator?: (sections: Array<{ index: number; content: string }>) => Promise<Array<{ index: number; title: string }>>;
}

/**
 * A node produced by a parser before system props are added.
 * Named differently from the existing ParsedNode in types.ts to avoid conflicts.
 */
export interface ParserNode {
  /** Node labels (first is primary) */
  labels: string[];

  /** Temporary ID for relationship building (becomes uuid) */
  id: string;

  /** Node properties (without system props) */
  properties: Record<string, unknown>;

  /** Position in source (optional) */
  position?: NodePosition;

  /** Parent node ID (for hierarchy) */
  parentId?: string;
}

/**
 * A relationship produced by a parser.
 * Named differently from the existing ParsedRelationship in types.ts to avoid conflicts.
 */
export interface ParserRelationship {
  /** Relationship type (e.g., 'CONTAINS', 'CONSUMES') */
  type: string;

  /** Source node ID */
  from: string;

  /** Target node ID */
  to: string;

  /** Relationship properties */
  properties?: Record<string, unknown>;
}

/**
 * Output from a parser.
 */
export interface ParseOutput {
  /** Parsed nodes */
  nodes: ParserNode[];

  /** Parsed relationships */
  relationships: ParserRelationship[];

  /** Any warnings during parsing */
  warnings?: string[];

  /** Parser metadata */
  metadata?: {
    parseTimeMs: number;
    fileSize: number;
  };
}

// ============================================================
// CONTENT PARSER INTERFACE
// ============================================================

/**
 * Interface that ALL parsers must implement.
 *
 * This ensures:
 * 1. Every parser defines its supported file extensions
 * 2. Every parser defines the node types it creates
 * 3. Every node type has field extractors for embedding
 * 4. TypeScript enforces the contract
 *
 * @example
 * ```typescript
 * class MarkdownParser implements ContentParser {
 *   readonly name = 'markdown';
 *   readonly version = 1;
 *   readonly supportedExtensions = ['.md', '.mdx'];
 *   readonly nodeTypes = [
 *     {
 *       label: 'MarkdownSection',
 *       supportsLineNavigation: true,
 *       // ... full definition
 *     }
 *   ];
 *
 *   async parse(input: ParseInput): Promise<ParseOutput> {
 *     // Implementation
 *   }
 * }
 * ```
 */
export interface ContentParser {
  /** Unique name of this parser */
  readonly name: string;

  /** Schema version (increment when node structure changes) */
  readonly version: number;

  /** File extensions this parser handles (e.g., ['.md', '.mdx']) */
  readonly supportedExtensions: string[];

  /** MIME types this parser handles (optional) */
  readonly supportedMimeTypes?: string[];

  /** Node types created by this parser */
  readonly nodeTypes: NodeTypeDefinition[];

  /**
   * Parse a file and return nodes + relationships.
   *
   * @param input - Parse input (file path, content, options)
   * @returns Parsed nodes and relationships
   */
  parse(input: ParseInput): Promise<ParseOutput>;

  /**
   * Check if this parser can handle a file.
   * Default implementation checks supportedExtensions.
   * Override for more complex logic (e.g., checking file content).
   *
   * @param filePath - Path to the file
   * @param mimeType - Optional MIME type
   * @returns true if this parser can handle the file
   */
  canHandle?(filePath: string, mimeType?: string): boolean;
}

// ============================================================
// UTILITY TYPES
// ============================================================

/**
 * Extract the node type labels from a parser.
 */
export type ParserNodeLabels<P extends ContentParser> = P['nodeTypes'][number]['label'];

/**
 * Map of label to node type definition.
 */
export type NodeTypeMap = Map<string, NodeTypeDefinition>;

/**
 * Statistics from parsing.
 */
export interface ParseStats {
  filesProcessed: number;
  nodesCreated: number;
  relationshipsCreated: number;
  errors: number;
  warnings: number;
  totalTimeMs: number;
}
