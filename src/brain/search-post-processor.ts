/**
 * Search Post-Processor
 *
 * Shared post-processing logic for search results.
 * Used by both brain-tools.ts (CLI/MCP) and community-docs API.
 *
 * Features:
 * - Keyword boosting with Levenshtein similarity
 * - Relationship exploration (explore_depth)
 * - LLM-based summarization
 * - LLM-based reranking
 *
 * @since 2025-01-04
 */

import type { Neo4jClient } from '../runtime/client/neo4j-client.js';
import neo4j from 'neo4j-driver';

// ============================================================================
// Types
// ============================================================================

/**
 * Generic search result that can be processed by the post-processor.
 * Compatible with both BrainSearchResult and ServiceSearchResult.
 */
export interface ProcessableSearchResult {
  node: Record<string, any>;
  score: number;
  filePath?: string;
  [key: string]: any;
}

/**
 * Options for keyword boosting
 */
export interface KeywordBoostOptions {
  /** Keywords to boost results for */
  keywords: string[];
  /** Maximum score boost per keyword match (default: 0.15) */
  boostWeight?: number;
  /** Minimum similarity threshold (default: 0.6) */
  minSimilarity?: number;
}

/**
 * Result with keyword boost info
 */
export interface KeywordBoostResult<T extends ProcessableSearchResult> {
  result: T;
  keywordBoost?: {
    keyword: string;
    similarity: number;
    boost: number;
  };
}

/**
 * Options for relationship exploration
 */
export interface ExploreRelationshipsOptions {
  /** Neo4j client for querying relationships */
  neo4jClient: Neo4jClient;
  /** Exploration depth (1-3) */
  depth: number;
  /** Maximum results to explore (default: 10) */
  maxToExplore?: number;
  /** Maximum relationships per node (default: 15) */
  maxRelationshipsPerNode?: number;
}

/**
 * Graph node from relationship exploration
 */
export interface GraphNode {
  uuid: string;
  name: string;
  type: string;
  file?: string;
  signature?: string;
  docstring?: string;
  startLine?: number;
  endLine?: number;
  absolutePath?: string;
  relativePath?: string;
  parentUuid?: string;
  parentLabel?: string;
  score: number | null;
  isSearchResult: boolean;
}

/**
 * Graph edge from relationship exploration
 */
export interface GraphEdge {
  from: string;
  to: string;
  type: string;
}

/**
 * Result of relationship exploration
 */
export interface ExplorationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Options for LLM summarization
 */
export interface SummarizeOptions {
  /** Search query for context */
  query: string;
  /** Additional context for summarization */
  context?: string;
  /** Gemini API key */
  apiKey: string;
}

/**
 * Summarization result
 */
export interface SummaryResult {
  snippets: Array<{
    uuid: string;
    file: string;
    lines: string;
    content: string;
    relevance: string;
  }>;
  findings: string;
  suggestions?: Array<{
    type: string;
    target: string;
    reason: string;
  }>;
}

/**
 * Options for LLM reranking
 */
export interface RerankOptions {
  /** Search query */
  query: string;
  /** Gemini API key */
  apiKey: string;
  /** Batch size for reranking (default: 100) */
  batchSize?: number;
  /** Parallel requests (default: 5) */
  parallel?: number;
  /** Vector weight for score merging (default: 0.3) */
  vectorWeight?: number;
  /** LLM weight for score merging (default: 0.7) */
  llmWeight?: number;
  /** Additional context for reranking */
  context?: string;
  /** Projects being searched */
  projects?: string[];
}

/**
 * Reranking result
 */
export interface RerankResult<T extends ProcessableSearchResult> {
  results: T[];
  evaluationCount: number;
}

// ============================================================================
// Keyword Boosting
// ============================================================================

/**
 * Apply keyword boosting with Levenshtein similarity to search results.
 *
 * @param results - Search results to boost
 * @param options - Boost options
 * @returns Results with boost info, sorted by score descending
 */
