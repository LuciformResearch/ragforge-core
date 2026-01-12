/**
 * SearchService - Extracted search logic from BrainManager
 *
 * Provides reusable semantic, hybrid, and full-text search capabilities.
 * Can be used by:
 * - BrainManager (CLI/MCP brain_search)
 * - CommunityOrchestratorAdapter (community-docs API)
 *
 * @since 2026-01-04
 */

import neo4j from 'neo4j-driver';
import type { Neo4jClient } from '../runtime/client/neo4j-client.js';
import type { EmbeddingService } from './embedding-service.js';
import { MULTI_EMBED_CONFIGS } from './embedding-service.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for SearchService
 */
export interface SearchServiceConfig {
  /** Neo4j client instance */
  neo4jClient: Neo4jClient;
  /** Embedding service for semantic search (optional - if not provided, only text search works) */
  embeddingService?: EmbeddingService;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Filter operators for building WHERE clauses
 */
export type FilterOperator = 'eq' | 'neq' | 'in' | 'notIn' | 'startsWith' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';

/**
 * A single search filter
 */
export interface SearchFilter {
  /** Property name to filter on (e.g., "categorySlug", "projectId") */
  property: string;
  /** Comparison operator */
  operator: FilterOperator;
  /** Value to compare against */
  value: string | string[] | boolean | number;
}

/**
 * Search options
 */
export interface SearchOptions {
  /** Search query string */
  query: string;
  /** Maximum number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Minimum similarity score (0.0 to 1.0) */
  minScore?: number;

  // Search type
  /** Use semantic (vector) search */
  semantic?: boolean;
  /** Use hybrid search (semantic + BM25 with boost fusion) */
  hybrid?: boolean;
  /** Which embedding type to use: 'name', 'content', 'description', or 'all' */
  embeddingType?: 'name' | 'content' | 'description' | 'all';
  /** Fuzzy distance for BM25 text search (0, 1, or 2) */
  fuzzyDistance?: 0 | 1 | 2;
  /** RRF k constant for hybrid search (default: 60) */
  rrfK?: number;

  // Filters
  /** Array of filters to apply */
  filters?: SearchFilter[];

  /**
   * Raw Cypher filter clause (for complex conditions that can't be expressed with SearchFilter).
   * Should start with "AND" and use "n" as the node alias.
   * Example: "AND ((n.projectId <> 'touched-files') OR (n.projectId = 'touched-files' AND n.absolutePath STARTS WITH $basePath))"
   */
  rawFilterClause?: string;
  /** Parameters for rawFilterClause */
  rawFilterParams?: Record<string, any>;

  // Post-processing
  /** Glob pattern to filter results by file path */
  glob?: string;
}

/**
 * A single search result
 * Named with "Service" prefix to avoid conflict with runtime/query SearchResult
 */
export interface ServiceSearchResult {
  /** Node properties (embeddings stripped) */
  node: Record<string, any>;
  /** Similarity/relevance score */
  score: number;
  /** Absolute file path (if available) */
  filePath?: string;
  /** Matched range for chunked content */
  matchedRange?: {
    startLine: number;
    endLine: number;
    startChar: number;
    endChar: number;
    chunkIndex: number;
    chunkScore: number;
    /** The actual chunk text that matched */
    chunkText?: string;
    /** Page number from parent document (for PDFs/Word docs) */
    pageNum?: number | null;
  };
  /** Details about how this result was found in hybrid search */
  rrfDetails?: {
    searchType?: 'semantic' | 'bm25-only';
    semanticScore?: number;
    originalSemanticScore?: number;
    bm25Rank?: number | null;
    boostApplied?: number;
    note?: string;
  };
}

/**
 * Search result container
 */
export interface ServiceSearchResultSet {
  /** Array of search results */
  results: ServiceSearchResult[];
  /** Total count of results */
  totalCount: number;
}

// ============================================================================
// SearchService
// ============================================================================

export class SearchService {
  private neo4jClient: Neo4jClient;
  private embeddingService?: EmbeddingService;
  private verbose: boolean;

  constructor(config: SearchServiceConfig) {
    this.neo4jClient = config.neo4jClient;
    this.embeddingService = config.embeddingService;
    this.verbose = config.verbose ?? false;
  }

  /**
   * Check if semantic search is available
   */
  canDoSemanticSearch(): boolean {
    return !!this.embeddingService?.canGenerateEmbeddings();
  }

