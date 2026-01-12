/**
 * Brain Search Formatter
 *
 * Formats brain_search output as markdown for better readability.
 * Uses FIELD_MAPPING from node-schema.ts for consistent field extraction.
 *
 * @since 2025-12-20
 */

import {
  FIELD_MAPPING,
  getNodeTitle,
  getNodeContent,
  getNodeDescription,
  getNodeLocation,
  getNodeLineRange,
  formatNodeLocation,
} from '../../utils/node-schema.js';

/**
 * Input format for the formatter - matches brain_search output
 * Test comment for cleanup verification v5
 */
export interface BrainSearchOutput {
  results: Array<{
    node: Record<string, any>;
    score: number;
    projectId: string;
    projectPath: string;
    filePath: string;
    fileLineCount?: number;
    matchedRange?: {
      startLine: number;
      endLine: number;
      startChar: number;
      endChar: number;
      chunkIndex: number;
      chunkScore: number;
    };
  }>;
  totalCount: number;
  searchedProjects: string[];
  graph?: {
    nodes: Array<{
      uuid: string;
      name: string;
      type: string;
      file?: string;
      startLine?: number;
      endLine?: number;
      score: number | null;
      isSearchResult: boolean;
    }>;
    edges: Array<{
      from: string;
      to: string;
      type: string;
    }>;
  };
  summary?: {
    snippets: Array<{
      uuid: string;
      file: string;
      lines: string;
      content: string;
      relevance: string;
    }>;
    findings: string;
    suggestions?: Array<{ type: string; target: string; reason: string }>;
  };
}

/**
 * Search parameters used for the query (for diagnostic purposes)
 */
export interface SearchParams {
  query: string;
  semantic?: boolean;
  embedding_type?: string;
  types?: string[];
  projects?: string[];
  glob?: string;
  base_path?: string;
  limit?: number;
  min_score?: number;
  boost_keywords?: string[];
  boost_weight?: number;
  explore_depth?: number;
  use_reranking?: boolean;
  fuzzy_distance?: number;
}

/**
 * Options for formatting
 */
export interface FormatOptions {
  /** Include source code in output (default: true for first 5 results) */
  includeSource?: boolean;
  /** Maximum number of results to include source for (default: 5) */
  maxSourceResults?: number;
  /** Maximum lines of source to show per result (default: 20) */
  maxSourceLines?: number;
  /** Include the graph as ASCII tree (default: true) */
  includeGraph?: boolean;
  /** Maximum depth for ASCII tree (default: 2) */
  maxGraphDepth?: number;
  /** Include raw JSON in collapsible section (default: false) */
  includeRawJson?: boolean;
  /** Search parameters used (for diagnostic display) */
  searchParams?: SearchParams;
}

/**
 * Format brain_search results as compact markdown.
 */