export async function applyKeywordBoost<T extends ProcessableSearchResult>(
  results: T[],
  options: KeywordBoostOptions
): Promise<KeywordBoostResult<T>[]> {
  if (!options.keywords || options.keywords.length === 0 || results.length === 0) {
    return results.map(r => ({ result: r }));
  }

  const { distance } = await import('fastest-levenshtein');
  const boostWeight = options.boostWeight ?? 0.15;
  const minSimilarity = options.minSimilarity ?? 0.6;

  // Helper to calculate Levenshtein similarity (0-1 scale)
  const levenshteinSimilarity = (a: string, b: string): number => {
    if (!a || !b) return 0;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    const dist = distance(a.toLowerCase(), b.toLowerCase());
    return 1 - dist / maxLen;
  };

  // Helper to find best keyword match in a text
  const findBestKeywordMatch = (text: string, keywords: string[]): { keyword: string; similarity: number } => {
    let bestMatch = { keyword: '', similarity: 0 };
    if (!text) return bestMatch;

    const textLower = text.toLowerCase();

    for (const keyword of keywords) {
      const keywordLower = keyword.toLowerCase();

      // Check for exact substring match first (highest priority)
      if (textLower.includes(keywordLower)) {
        return { keyword, similarity: 1.0 };
      }

      // Otherwise, check Levenshtein similarity with each word in text
      const words = text.split(/[\s\.\-_\/\\:,;()\[\]{}]+/).filter(w => w.length > 2);
      for (const word of words) {
        const sim = levenshteinSimilarity(word, keyword);
        if (sim > bestMatch.similarity) {
          bestMatch = { keyword, similarity: sim };
        }
      }
    }

    return bestMatch;
  };

  // Apply boost to each result
  const boostedResults: KeywordBoostResult<T>[] = results.map(r => {
    const node = r.node;

    // Check name, file, path, title for keyword matches
    const fieldsToCheck = [
      node.name,
      node.file,
      node.path,
      node.title,
      node.signature,
    ].filter(Boolean);

    let maxBoost = 0;
    let matchedKeyword = '';
    let matchSimilarity = 0;

    for (const field of fieldsToCheck) {
      const match = findBestKeywordMatch(field as string, options.keywords);
      if (match.similarity >= minSimilarity) {
        const boost = match.similarity * boostWeight;
        if (boost > maxBoost) {
          maxBoost = boost;
          matchedKeyword = match.keyword;
          matchSimilarity = match.similarity;
        }
      }
    }

    if (maxBoost > 0) {
      return {
        result: {
          ...r,
          score: r.score + maxBoost,
        } as T,
        keywordBoost: {
          keyword: matchedKeyword,
          similarity: matchSimilarity,
          boost: maxBoost,
        },
      };
    }

    return { result: r };
  });

  // Sort by score descending
  boostedResults.sort((a, b) => b.result.score - a.result.score);

  return boostedResults;
}

// ============================================================================
// Relationship Exploration
// ============================================================================

/**
 * Explore relationships for search results and build a graph.
 *
 * @param results - Search results to explore
 * @param options - Exploration options
 * @returns Graph with nodes and edges
 */