  /**
   * Main search method
   */
  async search(options: SearchOptions): Promise<ServiceSearchResultSet> {
    const limit = Math.max(0, Math.floor(options.limit ?? 20));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const embeddingType = options.embeddingType || 'all';
    const minScore = options.minScore ?? (options.semantic ? 0.3 : undefined);

    // Build filter string from SearchFilter array
    const { filterClause: baseFilterClause, filterParams } = this.buildFilterClause(options.filters || []);

    // Combine with raw filter clause if provided
    const filterClause = options.rawFilterClause
      ? `${baseFilterClause} ${options.rawFilterClause}`
      : baseFilterClause;

    const params: Record<string, any> = {
      ...filterParams,
      ...(options.rawFilterParams || {}),
      limit: neo4j.int(limit),
      offset: neo4j.int(offset),
    };

    let results: ServiceSearchResult[];

    if (options.hybrid && options.semantic && this.canDoSemanticSearch()) {
      // Hybrid search: semantic + BM25 with boost fusion
      results = await this.hybridSearch(options.query, {
        embeddingType,
        filterClause,
        params,
        limit,
        minScore: minScore ?? 0.3,
        rrfK: options.rrfK ?? 60,
      });
    } else if (options.semantic && this.canDoSemanticSearch()) {
      // Semantic search only
      results = await this.vectorSearch(options.query, {
        embeddingType,
        filterClause,
        params,
        limit,
        minScore: minScore ?? 0.3,
      });
    } else {
      // Full-text BM25 search
      results = await this.fullTextSearch(options.query, {
        filterClause,
        params,
        limit,
        minScore,
        fuzzyDistance: options.fuzzyDistance ?? 1,
      });
    }

    // Apply glob filter if specified
    if (options.glob) {
      results = this.applyGlobFilter(results, options.glob);
    }

    // Apply minScore filter for post-processing
    if (minScore !== undefined) {
      results = results.filter(r => r.score >= minScore);
    }

    return {
      results,
      totalCount: results.length,
    };
  }

  // ============================================================================
  // Filter Building
  // ============================================================================

  /**
   * Build Cypher WHERE clause from SearchFilter array
   */
  private buildFilterClause(filters: SearchFilter[]): {
    filterClause: string;
    filterParams: Record<string, any>;
  } {
    if (filters.length === 0) {
      return { filterClause: '', filterParams: {} };
    }

    const clauses: string[] = [];
    const params: Record<string, any> = {};

    filters.forEach((filter, idx) => {
      const paramName = `filter_${idx}`;
      const prop = `n.${filter.property}`;

      switch (filter.operator) {
        case 'eq':
          clauses.push(`${prop} = $${paramName}`);
          params[paramName] = filter.value;
          break;
        case 'neq':
          clauses.push(`${prop} <> $${paramName}`);
          params[paramName] = filter.value;
          break;
        case 'in':
          clauses.push(`${prop} IN $${paramName}`);
          params[paramName] = filter.value;
          break;
        case 'notIn':
          clauses.push(`NOT ${prop} IN $${paramName}`);
          params[paramName] = filter.value;
          break;
        case 'startsWith':
          clauses.push(`${prop} STARTS WITH $${paramName}`);
          params[paramName] = filter.value;
          break;
        case 'contains':
          clauses.push(`${prop} CONTAINS $${paramName}`);
          params[paramName] = filter.value;
          break;
        case 'gt':
          clauses.push(`${prop} > $${paramName}`);
          params[paramName] = filter.value;
          break;
        case 'gte':
          clauses.push(`${prop} >= $${paramName}`);
          params[paramName] = filter.value;
          break;
        case 'lt':
          clauses.push(`${prop} < $${paramName}`);
          params[paramName] = filter.value;
          break;
        case 'lte':
          clauses.push(`${prop} <= $${paramName}`);
          params[paramName] = filter.value;
          break;
      }
    });

    const filterClause = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
    return { filterClause, filterParams: params };
  }

  // ============================================================================
  // Vector Search
  // ============================================================================

