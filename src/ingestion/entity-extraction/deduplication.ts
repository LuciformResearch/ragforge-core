/**
 * Entity Deduplication
 *
 * Provides multiple strategies for deduplicating extracted entities:
 * 1. Fuzzy matching (Levenshtein distance)
 * 2. Embedding similarity (vector cosine similarity)
 * 3. LLM-based resolution (final arbitration)
 * 4. Hybrid (combines all strategies)
 */

import type { ExtractedEntity } from './types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * A potential duplicate pair.
 */
export interface DuplicatePair {
  /** First entity */
  entity1: ExtractedEntity;
  /** Second entity */
  entity2: ExtractedEntity;
  /** Similarity score (0-1) */
  similarity: number;
  /** Method that detected the duplicate */
  method: 'fuzzy' | 'embedding' | 'llm' | 'hybrid';
}

/**
 * Result of deduplication.
 */
export interface DeduplicationResult {
  /** Canonical entities after deduplication */
  entities: ExtractedEntity[];
  /** Mapping from original entity name to canonical name */
  canonicalMapping: Map<string, string>;
  /** Detected duplicates */
  duplicates: DuplicatePair[];
  /** Stats */
  stats: {
    originalCount: number;
    deduplicatedCount: number;
    duplicatesRemoved: number;
    processingTimeMs: number;
  };
}

/**
 * Configuration for deduplication.
 */
export interface DeduplicationConfig {
  /** Strategy to use */
  strategy: 'fuzzy' | 'embedding' | 'llm' | 'hybrid';

  /** Fuzzy matching threshold (default: 0.85) */
  fuzzyThreshold?: number;

  /** Embedding similarity threshold (default: 0.9) */
  embeddingThreshold?: number;

  /** Whether to use LLM for final resolution of uncertain cases (default: false) */
  useLLMFallback?: boolean;

  /** Function to generate embeddings (required for 'embedding' and 'hybrid') */
  embedFunction?: (texts: string[]) => Promise<number[][]>;

  /** Function to call LLM for resolution (required for 'llm' strategy) */
  llmResolveFunction?: (pairs: DuplicatePair[]) => Promise<Map<string, string>>;

  /** Only compare entities of the same type (default: true) */
  sameTypeOnly?: boolean;
}

const DEFAULT_CONFIG: DeduplicationConfig = {
  strategy: 'fuzzy',
  fuzzyThreshold: 0.85,
  embeddingThreshold: 0.9,
  useLLMFallback: false,
  sameTypeOnly: true,
};

// =============================================================================
// Main Deduplication Function
// =============================================================================

/**
 * Deduplicate a list of entities using the specified strategy.
 */
export async function deduplicateEntities(
  entities: ExtractedEntity[],
  config: Partial<DeduplicationConfig> = {}
): Promise<DeduplicationResult> {
  const startTime = Date.now();
  const fullConfig = { ...DEFAULT_CONFIG, ...config };

  if (entities.length <= 1) {
    return {
      entities,
      canonicalMapping: new Map(),
      duplicates: [],
      stats: {
        originalCount: entities.length,
        deduplicatedCount: entities.length,
        duplicatesRemoved: 0,
        processingTimeMs: Date.now() - startTime,
      },
    };
  }

  // Group by type if configured
  const groups = fullConfig.sameTypeOnly
    ? groupByType(entities)
    : new Map([['all', entities]]);

  const allDuplicates: DuplicatePair[] = [];
  const canonicalMapping = new Map<string, string>();

  // Process each group
  for (const [, groupEntities] of groups) {
    let duplicates: DuplicatePair[];

    switch (fullConfig.strategy) {
      case 'fuzzy':
        duplicates = findFuzzyDuplicates(groupEntities, fullConfig.fuzzyThreshold!);
        break;

      case 'embedding':
        if (!fullConfig.embedFunction) {
          throw new Error('embedFunction is required for embedding strategy');
        }
        duplicates = await findEmbeddingDuplicates(
          groupEntities,
          fullConfig.embedFunction,
          fullConfig.embeddingThreshold!
        );
        break;

      case 'llm':
        if (!fullConfig.llmResolveFunction) {
          throw new Error('llmResolveFunction is required for llm strategy');
        }
        // For LLM strategy, first find candidates with fuzzy, then resolve with LLM
        duplicates = findFuzzyDuplicates(groupEntities, 0.6); // Lower threshold
        break;

      case 'hybrid':
        duplicates = await findHybridDuplicates(groupEntities, fullConfig);
        break;

      default:
        duplicates = findFuzzyDuplicates(groupEntities, fullConfig.fuzzyThreshold!);
    }

    allDuplicates.push(...duplicates);
  }

  // LLM resolution if configured
  if (
    (fullConfig.strategy === 'llm' || fullConfig.useLLMFallback) &&
    fullConfig.llmResolveFunction &&
    allDuplicates.length > 0
  ) {
    const llmMapping = await fullConfig.llmResolveFunction(allDuplicates);
    for (const [from, to] of llmMapping) {
      canonicalMapping.set(from, to);
    }
  } else {
    // Use automatic resolution (keep higher confidence or first occurrence)
    for (const dup of allDuplicates) {
      const canonical = selectCanonical(dup.entity1, dup.entity2);
      const other = canonical === dup.entity1 ? dup.entity2 : dup.entity1;
      canonicalMapping.set(other.name.toLowerCase(), canonical.name);
    }
  }

  // Build deduplicated list
  const seen = new Set<string>();
  const deduplicatedEntities: ExtractedEntity[] = [];

  for (const entity of entities) {
    const normalized = entity.name.toLowerCase();
    const canonical = canonicalMapping.get(normalized) || entity.name;
    const canonicalNormalized = canonical.toLowerCase();

    if (!seen.has(canonicalNormalized)) {
      seen.add(canonicalNormalized);
      // Use canonical name
      deduplicatedEntities.push({
        ...entity,
        name: canonical,
      });
    }
  }

  return {
    entities: deduplicatedEntities,
    canonicalMapping,
    duplicates: allDuplicates,
    stats: {
      originalCount: entities.length,
      deduplicatedCount: deduplicatedEntities.length,
      duplicatesRemoved: entities.length - deduplicatedEntities.length,
      processingTimeMs: Date.now() - startTime,
    },
  };
}