export async function exploreRelationships<T extends ProcessableSearchResult>(
  results: T[],
  options: ExploreRelationshipsOptions
): Promise<ExplorationGraph | undefined> {
  if (!options.neo4jClient || options.depth <= 0 || results.length === 0) {
    return undefined;
  }

  const clampedDepth = Math.min(Math.max(options.depth, 1), 3);
  const maxToExplore = options.maxToExplore ?? 10;
  const maxRelationshipsPerNode = options.maxRelationshipsPerNode ?? 15;

  // Deduplicated graph structure
  const graphNodes = new Map<string, GraphNode>();
  const graphEdges = new Map<string, GraphEdge>();

  // Add search results as nodes first (they have scores)
  const limitedResults = results.slice(0, maxToExplore);
  for (const r of limitedResults) {
    const nodeUuid = r.node?.uuid;
    if (!nodeUuid) continue;

    // Add this result to graph nodes
    // Note: MarkdownSection uses 'title' not 'name', and type comes from labels array
    graphNodes.set(nodeUuid, {
      uuid: nodeUuid,
      name: r.node?.name || r.node?.title || r.node?.heading || r.node?.signature || 'unnamed',
      type: r.node?.type || r.node?.nodeType || r.node?.labels?.[0] || 'unknown',
      file: r.node?.absolutePath || r.node?.file,
      startLine: r.node?.startLine,
      endLine: r.node?.endLine,
      score: r.score,
      isSearchResult: true,
    });
  }

  // Explore relationships for each search result
  const nodesToExplore: Array<{ uuid: string; currentDepth: number }> = [];
  for (const [uuid] of graphNodes) {
    nodesToExplore.push({ uuid, currentDepth: 0 });
  }
  const exploredUuids = new Set<string>();

  while (nodesToExplore.length > 0) {
    const { uuid: nodeUuid, currentDepth } = nodesToExplore.shift()!;

    if (exploredUuids.has(nodeUuid) || currentDepth >= clampedDepth) continue;
    exploredUuids.add(nodeUuid);

    try {
      // Query outgoing and incoming relationships with full node properties
      const queries = [
        {
          query: `
            MATCH (n {uuid: $uuid})-[rel]->(related)
            RETURN type(rel) as relationType,
                   related.uuid as relatedUuid,
                   coalesce(related.name, related.title, related.signature) as relatedName,
                   coalesce(related.type, labels(related)[0]) as relatedType,
                   coalesce(related.absolutePath, related.file) as relatedFile,
                   related.signature as relatedSignature,
                   related.docstring as relatedDocstring,
                   related.startLine as relatedStartLine,
                   related.endLine as relatedEndLine,
                   related.absolutePath as relatedAbsolutePath,
                   related.relativePath as relatedRelativePath,
                   related.parentUuid as relatedParentUuid,
                   related.parentLabel as relatedParentLabel
            LIMIT $limit
          `,
          isOutgoing: true,
        },
        {
          query: `
            MATCH (n {uuid: $uuid})<-[rel]-(related)
            RETURN type(rel) as relationType,
                   related.uuid as relatedUuid,
                   coalesce(related.name, related.title, related.signature) as relatedName,
                   coalesce(related.type, labels(related)[0]) as relatedType,
                   coalesce(related.absolutePath, related.file) as relatedFile,
                   related.signature as relatedSignature,
                   related.docstring as relatedDocstring,
                   related.startLine as relatedStartLine,
                   related.endLine as relatedEndLine,
                   related.absolutePath as relatedAbsolutePath,
                   related.relativePath as relatedRelativePath,
                   related.parentUuid as relatedParentUuid,
                   related.parentLabel as relatedParentLabel
            LIMIT $limit
          `,
          isOutgoing: false,
        },
      ];

      for (const { query, isOutgoing } of queries) {
        const relResult = await options.neo4jClient.run(query, { uuid: nodeUuid, limit: neo4j.int(maxRelationshipsPerNode) });
        for (const record of relResult.records) {
          const relationType = record.get('relationType') as string;
          const relatedUuid = record.get('relatedUuid') as string;
          const relatedName = (record.get('relatedName') as string) || 'unnamed';
          const relatedType = (record.get('relatedType') as string) || 'unknown';
          const relatedFile = record.get('relatedFile') as string | undefined;
          const relatedSignature = record.get('relatedSignature') as string | undefined;
          const relatedDocstring = record.get('relatedDocstring') as string | undefined;
          const relatedStartLine = record.get('relatedStartLine') as number | undefined;
          const relatedEndLine = record.get('relatedEndLine') as number | undefined;
          const relatedAbsolutePath = record.get('relatedAbsolutePath') as string | undefined;
          const relatedRelativePath = record.get('relatedRelativePath') as string | undefined;
          const relatedParentUuid = record.get('relatedParentUuid') as string | undefined;
          const relatedParentLabel = record.get('relatedParentLabel') as string | undefined;

          // Add related node if not already present
          if (!graphNodes.has(relatedUuid)) {
            graphNodes.set(relatedUuid, {
              uuid: relatedUuid,
              name: relatedName,
              type: relatedType,
              file: relatedFile,
              signature: relatedSignature,
              docstring: relatedDocstring,
              startLine: relatedStartLine,
              endLine: relatedEndLine,
              absolutePath: relatedAbsolutePath,
              relativePath: relatedRelativePath,
              parentUuid: relatedParentUuid,
              parentLabel: relatedParentLabel,
              score: null,
              isSearchResult: false,
            });
          }

          // Add edge (deduplicated by from+to+type)
          const fromUuid = isOutgoing ? nodeUuid : relatedUuid;
          const toUuid = isOutgoing ? relatedUuid : nodeUuid;
          const edgeKey = `${fromUuid}|${toUuid}|${relationType}`;
          if (!graphEdges.has(edgeKey)) {
            graphEdges.set(edgeKey, {
              from: fromUuid,
              to: toUuid,
              type: relationType,
            });
          }

          // Queue for deeper exploration if needed
          if (currentDepth + 1 < clampedDepth && !exploredUuids.has(relatedUuid)) {
            nodesToExplore.push({ uuid: relatedUuid, currentDepth: currentDepth + 1 });
          }
        }
      }
    } catch (err: any) {
      // Log warning but continue
      console.warn(`[SearchPostProcessor] Failed to explore relationships for ${nodeUuid}: ${err.message}`);
    }
  }

  // Build final graph structure
  // Sort nodes: search results first (by score desc), then discovered nodes
  const sortedNodes = Array.from(graphNodes.values()).sort((a, b) => {
    if (a.isSearchResult && !b.isSearchResult) return -1;
    if (!a.isSearchResult && b.isSearchResult) return 1;
    if (a.score !== null && b.score !== null) return b.score - a.score;
    return 0;
  });

  // Remove undefined fields from nodes
  for (const node of sortedNodes) {
    for (const key of Object.keys(node)) {
      if ((node as any)[key] === undefined) {
        delete (node as any)[key];
      }
    }
  }

  return {
    nodes: sortedNodes,
    edges: Array.from(graphEdges.values()),
  };
}