  /**
   * Semantic vector search using embeddings
   */
  private async vectorSearch(
    query: string,
    options: {
      embeddingType: 'name' | 'content' | 'description' | 'all';
      filterClause: string;
      params: Record<string, any>;
      limit: number;
      minScore: number;
    }
  ): Promise<ServiceSearchResult[]> {
    const { embeddingType, filterClause, params, limit, minScore } = options;

    // Get query embedding
    const queryEmbedding = await this.embeddingService!.getQueryEmbedding(query);
    if (!queryEmbedding) {
      if (this.verbose) console.warn('[SearchService] Failed to get query embedding');
      return [];
    }

    // Determine which embedding properties to search
    const embeddingProps: string[] = [];
    if (embeddingType === 'name' || embeddingType === 'all') {
      embeddingProps.push('embedding_name');
    }
    if (embeddingType === 'content' || embeddingType === 'all') {
      embeddingProps.push('embedding_content');
    }
    if (embeddingType === 'description' || embeddingType === 'all') {
      embeddingProps.push('embedding_description');
    }
    // Legacy 'embedding' property for backward compatibility
    if (embeddingType === 'all') {
      embeddingProps.push('embedding');
    }

    // Build map of label -> embedding properties
    const labelEmbeddingMap = new Map<string, Set<string>>();
    for (const config of MULTI_EMBED_CONFIGS) {
      const label = config.label;
      if (!labelEmbeddingMap.has(label)) {
        labelEmbeddingMap.set(label, new Set());
      }
      for (const embeddingConfig of config.embeddings) {
        labelEmbeddingMap.get(label)!.add(embeddingConfig.propertyName);
      }
    }

    // Legacy labels
    const legacyLabels = ['Scope', 'File', 'MarkdownSection', 'CodeBlock', 'MarkdownDocument'];
    for (const label of legacyLabels) {
      if (!labelEmbeddingMap.has(label)) {
        labelEmbeddingMap.set(label, new Set());
      }
      labelEmbeddingMap.get(label)!.add('embedding');
    }

    // Add EmbeddingChunk for chunked content
    if (embeddingType === 'content' || embeddingType === 'all') {
      labelEmbeddingMap.set('EmbeddingChunk', new Set(['embedding_content']));
    }

    // Build search tasks
    const searchTasks: Array<{ label: string; embeddingProp: string; indexName: string }> = [];
    for (const embeddingProp of embeddingProps) {
      for (const [label, labelProps] of labelEmbeddingMap.entries()) {
        if (!labelProps.has(embeddingProp)) continue;
        const indexName = `${label.toLowerCase()}_${embeddingProp}_vector`;
        searchTasks.push({ label, embeddingProp, indexName });
      }
    }

    // Run all vector queries in parallel
    const requestTopK = Math.min(limit * 3, 100);
    const searchPromises = searchTasks.map(async ({ label, embeddingProp, indexName }) => {
      const results: Array<{ rawNode: any; score: number; label: string }> = [];

      try {
        const cypher = `
          CALL db.index.vector.queryNodes($indexName, $requestTopK, $queryEmbedding)
          YIELD node AS n, score
          WHERE score >= $minScore ${filterClause}
          RETURN n, score
          ORDER BY score DESC
          LIMIT $limit
        `;

        const result = await this.neo4jClient.run(cypher, {
          indexName,
          requestTopK: neo4j.int(requestTopK),
          queryEmbedding,
          minScore,
          ...params,
          limit: neo4j.int(limit),
        });

        for (const record of result.records) {
          const node = record.get('n');
          results.push({
            rawNode: { ...node.properties, labels: node.labels },
            score: record.get('score'),
            label,
          });
        }
      } catch (err: any) {
        // Index might not exist - fallback to manual cosine similarity
        if (err.message?.includes('does not exist') || err.message?.includes('no such vector')) {
          try {
            const fallbackCypher = `
              MATCH (n:\`${label}\`)
              WHERE n.\`${embeddingProp}\` IS NOT NULL ${filterClause}
              RETURN n
              LIMIT 500
            `;

            const fallbackResult = await this.neo4jClient.run(fallbackCypher, params);

            for (const record of fallbackResult.records) {
              const node = record.get('n');
              const rawNode = { ...node.properties, labels: node.labels };
              const nodeEmbedding = rawNode[embeddingProp];
              if (!nodeEmbedding || !Array.isArray(nodeEmbedding)) continue;

              const score = this.cosineSimilarity(queryEmbedding, nodeEmbedding);
              if (score < minScore) continue;

              results.push({ rawNode, score, label });
            }
          } catch (fallbackErr: any) {
            if (this.verbose) {
              console.debug(`[SearchService] Fallback search failed for ${label}.${embeddingProp}: ${fallbackErr.message}`);
            }
          }
        } else if (this.verbose) {
          console.debug(`[SearchService] Vector search failed for ${indexName}: ${err.message}`);
        }
      }

      return results;
    });

    // Wait for all queries
    const allQueryResults = await Promise.all(searchPromises);

    // Merge and deduplicate results
    const allResults: ServiceSearchResult[] = [];
    const uuidToIndex = new Map<string, number>(); // Track uuid -> index for score updates
    const chunkMatches = new Map<string, { chunk: Record<string, any>; score: number; parentLabel: string }>();

    for (const queryResults of allQueryResults) {
      for (const { rawNode, score, label } of queryResults) {
        const uuid = rawNode.uuid;

        // Handle EmbeddingChunk: collect for later normalization
        if (label === 'EmbeddingChunk') {
          const parentUuid = rawNode.parentUuid;
          const existing = chunkMatches.get(parentUuid);
          if (!existing || score > existing.score) {
            chunkMatches.set(parentUuid, {
              chunk: rawNode,
              score,
              parentLabel: rawNode.parentLabel,
            });
          }
          continue;
        }

        // Check for duplicates - update score if new one is higher
        const existingIndex = uuidToIndex.get(uuid);
        if (existingIndex !== undefined) {
          if (score > allResults[existingIndex].score) {
            allResults[existingIndex].score = score;
          }
          continue;
        }

        uuidToIndex.set(uuid, allResults.length);
        allResults.push({
          node: this.stripEmbeddingFields(rawNode),
          score,
          filePath: rawNode.absolutePath || rawNode.file || rawNode.path,
        });
      }
    }

    // Resolve chunk matches to parent nodes
    if (chunkMatches.size > 0) {
      await this.resolveChunkMatches(chunkMatches, uuidToIndex, allResults, params);
    }

    // Sort and limit
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
  }