// =============================================================================
// Fuzzy Matching
// =============================================================================

/**
 * Find duplicates using fuzzy string matching (Levenshtein distance).
 * Optimized with length filtering and name caching.
 */
export function findFuzzyDuplicates(
  entities: ExtractedEntity[],
  threshold: number
): DuplicatePair[] {
  const duplicates: DuplicatePair[] = [];

  // Pre-compute normalized names (avoid 80k+ toLowerCase calls)
  const normalizedNames = entities.map(e => e.name.toLowerCase());

  // Pre-compute lengths for fast filtering
  const lengths = normalizedNames.map(n => n.length);

  // Max length difference allowed for threshold
  // If similarity >= threshold, then: 1 - distance/maxLen >= threshold
  // So: distance <= maxLen * (1 - threshold)
  // If lengths differ by more than this, skip comparison
  const getMaxLengthDiff = (len1: number, len2: number) => {
    const maxLen = Math.max(len1, len2);
    return Math.floor(maxLen * (1 - threshold));
  };

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      // Fast length filter - if lengths differ too much, similarity can't meet threshold
      const lengthDiff = Math.abs(lengths[i] - lengths[j]);
      if (lengthDiff > getMaxLengthDiff(lengths[i], lengths[j])) {
        continue;
      }

      // Exact match shortcut
      if (normalizedNames[i] === normalizedNames[j]) {
        duplicates.push({
          entity1: entities[i],
          entity2: entities[j],
          similarity: 1,
          method: 'fuzzy',
        });
        continue;
      }

      const similarity = calculateSimilarity(normalizedNames[i], normalizedNames[j]);

      if (similarity >= threshold) {
        duplicates.push({
          entity1: entities[i],
          entity2: entities[j],
          similarity,
          method: 'fuzzy',
        });
      }
    }
  }

  return duplicates;
}

/**
 * Calculate normalized Levenshtein similarity (0-1).
 * Optimized with early termination for threshold-based filtering.
 */
export function calculateSimilarity(s1: string, s2: string, minThreshold = 0): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const maxLength = Math.max(s1.length, s2.length);
  // Max distance allowed to meet threshold
  const maxDistance = minThreshold > 0 ? Math.floor(maxLength * (1 - minThreshold)) : maxLength;

  const distance = levenshteinDistanceWithCutoff(s1, s2, maxDistance);
  if (distance > maxDistance) return 0; // Early termination triggered

  return 1 - distance / maxLength;
}

/**
 * Calculate Levenshtein distance with early termination.
 * Returns maxDistance + 1 if distance exceeds cutoff (for fast rejection).
 */
function levenshteinDistanceWithCutoff(s1: string, s2: string, maxDistance: number): number {
  const m = s1.length;
  const n = s2.length;

  // Quick reject if length difference exceeds max distance
  if (Math.abs(m - n) > maxDistance) {
    return maxDistance + 1;
  }

  // Use 1D array for space optimization
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i; // Track minimum in current row for early termination

    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
      }
      rowMin = Math.min(rowMin, curr[j]);
    }

    // Early termination: if best possible score exceeds threshold, abort
    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }

    // Swap arrays
    for (let j = 0; j <= n; j++) {
      prev[j] = curr[j];
    }
  }

  return prev[n];
}

// =============================================================================
// Embedding Similarity
// =============================================================================

/**
 * Find duplicates using embedding similarity.
 */