// ============================================================================
// LLM Summarization
// ============================================================================

/**
 * Summarize search results using LLM to extract relevant snippets.
 *
 * @param results - Search results to summarize
 * @param options - Summarization options
 * @returns Summary with snippets and findings
 */
export async function summarizeSearchResults<T extends ProcessableSearchResult>(
  results: T[],
  options: SummarizeOptions
): Promise<SummaryResult> {
  if (!options.apiKey) {
    throw new Error('GEMINI_API_KEY required for search result summarization');
  }

  if (results.length === 0) {
    return {
      snippets: [],
      findings: 'No results to summarize.',
    };
  }

  const { StructuredLLMExecutor, GeminiAPIProvider } = await import('../runtime/index.js');

  const llmProvider = new GeminiAPIProvider({
    apiKey: options.apiKey,
    model: 'gemini-2.0-flash',
    temperature: 0.3,
    maxOutputTokens: 32000,
  });

  const executor = new StructuredLLMExecutor();

  // Format results for the LLM
  const formattedResults = results.map((r, i) => {
    const node = r.node || {};
    const absolutePath = node.absolutePath || r.filePath || node.file || 'unknown';
    const lines = node.startLine && node.endLine
      ? `${node.startLine}-${node.endLine}`
      : node.startLine
        ? `${node.startLine}`
        : 'N/A';
    const content = node.source || node.content || '';
    const description = node.docstring || node.description || '';
    return `[${i + 1}] ${node.type || 'unknown'}: ${node.name || 'unnamed'}
uuid: ${node.uuid || 'unknown'}
file: ${absolutePath}
lines: ${lines}
score: ${(r.score || 0).toFixed(3)}
${description ? `description: ${description}` : ''}
${content ? `content:\n${content}` : ''}`;
  }).join('\n\n---\n\n');

  const result = await executor.executeSingle<{
    snippets: Array<{ uuid: string; file: string; lines: string; content: string; relevance: string }>;
    findings: string;
    suggestions?: Array<{ type: string; target: string; reason: string }>;
  }>({
    input: { query: options.query, results: formattedResults, context: options.context || '' },
    inputFields: ['query', 'results', 'context'],
    llmProvider,
    outputFormat: 'json',
    systemPrompt: `You are an expert code analyst. Your task is to extract the most relevant snippets from code search results and suggest actionable next steps.

GUIDELINES:
- Focus on code/content that DIRECTLY answers the query
- Include the UUID from each result for reference (can be used with explore_node tool)
- For line numbers: calculate ABSOLUTE line numbers from the result's startLine. If a result starts at line 630 and you want to cite lines 10-25 within it, output "640-655"
- Keep snippets CONCISE: max 20-30 lines per snippet. Include signature + key logic only
- Use "// ..." to indicate omitted code within a snippet
- PRIORITIZE findings and suggestions over code length - they are MORE IMPORTANT than full code
- Explain WHY each snippet is relevant to the query
- Synthesize findings across all results

FOR SUGGESTIONS - be specific and actionable:
- Look at function/class names CALLED or IMPORTED in the code and suggest searching for them
- Identify dependencies (what the code uses) and consumers (what uses this code)
- Suggest exploring specific UUIDs with explore_node to see relationships
- Propose searches for related patterns, interfaces, or types mentioned in the code
- If you see a class method, suggest finding the class definition or other methods
- Do NOT give generic suggestions like "search for authentication" - be SPECIFIC based on what you see in the results`,
    userTask: `Analyze these search results and extract the most relevant snippets.

QUERY: {query}

${options.context ? `CONTEXT (why this search was made): {context}` : ''}

SEARCH RESULTS:
{results}

Extract:
1. The most relevant code/content snippets with their UUID, ABSOLUTE file paths and line numbers
2. A synthesis of key findings
3. SPECIFIC suggestions based on what you found:
   - Function/class names to search for (that are called/imported in the results)
   - UUIDs worth exploring with explore_node to see dependencies/consumers
   - Related types, interfaces, or patterns mentioned in the code`,
    outputSchema: {
      snippets: {
        type: 'array',
        description: 'Most relevant snippets from the results',
        required: true,
        items: {
          type: 'object',
          description: 'A relevant code snippet',
          properties: {
            uuid: { type: 'string', description: 'UUID of the node (from the results, for explore_node)' },
            file: { type: 'string', description: 'Absolute file path (from the results)' },
            lines: { type: 'string', description: 'ABSOLUTE line numbers in the file (e.g., "640-655"). Calculate from result startLine + offset within snippet.' },
            content: { type: 'string', description: 'Concise code snippet (max 20-30 lines). Include signature + key logic. Use "// ..." to indicate omitted parts.' },
            relevance: { type: 'string', description: 'Why this snippet is relevant to the query' },
          },
        },
      },
      findings: {
        type: 'string',
        description: 'Key findings synthesized from all results (2-3 sentences)',
        required: true,
      },
      suggestions: {
        type: 'array',
        description: 'Specific actionable suggestions based on the results found',
        required: false,
        items: {
          type: 'object',
          description: 'A specific suggestion for follow-up',
          properties: {
            type: { type: 'string', description: 'Type: "search" (brain_search query), "explore" (explore_node UUID), or "read" (read_file path)' },
            target: { type: 'string', description: 'The search query, UUID, or file path depending on type' },
            reason: { type: 'string', description: 'Why this would be useful (be specific)' },
          },
        },
      },
    },
    caller: 'search-post-processor.summarizeSearchResults',
    maxIterations: 1,
  });

  if (!result?.snippets || !result?.findings) {
    throw new Error('LLM did not return expected output format');
  }

  return {
    snippets: result.snippets,
    findings: result.findings,
    suggestions: result.suggestions,
  };
}