  /**
   * Resolve EmbeddingChunk matches to their parent nodes
   */
  private async resolveChunkMatches(
    chunkMatches: Map<string, { chunk: Record<string, any>; score: number; parentLabel: string }>,
    uuidToIndex: Map<string, number>,
    allResults: ServiceSearchResult[],
    params: Record<string, any>
  ): Promise<void> {
    // Group by label
    const byLabel = new Map<string, string[]>();
    for (const [parentUuid, match] of chunkMatches.entries()) {
      const label = match.parentLabel;
      if (!byLabel.has(label)) {
        byLabel.set(label, []);
      }
      byLabel.get(label)!.push(parentUuid);
    }

    // Fetch parent nodes
    for (const [label, parentUuids] of byLabel.entries()) {
      try {
        const parentResult = await this.neo4jClient.run(
          `MATCH (n:\`${label}\`) WHERE n.uuid IN $uuids RETURN n`,
          { uuids: parentUuids }
        );

        for (const record of parentResult.records) {
          const node = record.get('n');
          const parentNode = { ...node.properties, labels: node.labels };
          const parentUuid = parentNode.uuid;

          const match = chunkMatches.get(parentUuid)!;
          const chunk = match.chunk;
          const chunkScore = match.score;

          // Check if parent already exists - update score if chunk score is higher
          const existingIndex = uuidToIndex.get(parentUuid);
          if (existingIndex !== undefined) {
            if (chunkScore > allResults[existingIndex].score) {
              allResults[existingIndex].score = chunkScore;
              allResults[existingIndex].matchedRange = {
                startLine: chunk.startLine ?? 1,
                endLine: chunk.endLine ?? 1,
                startChar: chunk.startChar ?? 0,
                endChar: chunk.endChar ?? 0,
                chunkIndex: chunk.chunkIndex ?? 0,
                chunkScore: chunkScore,
                chunkText: chunk.text as string | undefined,
                pageNum: chunk.pageNum as number | null | undefined,
              };
            }
            continue;
          }

          uuidToIndex.set(parentUuid, allResults.length);
          allResults.push({
            node: this.stripEmbeddingFields(parentNode),
            score: chunkScore,
            filePath: parentNode.absolutePath || parentNode.file || parentNode.path,
            matchedRange: {
              startLine: chunk.startLine ?? 1,
              endLine: chunk.endLine ?? 1,
              startChar: chunk.startChar ?? 0,
              endChar: chunk.endChar ?? 0,
              chunkIndex: chunk.chunkIndex ?? 0,
              chunkScore: chunkScore,
              chunkText: chunk.text as string | undefined,
              pageNum: chunk.pageNum as number | null | undefined,
            },
          });
        }
      } catch (err: any) {
        if (this.verbose) {
          console.debug(`[SearchService] Failed to fetch parent nodes for ${label}: ${err.message}`);
        }
      }
    }
  }

  // ============================================================================
  // Full-Text Search (BM25)
  // ============================================================================

