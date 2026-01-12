/**
 * Change Tracking Tools Generator
 *
 * Auto-generates tools for tracking code changes and evolution
 * Leverages existing ChangeTracker from runtime package
 */

import type {
  GeneratedToolDefinition,
  ToolHandlerGenerator,
  ToolGenerationContext,
} from '../types/index.js';

/**
 * Generate change tracking tools based on config
 * Only generates if change tracking is enabled for at least one entity
 */
export function generateChangeTrackingTools(
  context: ToolGenerationContext
): {
  tools: GeneratedToolDefinition[];
  handlers: Record<string, ToolHandlerGenerator>;
} {
  const tools: GeneratedToolDefinition[] = [];
  const handlers: Record<string, ToolHandlerGenerator> = {};

  // Check if any entity has change tracking enabled
  const trackedEntities = context.entities.filter(e => e.changeTracking?.enabled);

  if (trackedEntities.length === 0) {
    return { tools, handlers };
  }

  const entityNames = trackedEntities.map(e => e.name);

  // Tool 1: get_entity_change_history
  const historyTool = generateEntityHistoryTool(entityNames);
  tools.push(historyTool);
  handlers[historyTool.name] = generateEntityHistoryHandler();

  // Tool 2: find_recently_modified_entities
  const recentTool = generateRecentChangesTool(entityNames);
  tools.push(recentTool);
  handlers[recentTool.name] = generateRecentChangesHandler();

  // Tool 3: get_most_modified_entities
  const hotspotsTool = generateMostModifiedTool(entityNames);
  tools.push(hotspotsTool);
  handlers[hotspotsTool.name] = generateMostModifiedHandler();

  // Tool 4: get_change_statistics
  const statsTool = generateChangeStatsTool(entityNames);
  tools.push(statsTool);
  handlers[statsTool.name] = generateChangeStatsHandler();

  // Tool 5: get_changes_by_date_range
  const dateRangeTool = generateChangesByDateRangeTool(entityNames);
  tools.push(dateRangeTool);
  handlers[dateRangeTool.name] = generateChangesByDateRangeHandler();

  return { tools, handlers };
}

/**
 * Tool 1: get_entity_change_history
 * View modification history with diffs for a specific entity
 */
function generateEntityHistoryTool(entityNames: string[]): GeneratedToolDefinition {
  return {
    name: 'get_entity_change_history',
    description: `Get the complete change history for a specific entity, including diffs showing what changed.

Available entity types with change tracking: ${entityNames.join(', ')}

Returns:
- Change timestamp
- Change type (created, updated, deleted)
- Unified diff showing added/removed lines
- Lines added/removed counts
- Previous and new content hashes
- Entity metadata (name, file, etc.)

Ordered by most recent changes first.

Use this to:
- See how code has evolved over time
- Review specific changes to a function/class
- Debug when a bug was introduced
- Understand modification patterns`,
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: {
          type: 'string',
          enum: entityNames,
          description: 'Entity type to get history for',
        },
        entity_uuid: {
          type: 'string',
          description: 'Unique identifier of the entity',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of changes to return (default: 10, max: 50)',
          default: 10,
        },
      },
      required: ['entity_type', 'entity_uuid'],
    },
  };
}

function generateEntityHistoryHandler(): ToolHandlerGenerator {
  return (ragClient: any) => async (args: Record<string, any>) => {
    const changeTracker = ragClient.changeTracker;
    if (!changeTracker) {
      throw new Error('Change tracking is not enabled. Enable it in ragforge.config.yaml');
    }

    const limit = Math.min(args.limit || 10, 50);
    const history = await changeTracker.getEntityHistory(args.entity_type, args.entity_uuid, limit);

    return {
      entity_type: args.entity_type,
      entity_uuid: args.entity_uuid,
      total_changes: history.length,
      changes: history.map((c: any) => ({
        timestamp: c.timestamp,
        change_type: c.changeType,
        diff: c.diff,
        lines_added: c.linesAdded,
        lines_removed: c.linesRemoved,
        old_hash: c.oldHash,
        new_hash: c.newHash,
        metadata: c.metadata,
      })),
    };
  };
}

/**
 * Tool 2: find_recently_modified_entities
 * Find entities that were recently modified
 */
function generateRecentChangesTool(entityNames: string[]): GeneratedToolDefinition {
  return {
    name: 'find_recently_modified_entities',
    description: `Find entities that were recently modified across the codebase.

Available entity types with change tracking: ${entityNames.join(', ')}

Returns recent changes ordered by timestamp (most recent first).

Use this to:
- Find what changed recently in the codebase
- Identify active development areas
- Track recent bug fixes or features
- Monitor code churn

Optionally filter by specific entity types.`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of changes to return (default: 20, max: 100)',
          default: 20,
        },
        entity_types: {
          type: 'array',
          items: { type: 'string', enum: entityNames },
          description: 'Filter by specific entity types (optional)',
        },
      },
    },
  };
}