// ============================================================================
// LLM Reranking
// ============================================================================

/**
 * Rerank search results using LLM.
 *
 * @param results - Search results to rerank
 * @param options - Reranking options
 * @returns Reranked results with merged scores
 */
export async function rerankSearchResults<T extends ProcessableSearchResult>(
  results: T[],
  options: RerankOptions
): Promise<RerankResult<T>> {
  if (!options.apiKey) {
    throw new Error('GEMINI_API_KEY required for reranking');
  }

  if (results.length === 0) {
    return { results: [], evaluationCount: 0 };
  }

  const { LLMReranker } = await import('../runtime/reranking/llm-reranker.js');
  const { GeminiAPIProvider } = await import('../runtime/reranking/gemini-api-provider.js');

  const provider = new GeminiAPIProvider({
    apiKey: options.apiKey,
    model: 'gemini-2.0-flash',
  });

  // Create a generic EntityContext for search results
  const entityContext = {
    type: 'BrainNode',
    displayName: 'search results',
    uniqueField: 'uuid',
    queryField: 'name',
    fields: [
      { name: 'uuid', label: 'ID', required: true },
      { name: 'name', label: 'Name', maxLength: 500 },
      { name: 'title', label: 'Title', maxLength: 500 },
      { name: 'file', label: 'File', maxLength: 500 },
      { name: 'path', label: 'Path', maxLength: 500 },
      { name: 'source', label: 'Source', maxLength: 20000 },
      { name: 'content', label: 'Content', maxLength: 20000 },
      { name: 'ownContent', label: 'Own Content', maxLength: 20000 },
      { name: 'docstring', label: 'Documentation', maxLength: 5000 },
      { name: 'signature', label: 'Signature', maxLength: 1000 },
      { name: 'type', label: 'Type', maxLength: 100 },
      { name: 'rawText', label: 'Raw Text', maxLength: 20000 },
      { name: 'textContent', label: 'Text Content', maxLength: 20000 },
      { name: 'code', label: 'Code', maxLength: 20000 },
      { name: 'indexedAt', label: 'Indexed At', maxLength: 50 },
    ],
    enrichments: [],
  };

  // Convert results to SearchResult format for reranking
  const searchResults = results.map(r => ({
    entity: r.node,
    score: r.score,
  }));

  const batchSize = options.batchSize ?? 100;
  const parallel = options.parallel ?? 5;
  const vectorWeight = options.vectorWeight ?? 0.3;
  const llmWeight = options.llmWeight ?? 0.7;

  const reranker = new LLMReranker(provider, {
    batchSize,
    parallel,
    minScore: 0.0,
    topK: results.length,
    scoreMerging: 'weighted',
    weights: { vector: vectorWeight, llm: llmWeight },
  }, entityContext);

  // Execute reranking
  const rerankResult = await reranker.rerank({
    userQuestion: options.query,
    results: searchResults,
    queryContext: options.context || `Search query: "${options.query}"\nProjects: ${options.projects?.join(', ') || 'all'}`,
  });

  if (rerankResult.evaluations.length === 0) {
    return { results, evaluationCount: 0 };
  }

  // Merge scores
  const rerankedResults = reranker.mergeScores(
    searchResults,
    rerankResult.evaluations,
    'weighted',
    { vector: vectorWeight, llm: llmWeight }
  );

  if (rerankedResults.length === 0) {
    return { results, evaluationCount: rerankResult.evaluations.length };
  }

  // Convert back to original result format
  const finalResults: T[] = rerankedResults.map(r => {
    const originalResult = results.find(orig => orig.node.uuid === r.entity.uuid);
    if (!originalResult) return null;

    return {
      ...originalResult,
      score: r.score,
      ...(r.scoreBreakdown && { scoreBreakdown: r.scoreBreakdown }),
    } as T;
  }).filter((r): r is T => r !== null);

  // Sort by score descending
  finalResults.sort((a, b) => b.score - a.score);

  return {
    results: finalResults,
    evaluationCount: rerankResult.evaluations.length,
  };
}

