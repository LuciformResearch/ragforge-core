/**
 * Entity Extraction Transform
 *
 * Provides a transformGraph hook for the IngestionOrchestrator
 * that extracts entities from document content using GLiNER.
 */

import type { ParsedGraph, ParsedNode, ParsedRelationship } from '../../runtime/adapters/types.js';
import type { EntityExtractionConfig, ExtractedEntity, ExtractionResult } from './types.js';
import { DEFAULT_ENTITY_EXTRACTION_CONFIG } from './types.js';
import { EntityExtractionClient } from './client.js';
import { deduplicateEntities, type DeduplicationConfig } from './deduplication.js';

/**
 * Node labels to process for entity extraction.
 * Only document-like content (no code, no structured data).
 */
export const ENTITY_EXTRACTION_LABELS = new Set([
  'MarkdownSection',
  'MarkdownDocument',
  'WebPage',
  'WebDocument',
]);

/**
 * Check if a node should be processed for entity extraction.
 * Handles both direct document nodes AND their EmbeddingChunks.
 * Filters out code nodes (have language property) and non-document labels.
 */
export function shouldExtractEntities(node: { labels: string[]; properties: Record<string, unknown> }): boolean {
  const labels = node.labels;
  const props = node.properties;

  // Case 1: Direct document node (MarkdownSection, etc.)
  const hasDocLabel = labels.some(l => ENTITY_EXTRACTION_LABELS.has(l));
  if (hasDocLabel) {
    // Must NOT have a programming language (excludes CodeBlock, etc.)
    const lang = props.language;
    if (lang !== null && lang !== undefined) return false;
    return true;
  }

  // Case 2: EmbeddingChunk with a document parent
  if (labels.includes('EmbeddingChunk')) {
    const parentLabel = props.parentLabel as string | undefined;
    if (parentLabel && ENTITY_EXTRACTION_LABELS.has(parentLabel)) {
      return true;
    }
  }

  return false;
}

/**
 * Options for the entity extraction transform.
 */
export interface EntityExtractionTransformOptions extends Partial<EntityExtractionConfig> {
  /**
   * Project ID for Entity nodes. Required for project-scoped queries and indexes.
   */
  projectId?: string;

  /**
   * Minimum text length to extract from (default: 50).
   * Shorter texts are skipped as they usually don't contain useful entities.
   */
  minTextLength?: number;

  /**
   * Maximum text length per extraction (default: 5000).
   * Longer texts are truncated to avoid overwhelming the model.
   */
  maxTextLength?: number;

  /**
   * Node labels to extract entities from (default: all with _content).
   * If specified, only nodes with these labels are processed.
   */
  nodeLabels?: string[];

  /**
   * Whether to log progress (default: false).
   */
  verbose?: boolean;

  /**
   * Deduplication configuration (default: fuzzy strategy).
   * Set to false to disable deduplication.
   */
  deduplication?: Partial<DeduplicationConfig> | false;

  /**
   * Function to generate embeddings for semantic deduplication.
   * Required for 'embedding' and 'hybrid' deduplication strategies.
   */
  embedFunction?: (texts: string[]) => Promise<number[][]>;
}

/** Resolved configuration with all required defaults. */
type ResolvedTransformOptions = {
  serviceUrl: string;
  entityTypes: string[];
  relationTypes: Record<string, string>;
  autoDetectDomain: boolean;
  confidenceThreshold: number;
  enabled: boolean;
  timeoutMs: number;
  projectId: string;
  minTextLength: number;
  maxTextLength: number;
  nodeLabels: string[];
  verbose: boolean;
  deduplication: Partial<DeduplicationConfig> | false;
  embedFunction?: (texts: string[]) => Promise<number[][]>;
};

