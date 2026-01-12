/**
 * Source Adapters for RagForge
 *
 * Adapters for parsing various sources into Neo4j graph structures
 */

// Re-export types with alias for SourceConfig to avoid conflict with core
export {
  SourceConfig as AdapterSourceConfig,
  ParsedNode,
  ParsedRelationship,
  ParsedGraph,
  UpdateStats,
  ParseResult,
  ParseOptions,
  ParseProgress,
  SourceAdapter,
  ValidationResult,
  VirtualFile,
} from './types.js';
export * from './code-source-adapter.js';
// Document parsing is now handled by document-file-parser.ts (web-compatible)
// TikaSourceAdapter (Java-based) has been removed
export * from './document-file-parser.js';
export * from './incremental-ingestion.js';
export * from './ingestion-queue.js';
export * from './file-watcher.js';
export * from './change-tracker.js';
export * from './universal-source-adapter.js';
export * from './database-adapter.js';
