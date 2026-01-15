/**
 * Entity Extraction Module
 *
 * GLiNER-based entity and relation extraction for RagForge.
 *
 * @example
 * ```ts
 * import {
 *   createEntityExtractionTransform,
 *   EntityExtractionClient,
 * } from './entity-extraction/index.js';
 *
 * // Use as transformGraph hook in orchestrator
 * const transform = createEntityExtractionTransform({
 *   serviceUrl: 'http://localhost:6971',
 *   autoDetectDomain: true,
 * });
 *
 * // Or use client directly
 * const client = new EntityExtractionClient();
 * const result = await client.extract("Apple released iPhone 15 at $999");
 * ```
 */

// Types
export type {
  ExtractedEntity,
  ExtractedRelation,
  ExtractionResult,
  ExtractionRequest,
  BatchExtractionRequest,
  BatchExtractionResponse,
  HealthResponse,
  EntityExtractionConfig,
  DomainPreset,
  DomainPresetConfig,
} from './types.js';

export {
  DEFAULT_ENTITY_EXTRACTION_CONFIG,
  DOMAIN_PRESETS,
} from './types.js';

// Client
export {
  EntityExtractionClient,
  getEntityExtractionClient,
  resetEntityExtractionClient,
} from './client.js';

// Transform (for orchestrator integration)
export {
  createEntityExtractionTransform,
  type EntityExtractionTransformOptions,
} from './transform.js';

// Deduplication (fuzzy, embedding, LLM, hybrid)
export {
  deduplicateEntities,
  findFuzzyDuplicates,
  findEmbeddingDuplicates,
  calculateSimilarity,
  cosineSimilarity,
  buildLLMResolutionPrompt,
  type DuplicatePair,
  type DeduplicationResult,
  type DeduplicationConfig,
} from './deduplication.js';