export function formatAsMarkdown(
  output: BrainSearchOutput,
  query: string,
  options: FormatOptions = {}
): string {
  const {
    includeSource = true,
    maxSourceResults = 5,
    maxSourceLines = 20,
    includeGraph = true,
    maxGraphDepth = 2,
    includeRawJson = false,
    searchParams,
  } = options;

  const lines: string[] = [];

  // Header
  lines.push(`# Brain Search: "${query}"`);
  lines.push('');
  lines.push(`**Results:** ${output.results.length} / ${output.totalCount}`);
  lines.push(`**Projects:** ${output.searchedProjects.join(', ') || 'all'}`);

  // Search parameters (for diagnostics)
  if (searchParams) {
    lines.push('');
    lines.push('**Parameters:**');
    const paramParts: string[] = [];
    if (searchParams.semantic !== undefined) paramParts.push(`semantic=${searchParams.semantic}`);
    if (searchParams.embedding_type) paramParts.push(`embedding=${searchParams.embedding_type}`);
    if (searchParams.types?.length) paramParts.push(`types=[${searchParams.types.join(', ')}]`);
    if (searchParams.limit) paramParts.push(`limit=${searchParams.limit}`);
    if (searchParams.min_score) paramParts.push(`min_score=${searchParams.min_score}`);
    if (searchParams.explore_depth) paramParts.push(`explore_depth=${searchParams.explore_depth}`);
    if (searchParams.boost_keywords?.length) paramParts.push(`boost_keywords=[${searchParams.boost_keywords.join(', ')}]`);
    if (searchParams.boost_weight) paramParts.push(`boost_weight=${searchParams.boost_weight}`);
    if (searchParams.use_reranking) paramParts.push(`reranking=true`);
    if (searchParams.fuzzy_distance !== undefined) paramParts.push(`fuzzy=${searchParams.fuzzy_distance}`);
    if (searchParams.glob) paramParts.push(`glob="${searchParams.glob}"`);
    if (searchParams.base_path) paramParts.push(`base_path="${searchParams.base_path}"`);
    lines.push(paramParts.join(' | ') || '_defaults_');
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // Results
  lines.push('## Results');
  lines.push('');

  for (let i = 0; i < output.results.length; i++) {
    const result = output.results[i];
    const node = result.node;
    const nodeType = getNodeType(node);

    // Title line with score
    const title = getNodeTitle(node, nodeType) || node.name || 'Untitled';
    const scoreStr = result.score.toFixed(2);
    lines.push(`### ${i + 1}. ${truncate(title, 80)} (${nodeType}) ★ ${scoreStr}`);

    // Location
    const location = formatNodeLocation(node, nodeType);
    lines.push(`📍 \`${location}\``);

    // Description if available and not null
    const description = getNodeDescription(node, nodeType);
    if (description) {
      lines.push(`📝 ${truncate(description, 200)}`);
    }

    // Source/content if requested (only for first maxSourceResults)
    if (includeSource && i < maxSourceResults) {
      const content = getNodeContent(node, nodeType);
      if (content) {
        const contentLines = content.split('\n');
        const truncatedContent = contentLines.slice(0, maxSourceLines).join('\n');
        // Detect language from file path, fallback to node.language
        const lang = detectLanguage(result.filePath || node.file || node.absolutePath) || node.language || '';
        lines.push('');
        lines.push('```' + lang);
        lines.push(truncatedContent);
        if (contentLines.length > maxSourceLines) {
          lines.push(`... (${contentLines.length - maxSourceLines} more lines)`);
        }
        lines.push('```');
      }
    }

    lines.push('');
  }

  // Graph as ASCII tree
  if (includeGraph && output.graph && output.graph.nodes.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Dependency Graph');
    lines.push('');
    lines.push('```');
    lines.push(buildAsciiTree(output.graph, output.results, maxGraphDepth));
    lines.push('```');
    lines.push('');
  }

  // Summary if available
  if (output.summary) {
    lines.push('---');
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push(output.summary.findings);
    lines.push('');

    if (output.summary.suggestions && output.summary.suggestions.length > 0) {
      lines.push('### Suggestions');
      lines.push('');
      for (const suggestion of output.summary.suggestions) {
        lines.push(`- **${suggestion.type}**: ${suggestion.target} - ${suggestion.reason}`);
      }
      lines.push('');
    }
  }

  // Node type summary
  lines.push('---');
  lines.push('');
  lines.push('## Node Types Summary');
  lines.push('');
  const typeCounts = countNodeTypes(output.results);
  lines.push('| Type | Count |');
  lines.push('|------|-------|');
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${type} | ${count} |`);
  }
  lines.push('');

  // Raw JSON if requested
  if (includeRawJson) {
    lines.push('---');
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>Raw JSON (click to expand)</summary>');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(output, null, 2));
    lines.push('```');
    lines.push('</details>');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format brain_search results as compact JSON.
 * Removes redundant fields and uses FIELD_MAPPING for consistent output.
 */
export function formatAsCompact(output: BrainSearchOutput, query: string): object {
  return {
    query,
    totalCount: output.totalCount,
    projects: output.searchedProjects,
    results: output.results.map((r) => {
      const nodeType = getNodeType(r.node);
      return {
        uuid: r.node.uuid,
        type: nodeType,
        title: getNodeTitle(r.node, nodeType),
        location: getNodeLocation(r.node, nodeType),
        lines: getNodeLineRange(r.node),
        score: r.score,
        // Only include non-null fields
        ...(getNodeDescription(r.node, nodeType) && {
          description: truncate(getNodeDescription(r.node, nodeType)!, 200),
        }),
      };
    }),
    graph: output.graph
      ? {
          nodeCount: output.graph.nodes.length,
          edgeCount: output.graph.edges.length,
          // Compact edge representation: "from→TYPE→to"
          edges: output.graph.edges.map(
            (e) => `${e.from.substring(0, 8)}→${e.type}→${e.to.substring(0, 8)}`
          ),
        }
      : undefined,
  };
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Get the node type (label) from a node object.
 * Nodes have a 'labels' array, we use the first non-generic one.
 */
function getNodeType(node: Record<string, any>): string {
  if (node.labels && Array.isArray(node.labels)) {
    // Prefer specific labels over generic ones
    const specificLabels = node.labels.filter(
      (l: string) => !['Node', 'ContentNode'].includes(l)
    );
    if (specificLabels.length > 0) {
      return specificLabels[0];
    }
    return node.labels[0] || 'Unknown';
  }
  // Fallback: try to infer from type field
  return node.type || 'Unknown';
}

/**
 * Count node types in results
 */
function countNodeTypes(results: BrainSearchOutput['results']): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    const type = getNodeType(result.node);
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

/**
 * Truncate a string to a maximum length
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

/**
 * Detect programming language from file path extension
 */
function detectLanguage(filePath: string | null | undefined): string {
  if (!filePath) return '';

  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  const langMap: Record<string, string> = {
    // TypeScript/JavaScript
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    // Python
    py: 'python',
    pyi: 'python',
    pyx: 'python',
    // Web
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',
    // Data
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    xml: 'xml',
    // Shell
    sh: 'bash',
    bash: 'bash',
    zsh: 'zsh',
    fish: 'fish',
    // Systems
    rs: 'rust',
    go: 'go',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    java: 'java',
    kt: 'kotlin',
    scala: 'scala',
    cs: 'csharp',
    fs: 'fsharp',
    swift: 'swift',
    // Config
    md: 'markdown',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    // Other
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    r: 'r',
    rb: 'ruby',
    php: 'php',
    lua: 'lua',
    vim: 'vim',
    vue: 'vue',
    svelte: 'svelte',
  };

  return langMap[ext] || ext;
}

/**
 * Build an ASCII tree representation of the dependency graph.
 * - Filters out internal types (EmbeddingChunk, HAS_EMBEDDING_CHUNK)
 * - Adds CONSUMED_BY as reverse of CONSUMES edges
 * - Only shows edge types that have renderable children
 */
function buildAsciiTree(
  graph: NonNullable<BrainSearchOutput['graph']>,
  results: BrainSearchOutput['results'],
  maxDepth: number
): string {
  if (graph.nodes.length === 0) return '(empty graph)';

  // Skip relationships that are redundant (file/project info already shown in node line)
  const SKIP_EDGE_TYPES = new Set(['HAS_EMBEDDING_CHUNK', 'DEFINED_IN', 'BELONGS_TO', 'IN_DIRECTORY']);
  const SKIP_NODE_TYPES = new Set(['EmbeddingChunk', 'File', 'Directory', 'Project']);

  // Build lookup maps
  const nodeMap = new Map(graph.nodes.map((n) => [n.uuid, n]));
  const edgesByFrom = new Map<string, typeof graph.edges>();

  // Process edges and add reverse CONSUMED_BY edges
  for (const edge of graph.edges) {
    if (SKIP_EDGE_TYPES.has(edge.type)) continue;

    // Add original edge
    if (!edgesByFrom.has(edge.from)) edgesByFrom.set(edge.from, []);
    edgesByFrom.get(edge.from)!.push(edge);

    // Add reverse edge for CONSUMES → CONSUMED_BY
    if (edge.type === 'CONSUMES') {
      const reverseEdge = { from: edge.to, to: edge.from, type: 'CONSUMED_BY' };
      if (!edgesByFrom.has(edge.to)) edgesByFrom.set(edge.to, []);
      edgesByFrom.get(edge.to)!.push(reverseEdge);
    }
  }

  // Find root nodes (search results)
  const rootUuids = results.map((r) => r.node.uuid);
  const visited = new Set<string>();
  const lines: string[] = [];

  // Render each root
  for (const rootUuid of rootUuids) {
    const rootNode = nodeMap.get(rootUuid);
    if (!rootNode) continue;

    lines.push(...renderNode(rootNode, '', true, 0));
  }

  /**
   * Check if a node can be rendered (not visited, not skipped)
   */
  function canRender(uuid: string): boolean {
    if (visited.has(uuid)) return false;
    const node = nodeMap.get(uuid);
    if (!node) return false;
    if (SKIP_NODE_TYPES.has(node.type)) return false;
    return true;
  }

  function renderNode(
    node: typeof graph.nodes[0],
    prefix: string,
    isLast: boolean,
    depth: number
  ): string[] {
    if (depth > maxDepth || visited.has(node.uuid)) {
      return [];
    }
    visited.add(node.uuid);

    const result: string[] = [];
    const connector = depth === 0 ? '' : isLast ? '└── ' : '├── ';
    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '    ' : '│   ');

    // Node line with location info (file:startLine-endLine or file:startLine)
    const scoreStr = node.score !== null ? ` ★${node.score.toFixed(1)}` : '';
    let fileInfo = '';
    if (node.file) {
      const lineInfo = node.startLine
        ? node.endLine && node.endLine !== node.startLine
          ? `:${node.startLine}-${node.endLine}`
          : `:${node.startLine}`
        : '';
      fileInfo = ` @ ${node.file}${lineInfo}`;
    }
    result.push(`${prefix}${connector}${node.name} (${node.type})${scoreStr}${fileInfo}`);

    // Get outgoing edges grouped by type
    const outEdges = edgesByFrom.get(node.uuid) || [];
    const edgesByType = new Map<string, typeof outEdges>();
    for (const edge of outEdges) {
      if (!edgesByType.has(edge.type)) edgesByType.set(edge.type, []);
      edgesByType.get(edge.type)!.push(edge);
    }

    // Get edge types (we'll filter during rendering to handle visited nodes)
    const edgeTypes = Array.from(edgesByType.keys());

    // Collect all renderable edge type groups first, then render
    // This ensures we know which is truly "last" for proper tree drawing
    const renderedGroups: Array<{ type: string; lines: string[] }> = [];

    for (const edgeType of edgeTypes) {
      const edges = edgesByType.get(edgeType)!;

      // Filter to edges with renderable children (check NOW, not earlier)
      const renderableEdges = edges.filter(e => canRender(e.to));
      if (renderableEdges.length === 0) continue;

      const groupLines: string[] = [];
      groupLines.push(`[${edgeType}]`);

      // Render child nodes
      for (let j = 0; j < renderableEdges.length; j++) {
        const edge = renderableEdges[j];
        const childNode = nodeMap.get(edge.to);
        if (!childNode) continue;

        const isLastChild = j === renderableEdges.length - 1;
        // Use temporary prefix, we'll fix it when we know the final structure
        groupLines.push(...renderNode(childNode, '    ', isLastChild, depth + 1));
      }

      // Only add if we actually rendered children (not just the label)
      if (groupLines.length > 1) {
        renderedGroups.push({ type: edgeType, lines: groupLines });
      }
    }

    // Now add the groups with correct prefixes
    for (let i = 0; i < renderedGroups.length; i++) {
      const group = renderedGroups[i];
      const isLastType = i === renderedGroups.length - 1;
      const typeConnector = isLastType ? '└── ' : '├── ';
      const typePrefix = childPrefix + (isLastType ? '    ' : '│   ');

      // First line is the edge type label
      result.push(`${childPrefix}${typeConnector}${group.lines[0]}`);

      // Remaining lines are child nodes - fix their prefixes
      for (let j = 1; j < group.lines.length; j++) {
        result.push(typePrefix + group.lines[j]);
      }
    }

    return result;
  }

  return lines.join('\n') || '(no connections)';
}
