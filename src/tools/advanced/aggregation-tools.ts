/**
 * Aggregation Tools Generator
 *
 * Auto-generates tools for aggregating and analyzing entity data
 * COUNT, AVG, SUM, MIN, MAX, GROUP BY operations
 */

import type {
  GeneratedToolDefinition,
  ToolHandlerGenerator,
  ToolGenerationContext,
  FieldMetadata,
} from '../types/index.js';

/**
 * Generate aggregation tools based on config
 * Detects numeric fields for AVG/SUM/MIN/MAX
 */
export function generateAggregationTools(
  context: ToolGenerationContext
): {
  tools: GeneratedToolDefinition[];
  handlers: Record<string, ToolHandlerGenerator>;
} {
  const tools: GeneratedToolDefinition[] = [];
  const handlers: Record<string, ToolHandlerGenerator> = {};

  const entityNames = context.entities.map(e => e.name);

  // Detect numeric fields for aggregations
  const numericFields = new Map<string, FieldMetadata[]>();
  for (const entity of context.entities) {
    const fields = entity.searchableFields.filter(f => f.type === 'number');
    if (fields.length > 0) {
      numericFields.set(entity.name, fields);
    }
  }

  // Tool 1: aggregate_entities (main aggregation tool)
  const aggregateTool = generateAggregateTool(context, numericFields);
  tools.push(aggregateTool);
  handlers[aggregateTool.name] = generateAggregateHandler();

  return { tools, handlers };
}

/**
 * Generate main aggregate_entities tool
 * Supports COUNT, AVG, SUM, MIN, MAX with optional GROUP BY
 */
function generateAggregateTool(
  context: ToolGenerationContext,
  numericFields: Map<string, FieldMetadata[]>
): GeneratedToolDefinition {
  const entityNames = context.entities.map(e => e.name);

  // Build field documentation per entity
  const numericFieldDocs = context.entities
    .filter(e => numericFields.has(e.name))
    .map(entity => {
      const fields = numericFields.get(entity.name)!;
      const fieldList = fields.map(f => `${f.name} (${f.type})`).join(', ');
      return `- ${entity.name}: ${fieldList}`;
    })
    .join('\n');

  // Build groupable fields (all searchable fields can be used for GROUP BY)
  const groupableFieldDocs = context.entities.map(entity => {
    const fields = entity.searchableFields.map(f => f.name).join(', ');
    return `- ${entity.name}: ${fields}`;
  }).join('\n');

  const description = `Aggregate and analyze entities using COUNT, AVG, SUM, MIN, MAX with optional GROUP BY.

Available entity types: ${entityNames.join(', ')}

Numeric fields available for AVG/SUM/MIN/MAX:
${numericFieldDocs || 'No numeric fields found'}

All searchable fields can be used for GROUP BY:
${groupableFieldDocs}

Aggregation functions:
- COUNT - Count total entities (or count per group)
- AVG - Average value of a numeric field
- SUM - Sum of a numeric field
- MIN - Minimum value of a numeric field
- MAX - Maximum value of a numeric field

Use cases:
- Count entities by type: GROUP BY type, COUNT
- Average line count: AVG(line_count)
- Total changes: SUM(change_count)
- Largest functions: MAX(line_count)
- Entities per file: GROUP BY file, COUNT
- Average complexity by type: GROUP BY type, AVG(complexity)

Examples:
- Count all scopes: {entity_type: "Scope", operation: "COUNT"}
- Count by type: {entity_type: "Scope", operation: "COUNT", group_by: "type"}
- Average line count: {entity_type: "Scope", operation: "AVG", field: "line_count"}
- Sum changes by file: {entity_type: "Scope", operation: "SUM", field: "change_count", group_by: "file"}`;

  return {
    name: 'aggregate_entities',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: {
          type: 'string',
          enum: entityNames,
          description: 'Entity type to aggregate',
        },
        operation: {
          type: 'string',
          enum: ['COUNT', 'AVG', 'SUM', 'MIN', 'MAX'],
          description: 'Aggregation operation to perform',
        },
        field: {
          type: 'string',
          description: 'Field to aggregate (required for AVG, SUM, MIN, MAX)',
        },
        group_by: {
          type: 'string',
          description: 'Field to group by (optional)',
        },
        conditions: {
          type: 'array',
          description: 'WHERE conditions to filter before aggregating',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', description: 'Field name' },
              operator: {
                type: 'string',
                enum: ['=', '!=', '>', '>=', '<', '<=', 'CONTAINS', 'STARTS WITH', 'ENDS WITH', 'IN'],
              },
              value: { description: 'Value to compare' },
            },
            required: ['field', 'operator', 'value'],
          },
        },
        limit: {
          type: 'number',
          description: 'Limit results when using GROUP BY (default: 100)',
          default: 100,
        },
      },
      required: ['entity_type', 'operation'],
    },
  };
}

