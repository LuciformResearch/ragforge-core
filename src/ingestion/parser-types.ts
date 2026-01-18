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

  /**
   * Target node label (for placeholder creation)
   * Used to create placeholder nodes when target doesn't exist yet.
   */
  targetLabel?: string;

  /**
   * Target node properties (for placeholder creation)
   * Minimum properties to create a meaningful placeholder node.
   */
  targetProps?: {
    _name: string;
    [key: string]: unknown;
  };
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
// NORMALIZED NODE PROPERTIES
// ============================================================

/**
 * Normalized content properties that ALL content nodes must have.
 * These are the ONLY text properties used for embeddings and entity extraction.
 * Raw properties (content, text, body, source, etc.) are removed after extraction.
 */
export interface NormalizedNodeProps {
  /** Searchable name/title/signature */
  _name: string;
  /** Main content (code, text, etc.) - null for container nodes */
  _content: string | null;
  /** Description/documentation - null if none */
  _description: string | null;
}

/**
 * Raw content properties that should be removed after normalization.
 * These are parser-specific and replaced by _name, _content, _description.
 */
export const RAW_CONTENT_PROPERTIES = [
  'content',      // Generic content
  'text',         // Text content
  'body',         // Body content
  'source',       // Source code
  'rawText',      // Raw text (markdown)
  'rawContent',   // Raw content (data files)
  'textContent',  // Text content (web/media)
  'ownContent',   // Own content (sections)
  'code',         // Code (code blocks)
  'description',  // Description (without underscore)
  'docstring',    // Docstring (code)
  'templateSource', // Vue/Svelte template
] as const;

// ============================================================
// FILE NODE RAW CONTENT
// ============================================================

/**
 * Maximum size for _rawContent on File nodes (100KB).
 * Files larger than this won't have _rawContent stored.
 */
export const MAX_RAW_CONTENT_SIZE = 100 * 1024;

/**
 * Check if raw content should be stored on a File node.
 * Returns true if content exists and is under the size limit.
 *
 * @param content - File content string
 * @returns true if _rawContent should be stored
 */
export function shouldStoreRawContent(content: string | undefined | null): boolean {
  return !!content && content.length <= MAX_RAW_CONTENT_SIZE;
}

/**
 * Get _rawContent property for a File node.
 * Returns the content if it should be stored, undefined otherwise.
 *
 * @param content - File content string
 * @returns content string or undefined
 */
export function getRawContentProp(content: string | undefined | null): string | undefined {
  return shouldStoreRawContent(content) ? content! : undefined;
}

// ============================================================
// CONTENT NODE CREATION
// ============================================================

/**
 * Create a content node with normalized properties.
 *
 * This is the ONLY way to create content nodes - it ensures:
 * 1. _name, _content, _description are always set
 * 2. Raw content properties are removed
 * 3. Consistency across all parsers
 *
 * @param label - Primary node label (e.g., 'Scope', 'MarkdownSection')
 * @param id - Node ID (becomes uuid)
 * @param rawProps - Raw properties from parser
 * @param fieldExtractors - Functions to extract normalized fields
 * @param additionalLabels - Optional additional labels
 * @returns ParserNode with normalized properties
 *
 * @example
 * ```typescript
 * const node = createContentNode(
 *   'MarkdownSection',
 *   sectionId,
 *   { title: 'Introduction', content: 'Some text...', file: 'readme.md' },
 *   markdownSectionFieldExtractors
 * );
 * // Result: { _name: 'Introduction', _content: 'Some text...', _description: null, title: 'Introduction', file: 'readme.md' }
 * // Note: 'content' property is removed, replaced by '_content'
 * ```
 */
export function createContentNode(
  label: string,
  id: string,
  rawProps: Record<string, unknown>,
  fieldExtractors: FieldExtractors,
  additionalLabels: string[] = []
): ParserNode {
  // Extract normalized fields using the field extractors
  const _name = fieldExtractors.name(rawProps) || '';
  const _content = fieldExtractors.content(rawProps);
  const _description = fieldExtractors.description?.(rawProps) ?? null;

  // Build final properties: normalized fields + raw props (minus raw content)
  const properties: Record<string, unknown> = {
    ...rawProps,
    _name,
    _content,
    _description,
  };

  // Remove raw content properties - they're now in normalized fields
  for (const rawProp of RAW_CONTENT_PROPERTIES) {
    delete properties[rawProp];
  }

  return {
    labels: [label, ...additionalLabels],
    id,
    properties,
  };
}

/**
 * Create a structural node (File, Directory, Project) without content normalization.
 * These nodes don't have embeddable content, just metadata.
 *
 * For File nodes that should have raw content for agent access, pass _rawContent in props.
 *
 * @param label - Node label
 * @param id - Node ID
 * @param props - Node properties (can include _rawContent for File nodes)
 * @param additionalLabels - Optional additional labels
 */
export function createStructuralNode(
  label: string,
  id: string,
  props: Record<string, unknown>,
  additionalLabels: string[] = []
): ParserNode {
  return {
    labels: [label, ...additionalLabels],
    id,
    properties: { ...props },
  };
}

// Lazy import to avoid circular dependency
let _parserRegistry: { getNodeType: (label: string) => NodeTypeDefinition | undefined } | null = null;

/**
 * Set the parser registry reference (called from parser-registry.ts after initialization).
 * This avoids circular imports.
 */
export function setParserRegistryRef(registry: { getNodeType: (label: string) => NodeTypeDefinition | undefined }): void {
  _parserRegistry = registry;
}

/**
 * Create a content node using the parser registry to get field extractors.
 *
 * This is the preferred way to create content nodes when you don't have
 * direct access to the FieldExtractors. It looks up the node type in the
 * registry and uses its field extractors.
 *
 * IMPORTANT: Parsers must be registered before calling this function.
 * Call registerAllParsers() first if needed.
 *
 * @param label - Node label (must be registered in parserRegistry)
 * @param id - Node ID
 * @param rawProps - Raw properties from parser
 * @param additionalLabels - Optional additional labels
 * @returns ParserNode with normalized properties
 * @throws Error if label not found in registry or registry not initialized
 *
 * @example
 * ```typescript
 * // Ensure parsers are registered
 * registerAllParsers();
 *
 * // Create node - extractors are looked up automatically
 * const node = createNodeFromRegistry('Scope', uuid, {
 *   name: scope.name,
 *   source: scope.content,
 *   signature: extractSignature(scope),
 *   docstring: scope.docstring,
 *   file: relPath,
 *   // ... other props
 * });
 * ```
 */
export function createNodeFromRegistry(
  label: string,
  id: string,
  rawProps: Record<string, unknown>,
  additionalLabels: string[] = []
): ParserNode {
  if (!_parserRegistry) {
    throw new Error(
      `[createNodeFromRegistry] Parser registry not initialized. ` +
      `Call registerAllParsers() before creating nodes.`
    );
  }

  const nodeDef = _parserRegistry.getNodeType(label);
  if (!nodeDef?.fields) {
    throw new Error(
      `[createNodeFromRegistry] No field extractors found for label '${label}'. ` +
      `Make sure the parser is registered.`
    );
  }

  return createContentNode(label, id, rawProps, nodeDef.fields, additionalLabels);
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