const DEFAULT_TRANSFORM_OPTIONS: ResolvedTransformOptions = {
  // EntityExtractionConfig defaults
  serviceUrl: DEFAULT_ENTITY_EXTRACTION_CONFIG.serviceUrl,
  entityTypes: [],
  relationTypes: {},
  autoDetectDomain: DEFAULT_ENTITY_EXTRACTION_CONFIG.autoDetectDomain ?? false,
  confidenceThreshold: DEFAULT_ENTITY_EXTRACTION_CONFIG.confidenceThreshold ?? 0.5,
  enabled: DEFAULT_ENTITY_EXTRACTION_CONFIG.enabled ?? true,
  timeoutMs: DEFAULT_ENTITY_EXTRACTION_CONFIG.timeoutMs ?? 30000,
  // Transform-specific defaults
  projectId: 'unknown',
  minTextLength: 50,
  maxTextLength: 5000,
  nodeLabels: [],
  verbose: false,
  // Deduplication defaults (fuzzy strategy)
  deduplication: { strategy: 'fuzzy', fuzzyThreshold: 0.85 },
  embedFunction: undefined,
};

/**
 * Create a transformGraph function for entity extraction.
 *
 * This function can be passed to IngestionOrchestrator.deps.transformGraph
 * to automatically extract entities during ingestion.
 *
 * @example
 * ```ts
 * import { IngestionOrchestrator } from './orchestrator.js';
 * import { createEntityExtractionTransform } from './entity-extraction/transform.js';
 *
 * const orchestrator = new IngestionOrchestrator({
 *   // ... other config
 *   deps: {
 *     // ... other deps
 *     transformGraph: createEntityExtractionTransform({
 *       serviceUrl: 'http://localhost:6971',
 *       autoDetectDomain: true,
 *       verbose: true,
 *     }),
 *   },
 * });
 * ```
 */
export function createEntityExtractionTransform(
  options: EntityExtractionTransformOptions = {}
): (graph: ParsedGraph) => Promise<ParsedGraph> {
  const config = { ...DEFAULT_TRANSFORM_OPTIONS, ...options };
  const client = new EntityExtractionClient(config);

  return async (graph: ParsedGraph): Promise<ParsedGraph> => {
    // Skip if disabled
    // Note: Always return a NEW object to avoid mutation bugs when caller modifies arrays
    if (!config.enabled) {
      return { ...graph, nodes: [...graph.nodes], relationships: [...graph.relationships] };
    }

    // Check service availability
    const available = await client.isAvailable();
    if (!available) {
      if (config.verbose) {
        console.warn('[EntityExtraction] GLiNER service not available, skipping');
      }
      return { ...graph, nodes: [...graph.nodes], relationships: [...graph.relationships] };
    }

    // Extract text content from nodes
    const textNodes = extractTextFromNodes(graph.nodes, config);
    if (textNodes.length === 0) {
      if (config.verbose) {
        console.log('[EntityExtraction] No text content found in nodes');
      }
      return { ...graph, nodes: [...graph.nodes], relationships: [...graph.relationships] };
    }

    if (config.verbose) {
      console.log(`[EntityExtraction] Processing ${textNodes.length} nodes...`);
    }

    // Batch extract entities
    const texts = textNodes.map(n => n.text);
    let results: ExtractionResult[];

    try {
      results = await client.extractBatch(texts);
    } catch (error) {
      console.error('[EntityExtraction] Batch extraction failed:', error);
      return { ...graph, nodes: [...graph.nodes], relationships: [...graph.relationships] };
    }

    // Deduplicate entities if enabled
    let canonicalMapping: Map<string, string> | undefined;
    let dedupStats: { duplicatesRemoved: number } | undefined;

    if (config.deduplication !== false) {
      // Collect all entities from all results
      const allEntities: ExtractedEntity[] = [];
      for (const result of results) {
        if (result?.entities) {
          allEntities.push(...result.entities);
        }
      }

      if (allEntities.length > 1) {
        try {
          const dedupConfig = {
            ...config.deduplication,
            embedFunction: config.embedFunction,
          };

          const dedupResult = await deduplicateEntities(allEntities, dedupConfig);
          canonicalMapping = dedupResult.canonicalMapping;
          dedupStats = { duplicatesRemoved: dedupResult.stats.duplicatesRemoved };

          if (config.verbose && dedupResult.stats.duplicatesRemoved > 0) {
            console.log(
              `[EntityExtraction] Deduplication: removed ${dedupResult.stats.duplicatesRemoved} duplicates ` +
              `(${dedupResult.stats.originalCount} -> ${dedupResult.stats.deduplicatedCount})`
            );
          }
        } catch (error) {
          if (config.verbose) {
            console.warn('[EntityExtraction] Deduplication failed, continuing without:', error);
          }
        }
      }
    }

    // Build entity nodes and relationships
    const { entityNodes, entityRelationships, stats } = buildEntityGraph(
      textNodes,
      results,
      config.confidenceThreshold || 0.5,
      config.projectId,
      canonicalMapping
    );

    if (config.verbose) {
      console.log(
        `[EntityExtraction] Created ${stats.entitiesCreated} entities, ` +
        `${stats.relationsCreated} relations, ${stats.mentionsCreated} mentions` +
        (dedupStats ? ` (${dedupStats.duplicatesRemoved} duplicates merged)` : '')
      );
    }

    // Return enriched graph with entity extraction metadata
    return {
      nodes: [...graph.nodes, ...entityNodes],
      relationships: [...graph.relationships, ...entityRelationships],
      metadata: {
        ...graph.metadata,
        entityExtraction: {
          nodesProcessed: textNodes.length,
          entitiesCreated: stats.entitiesCreated,
          relationsCreated: stats.relationsCreated,
          mentionsCreated: stats.mentionsCreated,
          uniqueEntityTypes: stats.uniqueEntityTypes,
          duplicatesRemoved: dedupStats?.duplicatesRemoved ?? 0,
        },
      } as ParsedGraph['metadata'] & { entityExtraction: EntityExtractionMetadata },
    };
  };
}

