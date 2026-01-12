/**
 * Tool Sections - Dynamic tool grouping by section
 *
 * Tools declare their section via the `section` field in GeneratedToolDefinition.
 * This module provides utilities to:
 * 1. Aggregate tools by section from any tool collection
 * 2. Filter tools by requested sections
 * 3. Manage sub-agent depth for recursive delegation
 */

import type { GeneratedToolDefinition, ToolSection } from './types/index.js';

/**
 * Section metadata with human-readable info
 */
export interface SectionInfo {
  id: ToolSection;
  name: string;
  description: string;
}

/**
 * Section definitions with human-readable names and descriptions
 */
export const SECTION_INFO: Record<ToolSection, SectionInfo> = {
  file_ops: {
    id: 'file_ops',
    name: 'File Operations',
    description: 'Read, write, edit files; list, create, delete, move, copy directories and files',
  },
  shell_ops: {
    id: 'shell_ops',
    name: 'Shell Operations',
    description: 'Run shell commands, npm scripts, git operations (status, diff)',
  },
  rag_ops: {
    id: 'rag_ops',
    name: 'Knowledge Graph',
    description: 'Query entities, semantic search, explore relationships in the code graph',
  },
  project_ops: {
    id: 'project_ops',
    name: 'Project Management',
    description: 'Create, setup, load, switch projects; ingest code; manage embeddings',
  },
  web_ops: {
    id: 'web_ops',
    name: 'Web Operations',
    description: 'Search the web, fetch and ingest web pages',
  },
  media_ops: {
    id: 'media_ops',
    name: 'Media Operations',
    description: 'Image OCR/description, 3D asset generation and rendering',
  },
  context_ops: {
    id: 'context_ops',
    name: 'Context Information',
    description: 'Get working directory, environment info, loaded project info',
  },
  planning_ops: {
    id: 'planning_ops',
    name: 'Task Planning',
    description: 'Plan and delegate complex tasks to sub-agents',
  },
};

/**
 * Tools that are always available regardless of section selection
 */
export const ALWAYS_AVAILABLE_SECTIONS: ToolSection[] = ['context_ops'];

/**
 * Maximum sub-agent depth to prevent infinite recursion
 */
export const MAX_SUBAGENT_DEPTH = 3;

/**
 * Aggregate tools by their section
 *
 * @param tools - Array of tool definitions
 * @returns Map of section ID to tools in that section
 */
export function aggregateToolsBySection(
  tools: GeneratedToolDefinition[]
): Map<ToolSection, GeneratedToolDefinition[]> {
  const sections = new Map<ToolSection, GeneratedToolDefinition[]>();

  for (const tool of tools) {
    if (tool.section) {
      const existing = sections.get(tool.section) || [];
      existing.push(tool);
      sections.set(tool.section, existing);
    }
  }

  return sections;
}

/**
 * Get tools filtered by requested sections
 *
 * @param tools - All available tools
 * @param requestedSections - Sections to include (empty = all tools)
 * @param includeAlwaysAvailable - Include ALWAYS_AVAILABLE_SECTIONS (default: true)
 * @returns Filtered array of tools
 */
export function getToolsForSections(
  tools: GeneratedToolDefinition[],
  requestedSections: ToolSection[],
  includeAlwaysAvailable: boolean = true
): GeneratedToolDefinition[] {
  // If no sections requested, return all tools
  if (requestedSections.length === 0) {
    return tools;
  }

  const allowedSections = new Set<ToolSection>(requestedSections);

  // Add always-available sections
  if (includeAlwaysAvailable) {
    for (const section of ALWAYS_AVAILABLE_SECTIONS) {
      allowedSections.add(section);
    }
  }

  return tools.filter(tool => {
    // Tools without section are included only if no filtering
    if (!tool.section) return false;
    return allowedSections.has(tool.section);
  });
}

/**
 * Get section summary for a tool collection
 * Useful for list_tool_sections tool
 *
 * @param tools - Array of tool definitions
 * @returns Array of section info with tool counts and names
 */
export function getSectionSummary(
  tools: GeneratedToolDefinition[]
): Array<SectionInfo & { toolCount: number; toolNames: string[] }> {
  const bySection = aggregateToolsBySection(tools);
  const result: Array<SectionInfo & { toolCount: number; toolNames: string[] }> = [];

  for (const [sectionId, sectionTools] of bySection) {
    const info = SECTION_INFO[sectionId];
    if (info) {
      result.push({
        ...info,
        toolCount: sectionTools.length,
        toolNames: sectionTools.map(t => t.name),
      });
    }
  }

  // Sort by section name
  result.sort((a, b) => a.name.localeCompare(b.name));

  return result;
}

/**
 * Validate that all requested sections exist
 */
export function validateSections(
  sectionIds: string[]
): { valid: boolean; invalid: string[]; validSections: ToolSection[] } {
  const allSections = Object.keys(SECTION_INFO) as ToolSection[];
  const validSections: ToolSection[] = [];
  const invalid: string[] = [];

  for (const id of sectionIds) {
    if (allSections.includes(id as ToolSection)) {
      validSections.push(id as ToolSection);
    } else {
      invalid.push(id);
    }
  }

  return {
    valid: invalid.length === 0,
    invalid,
    validSections,
  };
}

/**
 * Context for sub-agent execution with depth tracking
 */
export interface SubAgentContext {
  /** Current depth (0 = main agent) */
  depth: number;
  /** Maximum allowed depth */
  maxDepth: number;
  /** Goal from parent agent (if any) */
  parentGoal?: string;
  /** Sections available to this sub-agent */
  availableSections?: ToolSection[];
}

/**
 * Check if plan_actions should be exposed at this depth
 */
export function canSpawnSubAgent(context: SubAgentContext): boolean {
  return context.depth < context.maxDepth;
}

/**
 * Create context for a sub-agent spawned from current context
 */
export function createChildContext(
  parentContext: SubAgentContext,
  goal: string,
  sections?: ToolSection[]
): SubAgentContext {
  return {
    depth: parentContext.depth + 1,
    maxDepth: parentContext.maxDepth,
    parentGoal: goal,
    availableSections: sections || parentContext.availableSections,
  };
}

/**
 * Create initial context for the main agent
 */
export function createRootContext(maxDepth: number = MAX_SUBAGENT_DEPTH): SubAgentContext {
  return {
    depth: 0,
    maxDepth,
    availableSections: undefined, // All sections available
  };
}

/**
 * Validate that a tool's section is properly described.
 * Throws at runtime if section is not in SECTION_INFO.
 * (TypeScript already catches this at compile time via Record<ToolSection, SectionInfo>)
 */
export function validateToolSection(tool: GeneratedToolDefinition): void {
  if (tool.section && !SECTION_INFO[tool.section]) {
    throw new Error(
      `Tool "${tool.name}" uses undescribed section "${tool.section}". ` +
      `Add it to SECTION_INFO in tool-sections.ts`
    );
  }
}

/**
 * Validate all tools have described sections.
 * Call this during agent initialization for extra safety.
 */
export function validateAllToolSections(tools: GeneratedToolDefinition[]): void {
  for (const tool of tools) {
    validateToolSection(tool);
  }
}