function generateRecentChangesHandler(): ToolHandlerGenerator {
  return (ragClient: any) => async (args: Record<string, any>) => {
    const changeTracker = ragClient.changeTracker;
    if (!changeTracker) {
      throw new Error('Change tracking is not enabled');
    }

    const limit = Math.min(args.limit || 20, 100);
    const changes = await changeTracker.getRecentChanges(limit, args.entity_types);

    return {
      total_changes: changes.length,
      filtered_by: args.entity_types || 'all',
      changes: changes.map((c: any) => ({
        entity_type: c.entityType,
        entity_uuid: c.entityUuid,
        timestamp: c.timestamp,
        change_type: c.changeType,
        lines_added: c.linesAdded,
        lines_removed: c.linesRemoved,
        metadata: c.metadata,
      })),
    };
  };
}

/**
 * Tool 3: get_most_modified_entities
 * Identify code churn hot spots
 */
function generateMostModifiedTool(entityNames: string[]): GeneratedToolDefinition {
  return {
    name: 'get_most_modified_entities',
    description: `Find entities with the most changes (code churn hot spots).

Available entity types with change tracking: ${entityNames.join(', ')}

Returns entities ordered by number of changes (most modified first).

Use this to:
- Identify code churn hot spots
- Find unstable/frequently changing code
- Prioritize refactoring efforts
- Detect areas needing better abstractions
- Find potential bug sources (high churn = higher bug probability)`,
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: {
          type: 'string',
          enum: entityNames,
          description: 'Entity type to analyze',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of entities to return (default: 10, max: 50)',
          default: 10,
        },
      },
      required: ['entity_type'],
    },
  };
}

function generateMostModifiedHandler(): ToolHandlerGenerator {
  return (ragClient: any) => async (args: Record<string, any>) => {
    const changeTracker = ragClient.changeTracker;
    if (!changeTracker) {
      throw new Error('Change tracking is not enabled');
    }

    const limit = Math.min(args.limit || 10, 50);
    const entities = await changeTracker.getMostModifiedEntities(args.entity_type, limit);

    return {
      entity_type: args.entity_type,
      total_entities: entities.length,
      hot_spots: entities.map((e: any) => ({
        entity_uuid: e.entityUuid,
        change_count: e.changeCount,
        metadata: e.metadata,
      })),
    };
  };
}

/**
 * Tool 4: get_change_statistics
 * Aggregate change metrics
 */
function generateChangeStatsTool(entityNames: string[]): GeneratedToolDefinition {
  return {
    name: 'get_change_statistics',
    description: `Get aggregate statistics about code changes.

Available entity types with change tracking: ${entityNames.join(', ')}

Returns:
- Total number of changes
- Changes by type (created, updated, deleted)
- Changes by entity type
- Total lines added/removed
- Code churn metrics

Use this to:
- Get a high-level overview of code evolution
- Measure development velocity
- Track code growth vs reduction
- Compare activity across different parts of codebase`,
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: {
          type: 'string',
          enum: entityNames,
          description: 'Filter by specific entity type (optional)',
        },
      },
    },
  };
}

function generateChangeStatsHandler(): ToolHandlerGenerator {
  return (ragClient: any) => async (args: Record<string, any>) => {
    const changeTracker = ragClient.changeTracker;
    if (!changeTracker) {
      throw new Error('Change tracking is not enabled');
    }

    const stats = await changeTracker.getChangeStats(args.entity_type);

    return {
      filtered_by: args.entity_type || 'all',
      total_changes: stats.totalChanges,
      changes_by_type: stats.byType,
      changes_by_entity_type: stats.byEntityType,
      total_lines_added: stats.totalLinesAdded,
      total_lines_removed: stats.totalLinesRemoved,
      net_lines: stats.totalLinesAdded - stats.totalLinesRemoved,
    };
  };
}

/**
 * Tool 5: get_changes_by_date_range
 * Get changes within a specific time period
 */
function generateChangesByDateRangeTool(entityNames: string[]): GeneratedToolDefinition {
  return {
    name: 'get_changes_by_date_range',
    description: `Get all changes within a specific date range.

Available entity types with change tracking: ${entityNames.join(', ')}

Returns changes that occurred between start and end dates.

Use this to:
- Analyze changes during a sprint/iteration
- Review changes for a release
- Investigate changes around a specific incident
- Generate change logs
- Track development activity over time

Date format: ISO 8601 (e.g., "2024-01-15T10:30:00Z" or "2024-01-15")`,
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: 'Start date (ISO 8601 format)',
        },
        end_date: {
          type: 'string',
          description: 'End date (ISO 8601 format)',
        },
        entity_type: {
          type: 'string',
          enum: entityNames,
          description: 'Filter by specific entity type (optional)',
        },
      },
      required: ['start_date', 'end_date'],
    },
  };
}

function generateChangesByDateRangeHandler(): ToolHandlerGenerator {
  return (ragClient: any) => async (args: Record<string, any>) => {
    const changeTracker = ragClient.changeTracker;
    if (!changeTracker) {
      throw new Error('Change tracking is not enabled');
    }

    const startDate = new Date(args.start_date);
    const endDate = new Date(args.end_date);

    const changes = await changeTracker.getChangesByDateRange(startDate, endDate, args.entity_type);

    return {
      start_date: args.start_date,
      end_date: args.end_date,
      filtered_by: args.entity_type || 'all',
      total_changes: changes.length,
      changes: changes.map((c: any) => ({
        entity_type: c.entityType,
        entity_uuid: c.entityUuid,
        timestamp: c.timestamp,
        change_type: c.changeType,
        lines_added: c.linesAdded,
        lines_removed: c.linesRemoved,
        metadata: c.metadata,
      })),
    };
  };
}