function generateAggregateHandler(): ToolHandlerGenerator {
  return (ragClient: any) => async (args: Record<string, any>) => {
    const { entity_type, operation, field, group_by, conditions, limit } = args;

    // Validate required field for non-COUNT operations
    if (operation !== 'COUNT' && !field) {
      throw new Error(`Field is required for ${operation} operation`);
    }

    // Build Cypher query
    const params: Record<string, any> = {};
    let cypher = `MATCH (n:\`${entity_type}\`)`;

    // Add WHERE conditions
    if (conditions && conditions.length > 0) {
      const whereClauses: string[] = [];
      for (let i = 0; i < conditions.length; i++) {
        const cond = conditions[i];
        const paramName = `param${i}`;

        switch (cond.operator) {
          case '=':
            whereClauses.push(`n.${cond.field} = $${paramName}`);
            params[paramName] = cond.value;
            break;
          case '!=':
            whereClauses.push(`n.${cond.field} <> $${paramName}`);
            params[paramName] = cond.value;
            break;
          case '>':
            whereClauses.push(`n.${cond.field} > $${paramName}`);
            params[paramName] = cond.value;
            break;
          case '>=':
            whereClauses.push(`n.${cond.field} >= $${paramName}`);
            params[paramName] = cond.value;
            break;
          case '<':
            whereClauses.push(`n.${cond.field} < $${paramName}`);
            params[paramName] = cond.value;
            break;
          case '<=':
            whereClauses.push(`n.${cond.field} <= $${paramName}`);
            params[paramName] = cond.value;
            break;
          case 'CONTAINS':
            whereClauses.push(`n.${cond.field} CONTAINS $${paramName}`);
            params[paramName] = cond.value;
            break;
          case 'STARTS WITH':
            whereClauses.push(`n.${cond.field} STARTS WITH $${paramName}`);
            params[paramName] = cond.value;
            break;
          case 'ENDS WITH':
            whereClauses.push(`n.${cond.field} ENDS WITH $${paramName}`);
            params[paramName] = cond.value;
            break;
          case 'IN':
            whereClauses.push(`n.${cond.field} IN $${paramName}`);
            params[paramName] = cond.value;
            break;
        }
      }

      if (whereClauses.length > 0) {
        cypher += `\nWHERE ${whereClauses.join(' AND ')}`;
      }
    }

    // Build aggregation
    let aggregateExpr: string;
    switch (operation) {
      case 'COUNT':
        aggregateExpr = 'count(n)';
        break;
      case 'AVG':
        aggregateExpr = `avg(n.${field})`;
        break;
      case 'SUM':
        aggregateExpr = `sum(n.${field})`;
        break;
      case 'MIN':
        aggregateExpr = `min(n.${field})`;
        break;
      case 'MAX':
        aggregateExpr = `max(n.${field})`;
        break;
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }

    // Add GROUP BY if specified
    if (group_by) {
      cypher += `\nRETURN n.${group_by} AS group_value, ${aggregateExpr} AS result`;
      cypher += `\nORDER BY result DESC`;
      cypher += `\nLIMIT ${limit || 100}`;
    } else {
      cypher += `\nRETURN ${aggregateExpr} AS result`;
    }

    // Execute query
    const result = await ragClient.client.run(cypher, params);

    // Format results
    if (group_by) {
      const groups = result.records.map((record: any) => {
        const resultValue = record.get('result');
        return {
          [group_by]: record.get('group_value'),
          [operation.toLowerCase()]: typeof resultValue === 'object' && resultValue.toNumber
            ? resultValue.toNumber()
            : resultValue,
        };
      });

      return {
        entity_type,
        operation,
        field: field || null,
        group_by,
        total_groups: groups.length,
        groups,
      };
    } else {
      const resultValue = result.records[0]?.get('result');
      const value = typeof resultValue === 'object' && resultValue.toNumber
        ? resultValue.toNumber()
        : resultValue;

      return {
        entity_type,
        operation,
        field: field || null,
        result: value,
      };
    }
  };
}
