/**
 * MCP Tool Adapter
 *
 * Converts RagForge GeneratedToolDefinition to MCP Tool format.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { GeneratedToolDefinition } from '@luciformresearch/ragforge';

/**
 * Convert a single RagForge tool to MCP format
 */
export function convertToMcpTool(tool: GeneratedToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema as Tool['inputSchema'],
  };
}

/**
 * Convert multiple RagForge tools to MCP format
 */
export function convertAllTools(tools: GeneratedToolDefinition[]): Tool[] {
  return tools.map(convertToMcpTool);
}

/**
 * Filter tools by sections before converting
 */
export function convertToolsForSections(
  tools: GeneratedToolDefinition[],
  sections?: string[]
): Tool[] {
  if (!sections || sections.length === 0) {
    return convertAllTools(tools);
  }

  const sectionSet = new Set(sections);
  const filtered = tools.filter(t => t.section && sectionSet.has(t.section));
  return convertAllTools(filtered);
}

/**
 * Get tool names grouped by section (for debugging/logging)
 */
export function getToolsBySection(
  tools: GeneratedToolDefinition[]
): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const tool of tools) {
    const section = tool.section || 'uncategorized';
    if (!result[section]) {
      result[section] = [];
    }
    result[section].push(tool.name);
  }

  return result;
}