  /**
   * Full-text search using Neo4j Lucene indexes (BM25)
   */
  private async fullTextSearch(
    query: string,
    options: {
      filterClause: string;
      params: Record<string, any>;
      limit: number;
      minScore?: number;
      fuzzyDistance?: 0 | 1 | 2;
    }
  ): Promise<ServiceSearchResult[]> {
    const { filterClause, params, limit, minScore, fuzzyDistance = 1 } = options;

    // Full-text index names
    const fullTextIndexes = [
      'scope_fulltext',
      'file_fulltext',
      'datafile_fulltext',
      'document_fulltext',
      'markdown_fulltext',
      'media_fulltext',
      'webpage_fulltext',
      'codeblock_fulltext',
    ];

    // Escape Lucene special characters
    const escapedQuery = query.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');

    // Build Lucene query with fuzzy matching
    const words = escapedQuery.split(/\s+/).filter(w => w.length > 0);
    const luceneQuery = fuzzyDistance === 0
      ? words.join(' ')
      : words.map(w => `${w}~${fuzzyDistance}`).join(' ');

    // Build UNION ALL query
    const unionClauses = fullTextIndexes.map(indexName => `
      CALL db.index.fulltext.queryNodes('${indexName}', $luceneQuery)
      YIELD node AS n, score
      WHERE true ${filterClause}
      RETURN n, score
    `);

    const cypher = `
      ${unionClauses.join('\nUNION ALL\n')}
      ORDER BY score DESC
      LIMIT $limit
    `;

    try {
      const result = await this.neo4jClient.run(cypher, {
        luceneQuery,
        ...params,
        limit: neo4j.int(limit * 2),
      });

      const allResults: ServiceSearchResult[] = [];
      const seenUuids = new Set<string>();

      for (const record of result.records) {
        const node = record.get('n');
        const rawNode = { ...node.properties, labels: node.labels };
        const uuid = rawNode.uuid;
        const score = record.get('score');

        if (seenUuids.has(uuid)) continue;
        seenUuids.add(uuid);

        if (minScore !== undefined && score < minScore) continue;

        allResults.push({
          node: this.stripEmbeddingFields(rawNode),
          score,
          filePath: rawNode.absolutePath || rawNode.file || rawNode.path,
        });

        if (allResults.length >= limit) break;
      }

      return allResults;
    } catch (err: any) {
      // Fallback to parallel individual queries
      if (this.verbose) {
        console.debug(`[SearchService] UNION query failed, using fallback: ${err.message}`);
      }
      return this.fullTextSearchFallback(luceneQuery, options);
    }
  }

  /**
   * Fallback for full-text search when UNION fails
   */
  private async fullTextSearchFallback(
    luceneQuery: string,
    options: {
      filterClause: string;
      params: Record<string, any>;
      limit: number;
      minScore?: number;
    }
  ): Promise<ServiceSearchResult[]> {
    const { filterClause, params, limit, minScore } = options;

    const fullTextIndexes = [
      'scope_fulltext',
      'file_fulltext',
      'datafile_fulltext',
      'document_fulltext',
      'markdown_fulltext',
      'media_fulltext',
      'webpage_fulltext',
      'codeblock_fulltext',
    ];

    const cypher = `
      CALL db.index.fulltext.queryNodes($indexName, $luceneQuery)
      YIELD node AS n, score
      WHERE true ${filterClause}
      RETURN n, score
      ORDER BY score DESC
      LIMIT $limit
    `;

    const queryPromises = fullTextIndexes.map(async (indexName) => {
      try {
        const result = await this.neo4jClient.run(cypher, {
          indexName,
          luceneQuery,
          ...params,
          limit: neo4j.int(limit),
        });
        return { records: result.records };
      } catch (err: any) {
        if (this.verbose && !err.message?.includes('does not exist')) {
          console.debug(`[SearchService] Full-text search failed for ${indexName}: ${err.message}`);
        }
        return { records: [] };
      }
    });

    const queryResults = await Promise.all(queryPromises);

    const allResults: ServiceSearchResult[] = [];
    const seenUuids = new Set<string>();

    for (const { records } of queryResults) {
      for (const record of records) {
        const node = record.get('n');
        const rawNode = { ...node.properties, labels: node.labels };
        const uuid = rawNode.uuid;
        const score = record.get('score');

        if (seenUuids.has(uuid)) continue;
        seenUuids.add(uuid);

        if (minScore !== undefined && score < minScore) continue;

        allResults.push({
          node: this.stripEmbeddingFields(rawNode),
          score,
          filePath: rawNode.absolutePath || rawNode.file || rawNode.path,
        });
      }
    }

    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
  }