// ============================================================================
// Combined Post-Processing
// ============================================================================

/**
 * Options for the full post-processing pipeline
 */
export interface PostProcessOptions {
  /** Keyword boost options */
  keywordBoost?: KeywordBoostOptions;
  /** Relationship exploration options */
  exploreRelationships?: ExploreRelationshipsOptions;
  /** Summarization options */
  summarize?: SummarizeOptions;
  /** Reranking options */
  rerank?: RerankOptions;
  /** Final limit to apply after all post-processing */
  limit?: number;
}

/**
 * Result of the full post-processing pipeline
 */
export interface PostProcessResult<T extends ProcessableSearchResult> {
  results: T[];
  reranked: boolean;
  keywordBoosted: boolean;
  relationshipsExplored: boolean;
  summarized: boolean;
  graph?: ExplorationGraph;
  summary?: SummaryResult;
}

/**
 * Apply the full post-processing pipeline to search results.
 *
 * Order of operations:
 * 1. Reranking (if enabled)
 * 2. Keyword boosting (if enabled)
 * 3. Apply final limit
 * 4. Relationship exploration (if enabled)
 * 5. Summarization (if enabled)
 *
 * @param results - Search results to process
 * @param options - Post-processing options
 * @returns Processed results with metadata
 */
export async function postProcessSearchResults<T extends ProcessableSearchResult>(
  results: T[],
  options: PostProcessOptions
): Promise<PostProcessResult<T>> {
  let processedResults = [...results];
  let reranked = false;
  let keywordBoosted = false;
  let relationshipsExplored = false;
  let summarized = false;
  let graph: ExplorationGraph | undefined;
  let summary: SummaryResult | undefined;

  // 1. Reranking (operates on full candidate set)
  if (options.rerank) {
    try {
      const rerankResult = await rerankSearchResults(processedResults, options.rerank);
      if (rerankResult.evaluationCount > 0) {
        processedResults = rerankResult.results;
        reranked = true;
      }
    } catch (err: any) {
      console.warn(`[SearchPostProcessor] Reranking failed: ${err.message}`);
    }
  }

  // 2. Keyword boosting
  if (options.keywordBoost && options.keywordBoost.keywords.length > 0) {
    const boostedResults = await applyKeywordBoost(processedResults, options.keywordBoost);
    processedResults = boostedResults.map(b => {
      if (b.keywordBoost) {
        return {
          ...b.result,
          keywordBoost: b.keywordBoost,
        } as T;
      }
      return b.result;
    });
    keywordBoosted = true;
  }

  // 3. Apply final limit
  if (options.limit && options.limit > 0) {
    processedResults = processedResults.slice(0, options.limit);
  }

  // 4. Relationship exploration (on limited results)
  if (options.exploreRelationships && options.exploreRelationships.depth > 0) {
    graph = await exploreRelationships(processedResults, options.exploreRelationships);
    if (graph && graph.nodes.length > 0) {
      relationshipsExplored = true;
    }
  }

  // 5. Summarization
  if (options.summarize) {
    try {
      summary = await summarizeSearchResults(processedResults, options.summarize);
      summarized = true;
    } catch (err: any) {
      console.warn(`[SearchPostProcessor] Summarization failed: ${err.message}`);
    }
  }

  return {
    results: processedResults,
    reranked,
    keywordBoosted,
    relationshipsExplored,
    summarized,
    graph,
    summary,
  };
}
