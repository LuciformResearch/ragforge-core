/**
 * Brain Module
 *
 * Central knowledge management for the agent.
 */

export {
  BrainManager,
  DEFAULT_PERSONAS,
  type BrainConfig,
  type PersonaDefinition,
  type TerminalColor,
  type RegisteredProject,
  type QuickIngestOptions,
  type QuickIngestResult,
  type BrainSearchOptions,
  type BrainSearchResult,
  type UnifiedSearchResult,
  type GCStats,
} from './brain-manager.js';

export {
  EmbeddingService,
  hashContent,
  DEFAULT_EMBED_CONFIGS,
  MULTI_EMBED_CONFIGS,
  // Standalone utility for ensuring vector indexes
  ensureVectorIndexes,
  type EmbeddingType,
  type EmbeddingFieldConfig,
  type MultiEmbedNodeTypeConfig,
  type EmbedNodeTypeConfig,
  type EmbeddingResult,
  type GenerateEmbeddingsOptions,
  type GenerateMultiEmbeddingsOptions,
  type MultiEmbeddingResult,
  type EnsureVectorIndexesOptions,
  type EnsureVectorIndexesResult,
  // EmbeddingProviderConfig is now unified - re-exported from types/config.ts
} from './embedding-service.js';

export {
  ThreeDService,
  type ThreeDServiceConfig,
  type RenderAndAnalyzeOptions,
  type RenderAndAnalyzeResult,
} from './threed-service.js';

export {
  TouchedFilesWatcher,
  type TouchedFilesWatcherConfig,
  type ProcessingStats,
  type OrphanFile,
} from './touched-files-watcher.js';

export {
  FileStateMachine,
  FileStateMigration,
  isValidTransition,
  getNextState,
  type FileState,
  type ErrorType,
  type StateTransition,
  type FileStateInfo,
  type TransitionOptions,
} from './file-state-machine.js';

export {
  extractReferences,
  extractGenericReferences,
  resolveReference,
  resolveAllReferences,
  resolveLooseReference,
  createReferenceRelations,
  resolvePendingImports,
  resolveUnresolvedMentions,
  type ReferenceType,
  type RelationType,
  type ExtractedReference,
  type ResolvedReference,
  type ReferenceCreationResult,
  type FuzzyMatchResult,
} from './reference-extractor.js';

export {
  FileProcessor,
  createOrphanFileProcessor,
  createProjectFileProcessor,
  type FileInfo,
  type ProcessResult,
  type BatchResult,
  type FileProcessorConfig,
} from './file-processor.js';

export {
  ChangeDetector,
  type ChangeResult,
  type BatchChangeResult,
  type ChangeDetectorConfig,
} from './change-detector.js';

export {
  EmbeddingCoordinator,
  createEmbeddingCoordinator,
  type EmbedProjectResult,
  type EmbeddingCoordinatorConfig,
  type EmbedProjectOptions,
} from './embedding-coordinator.js';

// SearchService (reusable search logic for brain_search and community-docs)
export {
  SearchService,
  type SearchServiceConfig,
  type SearchOptions,
  type SearchFilter,
  type FilterOperator,
  type ServiceSearchResult,
  type ServiceSearchResultSet,
} from './search-service.js';

// Formatters
export {
  formatAsMarkdown,
  formatAsCompact,
  type BrainSearchOutput,
  type FormatOptions,
} from './formatters/index.js';

// Search Post-Processor (shared post-processing logic for brain_search and community-docs)
export {
  applyKeywordBoost,
  exploreRelationships,
  summarizeSearchResults,
  rerankSearchResults,
  postProcessSearchResults,
  type ProcessableSearchResult,
  type KeywordBoostOptions,
  type KeywordBoostResult,
  type ExploreRelationshipsOptions,
  type GraphNode,
  type GraphEdge,
  type ExplorationGraph,
  type SummarizeOptions,
  type SummaryResult,
  type RerankOptions,
  type RerankResult,
  type PostProcessOptions,
  type PostProcessResult,
} from './search-post-processor.js';
