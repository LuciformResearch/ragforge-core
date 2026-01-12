/**
 * Discovery Tools
 *
 * Tools for agents to discover the database schema.
 * 100% generic - works with any RagForge config (code, documents, products, etc.)
 */

import type {
  ToolGenerationContext,
  GeneratedToolDefinition,
  ToolHandlerGenerator,
  EntityMetadata,
  ToolGenerationContextGetter,
} from './types/index.js';
import { EMPTY_CONTEXT } from './types/index.js';

/**
 * Schema representation returned by get_schema tool
 */
export interface SchemaInfo {
  /** List of entity names */
  entities: string[];

  /** Detailed info per entity */
  entity_details: Record<string, EntitySchemaInfo>;

  /** All relationships in the graph */
  relationships: RelationshipInfo[];

  /** Available semantic search indexes */
  semantic_indexes: SemanticIndexInfo[];

  /** Tips for the agent */
  usage_tips: string[];
}

export interface EntitySchemaInfo {
  name: string;
  description?: string;
  unique_field: string;
  display_name_field: string;
  query_field: string;
  content_field?: string;  // Field containing full content (use get_entities_by_ids to fetch)
  example_display_fields?: string[];
  fields: FieldInfo[];
  computed_fields?: FieldInfo[];
  has_semantic_search: boolean;
  semantic_indexes?: string[];
  outgoing_relationships: string[];
  incoming_relationships: string[];
  hierarchical_content?: {
    children_relationship: string;  // Relationship linking children to this entity
    include_children: boolean;      // Full content includes children
  };
}

export interface FieldInfo {
  name: string;
  type: string;
  description?: string;
  is_unique?: boolean;
  indexed?: boolean;
  values?: string[];  // For enum-type fields
}

export interface RelationshipInfo {
  type: string;
  from: string;
  to: string;
  description?: string;
}

export interface SemanticIndexInfo {
  name: string;
  entity: string;
  source_field: string;
  description: string;
}

/**
 * Generate discovery tools from context
 *
 * @param staticContext - Static context for tool definition generation
 * @param getContext - Optional context getter for dynamic resolution at execution time
 */
export function generateDiscoveryTools(
  staticContext: ToolGenerationContext,
  getContext?: ToolGenerationContextGetter
): { tools: GeneratedToolDefinition[]; handlers: Record<string, ToolHandlerGenerator> } {
  const tools: GeneratedToolDefinition[] = [];
  const handlers: Record<string, ToolHandlerGenerator> = {};

  // If no getter provided, create one that returns the static context
  const contextGetter: ToolGenerationContextGetter = getContext || (() => staticContext);

  // 1. get_schema tool - uses static context for definition, dynamic for handler
  const getSchema = generateGetSchemaTool(staticContext, contextGetter);
  tools.push(getSchema.definition);
  handlers[getSchema.definition.name] = getSchema.handler;

  // 2. describe_entity tool (optional, more detailed per-entity)
  const describeEntity = generateDescribeEntityTool(staticContext, contextGetter);
  tools.push(describeEntity.definition);
  handlers[describeEntity.definition.name] = describeEntity.handler;

  return { tools, handlers };
}

/**
 * Generate get_schema tool
 * Uses context getter for dynamic resolution at execution time
 */
function generateGetSchemaTool(
  staticContext: ToolGenerationContext,
  getContext: ToolGenerationContextGetter
): {
  definition: GeneratedToolDefinition;
  handler: ToolHandlerGenerator;
} {
  // Use static context for tool definition (entity names in description)
  const entityNames = staticContext.entities.map(e => e.name);
  const entityListText = entityNames.length > 0 ? entityNames.join(', ') : '(none - no project loaded yet)';

  const description = `Get the complete database schema to understand what data is available.

Returns:
- All entity types (${entityListText})
- Fields for each entity (with types)
- Relationships between entities
- Semantic search indexes (for natural language queries)
- Usage tips

Call this FIRST when you need to understand what data exists and how to query it.
NOTE: If no project is loaded, this will return an empty schema. Use create_project or load_project first.`;

  const definition: GeneratedToolDefinition = {
    name: 'get_schema',
    section: 'rag_ops',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        include_tips: {
          type: 'boolean',
          description: 'Include usage tips for querying (default: true)',
        },
      },
    },
  };

  // Handler returns the schema - uses DYNAMIC context getter
  const handler: ToolHandlerGenerator = (_rag: any) => async (args: Record<string, any>) => {
    // Resolve context dynamically at execution time
    const context = getContext() || EMPTY_CONTEXT;
    const includeTips = args.include_tips !== false;
    return buildSchemaInfo(context, includeTips);
  };

  return { definition, handler };
}

/**
 * Generate describe_entity tool
 * Uses context getter for dynamic resolution at execution time
 */
function generateDescribeEntityTool(
  staticContext: ToolGenerationContext,
  getContext: ToolGenerationContextGetter
): {
  definition: GeneratedToolDefinition;
  handler: ToolHandlerGenerator;
} {
  // Use static context for tool definition
  const entityNames = staticContext.entities.map(e => e.name);
  const entityListText = entityNames.length > 0 ? entityNames.join(', ') : '(none - no project loaded yet)';

  const description = `Get detailed information about a specific entity type.

Available entities: ${entityListText}

Returns all fields, relationships, and semantic indexes for the requested entity.
Use this when you need detailed info about one entity after calling get_schema.`;

  const definition: GeneratedToolDefinition = {
    name: 'describe_entity',
    section: 'rag_ops',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        entity_name: {
          type: 'string',
          // Don't use enum when entities might be empty - allow any string
          description: 'Name of the entity to describe',
        },
      },
      required: ['entity_name'],
    },
  };

  // Handler uses DYNAMIC context getter
  const handler: ToolHandlerGenerator = (_rag: any) => async (args: Record<string, any>) => {
    // Resolve context dynamically at execution time
    const context = getContext() || EMPTY_CONTEXT;
    const { entity_name } = args;
    const entity = context.entities.find(e => e.name === entity_name);

    if (!entity) {
      const available = context.entities.map(e => e.name).join(', ') || '(none - no project loaded)';
      return { error: `Unknown entity: ${entity_name}. Available entities: ${available}` };
    }

    return buildEntitySchemaInfo(entity, context);
  };

  return { definition, handler };
}