// =============================================================================
// Internal Types
// =============================================================================

interface TextNode {
  nodeId: string;
  text: string;
  labels: string[];
}

/** Metadata added by entity extraction transform. */
interface EntityExtractionMetadata {
  nodesProcessed: number;
  entitiesCreated: number;
  relationsCreated: number;
  mentionsCreated: number;
  uniqueEntityTypes: string[];
  duplicatesRemoved: number;
}

interface EntityGraphBuildResult {
  entityNodes: ParsedNode[];
  entityRelationships: ParsedRelationship[];
  stats: {
    entitiesCreated: number;
    relationsCreated: number;
    mentionsCreated: number;
    uniqueEntityTypes: string[];
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract text content from nodes suitable for entity extraction.
 * By default, only processes document nodes (MarkdownSection, etc.)
 * and excludes code nodes.
 */
function extractTextFromNodes(
  nodes: ParsedNode[],
  config: ResolvedTransformOptions
): TextNode[] {
  const textNodes: TextNode[] = [];

  for (const node of nodes) {
    // If specific labels are provided, use them; otherwise use smart filtering
    if (config.nodeLabels.length > 0) {
      const hasMatchingLabel = node.labels.some(l => config.nodeLabels.includes(l));
      if (!hasMatchingLabel) continue;
    } else {
      // Default: use shouldExtractEntities to filter document nodes only
      if (!shouldExtractEntities(node)) continue;
    }

    // Get text content from various properties
    const text = getNodeTextContent(node);
    if (!text || text.length < config.minTextLength) continue;

    textNodes.push({
      nodeId: node.id,
      text: text.slice(0, config.maxTextLength),
      labels: node.labels,
    });
  }

  return textNodes;
}

/**
 * Get text content from a node's properties.
 * Uses normalized _content field set at parser level via createContentNode().
 */
function getNodeTextContent(node: ParsedNode): string | null {
  const content = node.properties._content;
  if (content && typeof content === 'string') {
    return content.trim();
  }
  return null;
}

/**
 * Build entity nodes and relationships from extraction results.
 *
 * @param canonicalMapping - Optional mapping from entity name to canonical name (from deduplication)
 */
function buildEntityGraph(
  textNodes: TextNode[],
  results: ExtractionResult[],
  confidenceThreshold: number,
  projectId: string,
  canonicalMapping?: Map<string, string>
): EntityGraphBuildResult {
  const entityNodes: ParsedNode[] = [];
  const entityRelationships: ParsedRelationship[] = [];

  // Track entities for deduplication within batch
  const entityMap = new Map<string, string>(); // entityKey -> entityId
  const entityTypes = new Set<string>();

  let mentionsCreated = 0;
  let relationsCreated = 0;

  for (let i = 0; i < textNodes.length; i++) {
    const sourceNode = textNodes[i];
    const result = results[i];

    if (!result?.entities?.length) continue;

    // Process entities
    for (const entity of result.entities) {
      // Skip low confidence (only if confidence is a valid number)
      if (typeof entity.confidence === 'number' && entity.confidence < confidenceThreshold) {
        continue;
      }

      // Apply canonical mapping if available (from deduplication)
      const originalName = entity.name;
      const normalizedOriginal = originalName.toLowerCase().trim();
      const canonicalName = canonicalMapping?.get(normalizedOriginal) || originalName;
      const normalizedName = canonicalName.toLowerCase().trim();

      // Create unique key for deduplication (using canonical name)
      const entityKey = `${entity.type}:${normalizedName}`;

      entityTypes.add(entity.type);

      let entityId: string;
      if (entityMap.has(entityKey)) {
        // Reuse existing entity
        entityId = entityMap.get(entityKey)!;
      } else {
        // Create new entity node with canonical name
        const canonicalEntity = { ...entity, name: canonicalName };
        entityId = generateEntityId(canonicalEntity);
        entityMap.set(entityKey, entityId);

        entityNodes.push({
          labels: ['Entity'],
          id: entityId,
          properties: {
            // System properties (required for indexes and embeddings)
            uuid: entityId,
            projectId: projectId,
            _state: 'linked', // Use _state for state machine compatibility
            embeddingsDirty: true,
            // Use unified field names (canonical name)
            _name: canonicalName,
            _content: canonicalName, // For embedding generation
            entityType: entity.type,
            confidence: entity.confidence,
            normalized: normalizedName,
          },
        });
      }

      // Create MENTIONS relationship
      entityRelationships.push({
        type: 'MENTIONS',
        from: sourceNode.nodeId,
        to: entityId,
        properties: {
          confidence: entity.confidence,
          span: entity.span ? JSON.stringify(entity.span) : undefined,
        },
      });
      mentionsCreated++;
    }

    // Process relations
    for (const relation of result.relations || []) {
      // Find entity IDs for subject and object
      const subjectId = findEntityIdByName(entityMap, relation.subject);
      const objectId = findEntityIdByName(entityMap, relation.object);

      if (subjectId && objectId) {
        // Create relationship with predicate as type
        const relType = relation.predicate.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

        entityRelationships.push({
          type: relType,
          from: subjectId,
          to: objectId,
          properties: {
            confidence: relation.confidence,
            originalPredicate: relation.predicate,
          },
        });
        relationsCreated++;
      }
    }
  }

  return {
    entityNodes,
    entityRelationships,
    stats: {
      entitiesCreated: entityNodes.length,
      relationsCreated,
      mentionsCreated,
      uniqueEntityTypes: Array.from(entityTypes),
    },
  };
}

/**
 * Generate a unique ID for an entity.
 */
function generateEntityId(entity: ExtractedEntity): string {
  const normalized = entity.name.toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
  return `entity:${entity.type}:${normalized}`;
}

/**
 * Find entity ID by name (fuzzy match).
 */
function findEntityIdByName(
  entityMap: Map<string, string>,
  name: string
): string | undefined {
  const normalizedName = name.toLowerCase().trim();

  // Try exact match first
  for (const [key, id] of entityMap.entries()) {
    const keyName = key.split(':')[1];
    if (keyName === normalizedName) {
      return id;
    }
  }

  // Try partial match
  for (const [key, id] of entityMap.entries()) {
    const keyName = key.split(':')[1];
    if (keyName && (keyName.includes(normalizedName) || normalizedName.includes(keyName))) {
      return id;
    }
  }

  return undefined;
}
