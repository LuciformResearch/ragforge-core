// Document ingestion pipeline (temporarily disabled - llamaindex removed)
// export * from './document-ingestion-pipeline';

// Default patterns for file discovery
export * from './constants.js';

// Ingestion system types
export * from './types.js';

// State machine types and utilities
export * from './state-types.js';

// Node state machine (universal state management)
export { NodeStateMachine } from './node-state-machine.js';

// Metadata preservation (centralized capture/restore)
export { MetadataPreserver, type PreserverConfig } from './metadata-preserver.js';

// Change queue (batching)
export { ChangeQueue, createChangeQueue } from './change-queue.js';

// Orphan file watcher
export { OrphanWatcher, type OrphanWatcherEventHandler } from './orphan-watcher.js';

// Ingestion orchestrator (main entry point)
export {
  IngestionOrchestrator,
  createOrchestrator,
  type OrchestratorDependencies,
  type OrchestratorConfig,
} from './orchestrator.js';

// ============================================================
// NEW PARSER SYSTEM (Phase 1)
// ============================================================

// Parser types and interfaces (selective export to avoid conflicts)
export type {
  // System props
  SystemProps,
  // Position
  NodePosition,
  GotoLocation,
  // Base node
  BaseNodeProps,
  // Field extractors
  FieldExtractors,
  // Chunking
  ChunkingStrategy,
  ChunkingConfig,
  // UUID strategy
  UuidStrategy,
  // Node type definition
  NodeTypeDefinition,
  // Parser input/output
  ParseInput,
  ParserNode,
  ParserRelationship,
  ParseOutput,
  // Parse options
  MediaParseOptions,
  DocumentParseOptions,
  // Content parser interface
  ContentParser,
  // Utility types
  ParserNodeLabels,
  NodeTypeMap,
  ParseStats,
} from './parser-types.js';

// Re-export the SYSTEM_PROPS constant
export { SYSTEM_PROPS } from './parser-types.js';

// Parser registry (auto-generates FIELD_MAPPING and embed configs)
export {
  ParserRegistry,
  parserRegistry,
  registerParser,
  getParserForFile,
  canParseFile,
  getFieldMapping,
  getEmbedConfigs,
  getRecordExtractors,
  recordToObject,
  type NodeFieldMapping,
  type EmbedConfig,
  type RecordEmbeddingExtractors,
} from './parser-registry.js';

// Content extractor (unified extraction + chunking)
export {
  ContentExtractor,
  contentExtractor,
  extractContent,
  computeNodeHash,
  hasNodeChanged,
  hashContent,
  hashFields,
  type ExtractedContent,
  type ExtractOptions,
} from './content-extractor.js';

// ============================================================
// PARSER IMPLEMENTATIONS (Phase 2)
// ============================================================

// All parsers with registration function
export {
  // Individual parsers
  CodeParser,
  codeParser,
  MarkdownParser,
  markdownParser,
  DocumentParser,
  documentParser,
  MediaParser,
  mediaParser,
  DataParser,
  dataParser,
  WebParser,
  webParser,
  // Registration helpers
  allParsers,
  registerAllParsers,
  areParsersRegistered,
  getParserStats,
} from './parsers/index.js';

// ============================================================
// GRAPH OPERATIONS (Phase 3)
// ============================================================

// Graph merger (update-in-place node merging)
export {
  GraphMerger,
  createGraphMerger,
  type MergeNode,
  type MergeRelationship,
  type MergeOptions,
  type MergeStats,
} from './graph-merger.js';

// Reference linker (cross-file CONSUMES relationships)
export {
  ReferenceLinker,
  createReferenceLinker,
  type LinkOptions,
  type LinkStats,
} from './reference-linker.js';