export async function findEmbeddingDuplicates(
  entities: ExtractedEntity[],
  embedFunction: (texts: string[]) => Promise<number[][]>,
  threshold: number
): Promise<DuplicatePair[]> {
  if (entities.length <= 1) return [];

  // Generate embeddings for all entity names
  const texts = entities.map(e => e.name);
  const embeddings = await embedFunction(texts);

  const duplicates: DuplicatePair[] = [];

  // Compare all pairs
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const similarity = cosineSimilarity(embeddings[i], embeddings[j]);

      if (similarity >= threshold) {
        duplicates.push({
          entity1: entities[i],
          entity2: entities[j],
          similarity,
          method: 'embedding',
        });
      }
    }
  }

  return duplicates;
}

/**
 * Calculate cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) return 0;

  return dotProduct / (normA * normB);
}

// =============================================================================
// Hybrid Strategy
// =============================================================================

/**
 * Find duplicates using hybrid strategy (fuzzy + embedding).
 */
async function findHybridDuplicates(
  entities: ExtractedEntity[],
  config: DeduplicationConfig
): Promise<DuplicatePair[]> {
  // Step 1: Find fuzzy candidates (with lower threshold)
  const fuzzyCandidates = findFuzzyDuplicates(entities, 0.7);

  if (fuzzyCandidates.length === 0 || !config.embedFunction) {
    // Fall back to fuzzy only
    return findFuzzyDuplicates(entities, config.fuzzyThreshold!);
  }

  // Step 2: Verify with embeddings
  const candidateEntities = new Set<ExtractedEntity>();
  for (const dup of fuzzyCandidates) {
    candidateEntities.add(dup.entity1);
    candidateEntities.add(dup.entity2);
  }

  const entitiesArray = Array.from(candidateEntities);
  const texts = entitiesArray.map(e => e.name);
  const embeddings = await config.embedFunction(texts);

  // Create embedding lookup
  const embeddingMap = new Map<ExtractedEntity, number[]>();
  entitiesArray.forEach((e, i) => embeddingMap.set(e, embeddings[i]));

  // Filter candidates based on embedding similarity
  const verifiedDuplicates: DuplicatePair[] = [];

  for (const dup of fuzzyCandidates) {
    const emb1 = embeddingMap.get(dup.entity1);
    const emb2 = embeddingMap.get(dup.entity2);

    if (emb1 && emb2) {
      const embSimilarity = cosineSimilarity(emb1, emb2);

      // Combine scores (weighted average)
      const combinedScore = 0.4 * dup.similarity + 0.6 * embSimilarity;

      if (combinedScore >= config.embeddingThreshold!) {
        verifiedDuplicates.push({
          ...dup,
          similarity: combinedScore,
          method: 'hybrid',
        });
      }
    }
  }

  return verifiedDuplicates;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Group entities by type.
 */
function groupByType(entities: ExtractedEntity[]): Map<string, ExtractedEntity[]> {
  const groups = new Map<string, ExtractedEntity[]>();

  for (const entity of entities) {
    const type = entity.type.toLowerCase();
    if (!groups.has(type)) {
      groups.set(type, []);
    }
    groups.get(type)!.push(entity);
  }

  return groups;
}

/**
 * Select canonical entity from a duplicate pair.
 * Prefers higher confidence, then longer name, then first occurrence.
 */
function selectCanonical(e1: ExtractedEntity, e2: ExtractedEntity): ExtractedEntity {
  // Higher confidence wins
  if (e1.confidence !== undefined && e2.confidence !== undefined) {
    if (e1.confidence > e2.confidence) return e1;
    if (e2.confidence > e1.confidence) return e2;
  }

  // Prefer non-abbreviated (longer name)
  if (e1.name.length !== e2.name.length) {
    return e1.name.length > e2.name.length ? e1 : e2;
  }

  // First occurrence
  return e1;
}

// =============================================================================
// LLM Prompt Builder (for external use)
// =============================================================================

/**
 * Build a prompt for LLM-based entity resolution.
 * This can be used with any LLM API.
 */
export function buildLLMResolutionPrompt(duplicates: DuplicatePair[]): string {
  const pairs = duplicates.map((d, i) => {
    return `${i + 1}. "${d.entity1.name}" (${d.entity1.type}) vs "${d.entity2.name}" (${d.entity2.type}) - similarity: ${(d.similarity * 100).toFixed(0)}%`;
  });

  return `You are an entity resolution expert. Given the following pairs of potentially duplicate entities, determine which pairs are true duplicates and select the canonical (preferred) name for each.

Pairs to analyze:
${pairs.join('\n')}

For each pair, respond with:
- "SAME" if they refer to the same entity, followed by the canonical name
- "DIFFERENT" if they are distinct entities

Format your response as JSON:
{
  "resolutions": [
    { "pair": 1, "decision": "SAME", "canonical": "preferred name" },
    { "pair": 2, "decision": "DIFFERENT" }
  ]
}`;
}
