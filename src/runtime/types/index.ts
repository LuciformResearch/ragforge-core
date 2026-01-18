/**
 * Runtime Type Exports
 *
 * Unified types (imported from core):
 * - Neo4jConfig, RelationshipConfig, ComputedFieldConfig
 *
 * Runtime-specific types (different from core):
 * - RuntimeConfig, EmbeddingsConfig, RerankingConfig
 */

export * from './query.js';
export * from './result.js';

// Entity context types (all types, use export type)
export type {
  EntityField,
  EnrichmentField,
  EntityContext,
  ComputedFieldConfig,
} from './entity-context.js';

// Config types (all types, use export type)
export type {
  RuntimeConfig,
  Neo4jConfig,
  RelationshipConfig,
  RerankingStrategyConfig,
  EmbeddingsConfig as RuntimeEmbeddingsConfig,
  RerankingConfig as RuntimeRerankingConfig,
} from './config.js';

// Backward compat aliases
export type { Neo4jConfig as RuntimeNeo4jConfig } from './config.js';
export type { RelationshipConfig as RuntimeRelationshipConfig } from './config.js';
export type { ComputedFieldConfig as RuntimeComputedFieldConfig } from './entity-context.js';