  // ============================================================================
  // Hybrid Search
  // ============================================================================

  /**
   * Hybrid search: semantic + BM25 with boost fusion
   */
  private async hybridSearch(
    query: string,
    options: {
      embeddingType: 'name' | 'content' | 'description' | 'all';
      filterClause: string;
      params: Record<string, any>;
      limit: number;
      minScore: number;
      rrfK: number;
    }
  ): Promise<ServiceSearchResult[]> {
    const { embeddingType, filterClause, params, limit, minScore, rrfK } = options;

    // Fetch more candidates for better fusion
    const candidateLimit = Math.min(limit * 3, 150);

    const [semanticResults, bm25Results] = await Promise.all([
      this.vectorSearch(query, {
        embeddingType,
        filterClause,
        params,
        limit: candidateLimit,
        minScore: Math.max(minScore * 0.5, 0.1),
      }),
      this.fullTextSearch(query, {
        filterClause,
        params,
        limit: candidateLimit,
        minScore: undefined,
      }),
    ]);

    if (this.verbose) {
      console.log(`[SearchService.hybrid] Semantic: ${semanticResults.length}, BM25: ${bm25Results.length}`);
    }

    // Boost strategy: semantic-first with BM25 boost
    const bm25BoostFactor = 0.3;
    const bm25OnlyTopN = 5;
    const bm25OnlyScoreBase = 0.4;

    // Build lookup maps
    const semanticUuids = new Set<string>();
    semanticResults.forEach(r => {
      const uuid = r.node.uuid || r.filePath;
      if (uuid) semanticUuids.add(uuid);
    });

    const bm25RankMap = new Map<string, number>();
    bm25Results.forEach((r, idx) => {
      const uuid = r.node.uuid || r.filePath;
      if (uuid && !bm25RankMap.has(uuid)) {
        bm25RankMap.set(uuid, idx + 1);
      }
    });

    // Boost semantic results by BM25 rank
    const boostedResults: ServiceSearchResult[] = semanticResults.map(r => {
      const uuid = r.node.uuid || r.filePath;
      const bm25Rank = bm25RankMap.get(uuid);

      let boostedScore = r.score;
      if (bm25Rank) {
        const boost = bm25BoostFactor / Math.sqrt(bm25Rank);
        boostedScore = r.score * (1 + boost);
      }

      return {
        ...r,
        score: boostedScore,
        rrfDetails: {
          searchType: 'semantic' as const,
          originalSemanticScore: r.score,
          bm25Rank: bm25Rank || null,
          boostApplied: bm25Rank ? (boostedScore / r.score - 1) : 0,
        },
      };
    });

    // Add top BM25-only results
    let bm25OnlyCount = 0;
    for (const r of bm25Results) {
      if (bm25OnlyCount >= bm25OnlyTopN) break;

      const uuid = r.node.uuid || r.filePath;
      if (uuid && !semanticUuids.has(uuid)) {
        const bm25Rank = bm25RankMap.get(uuid) || bm25OnlyCount + 1;
        const bm25OnlyScore = bm25OnlyScoreBase - (bm25OnlyCount * 0.05);

        boostedResults.push({
          ...r,
          score: bm25OnlyScore,
          rrfDetails: {
            searchType: 'bm25-only' as const,
            bm25Rank,
            note: 'Exact keyword match (not in semantic results)',
          },
        });
        bm25OnlyCount++;
      }
    }

    if (this.verbose) {
      console.log(`[SearchService.hybrid] Boosted: ${semanticResults.length} semantic + ${bm25OnlyCount} BM25-only`);
    }

    boostedResults.sort((a, b) => b.score - a.score);
    return boostedResults.slice(0, limit);
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Compute cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Strip embedding fields from node (they're huge)
   */
  private stripEmbeddingFields(node: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('embedding') || key.endsWith('_hash')) continue;
      result[key] = value;
    }
    return result;
  }

  /**
   * Apply glob pattern filter to results
   */
  private applyGlobFilter(results: ServiceSearchResult[], pattern: string): ServiceSearchResult[] {
    // Simple glob matching (supports * and **)
    const regexPattern = pattern
      .replace(/\*\*/g, '<<<GLOBSTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<GLOBSTAR>>>/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);

    return results.filter(r => {
      const filePath = r.filePath || r.node.file || r.node.path || '';
      return regex.test(filePath);
    });
  }
}