/**
 * Build complete schema info from context
 */
function buildSchemaInfo(context: ToolGenerationContext, includeTips: boolean): SchemaInfo {
  const entities = context.entities.map(e => e.name);

  const entity_details: Record<string, EntitySchemaInfo> = {};
  for (const entity of context.entities) {
    entity_details[entity.name] = buildEntitySchemaInfo(entity, context);
  }

  const relationships: RelationshipInfo[] = context.relationships.map(r => ({
    type: r.type,
    from: r.sourceEntity,
    to: r.targetEntity,
    description: r.description,
  }));

  const semantic_indexes: SemanticIndexInfo[] = context.vectorIndexes.map(vi => ({
    name: vi.name,
    entity: vi.entityType,
    source_field: vi.sourceField,
    description: `Semantic search on ${vi.entityType}.${vi.sourceField}`,
  }));

  const usage_tips: string[] = includeTips ? generateUsageTips(context) : [];

  return {
    entities,
    entity_details,
    relationships,
    semantic_indexes,
    usage_tips,
  };
}

/**
 * Build entity schema info
 */
function buildEntitySchemaInfo(entity: EntityMetadata, context: ToolGenerationContext): EntitySchemaInfo {
  const fields: FieldInfo[] = entity.searchableFields.map(f => ({
    name: f.name,
    type: f.type,
    description: f.description,
    is_unique: f.name === entity.uniqueField,
    indexed: f.indexed,
    values: f.values,  // For enum-type fields
  }));

  const computed_fields: FieldInfo[] | undefined = entity.computedFields?.map(cf => ({
    name: cf.name,
    type: cf.type,
    description: cf.description,
  }));

  // Find relationships for this entity
  const outgoing = context.relationships
    .filter(r => r.sourceEntity === entity.name)
    .map(r => `${r.type} -> ${r.targetEntity}`);

  const incoming = context.relationships
    .filter(r => r.targetEntity === entity.name)
    .map(r => `${r.sourceEntity} -> ${r.type}`);

  // Find semantic indexes for this entity
  const entityIndexes = context.vectorIndexes
    .filter(vi => vi.entityType === entity.name)
    .map(vi => vi.name);

  return {
    name: entity.name,
    description: entity.description,
    unique_field: entity.uniqueField,
    display_name_field: entity.displayNameField,
    query_field: entity.queryField,
    content_field: entity.contentField,  // Field with full content (fetch with get_entities_by_ids)
    example_display_fields: entity.exampleDisplayFields?.length ? entity.exampleDisplayFields : undefined,
    fields,
    computed_fields: computed_fields?.length ? computed_fields : undefined,
    has_semantic_search: entityIndexes.length > 0,
    semantic_indexes: entityIndexes.length > 0 ? entityIndexes : undefined,
    outgoing_relationships: outgoing,
    incoming_relationships: incoming,
    hierarchical_content: entity.hierarchicalContent
      ? {
          children_relationship: entity.hierarchicalContent.childrenRelationship,
          include_children: entity.hierarchicalContent.includeChildren,
        }
      : undefined,
  };
}

/**
 * Generate contextual usage tips
 */
function generateUsageTips(context: ToolGenerationContext): string[] {
  const tips: string[] = [];

  // Basic tip
  tips.push('Use query_entities for structured queries with filters (=, CONTAINS, GLOB, REGEX, IN)');

  // Semantic search tip
  if (context.vectorIndexes.length > 0) {
    const indexes = context.vectorIndexes.map(vi => `${vi.entityType}.${vi.sourceField}`);
    tips.push(`Use semantic_search for natural language queries on: ${indexes.join(', ')}`);
    tips.push('IMPORTANT: semantic_search returns metadata + snippet only, NOT full content');
  }

  // Batch fetch tip (most important for agent workflow)
  const entitiesWithContent = context.entities.filter(e => e.contentField);
  if (entitiesWithContent.length > 0) {
    const contentFields = entitiesWithContent.map(e => `${e.name}.${e.contentField}`);
    tips.push(`Use get_entities_by_ids to fetch full content (${contentFields.join(', ')}) after semantic_search`);
    tips.push('Recommended workflow: semantic_search → get_entities_by_ids → answer with actual content');
  }

  // Hierarchical content tip
  const entitiesWithHierarchy = context.entities.filter(e => e.hierarchicalContent);
  if (entitiesWithHierarchy.length > 0) {
    for (const entity of entitiesWithHierarchy) {
      tips.push(`HIERARCHICAL: ${entity.name} content may be split across parent/children. If content_field is short, use explore_relationships with ${entity.hierarchicalContent!.childrenRelationship} (direction: incoming) to fetch children`);
    }
  }

  // Relationship tip
  if (context.relationships.length > 0) {
    tips.push('Use explore_relationships to traverse connections between entities');
  }

  // ID lookup tip
  tips.push('Use get_entity_by_id for a single entity, get_entities_by_ids for multiple');

  return tips;
}
