/**
 * GLiNER Entity Extraction Client
 *
 * HTTP client for the GLiNER Python microservice.
 */

import type {
  EntityExtractionConfig,
  ExtractionResult,
  ExtractionRequest,
  BatchExtractionRequest,
  BatchExtractionResponse,
  HealthResponse,
} from './types.js';
import { DEFAULT_ENTITY_EXTRACTION_CONFIG } from './types.js';

/**
 * Default skip embedding types (fallback if service unavailable).
 * These are numeric/value types where embedding similarity doesn't make sense.
 *
 * The canonical source of truth is in entity-extraction.yaml (GLiNER service config).
 * This constant serves as a fallback when the service is unavailable.
 */
export const DEFAULT_SKIP_EMBEDDING_TYPES = [
  'price',
  'date',
  'quantity',
  'amount',
  'currency',
  'size',
  'duration',
];

/**
 * Service configuration response from /config endpoint.
 */
interface ServiceConfigResponse {
  default_entity_types: string[];
  default_relation_types: Record<string, string>;
  model_name: string;
  batch_size: number;
  device: string;
  skip_embedding_types: string[];
}

/**
 * Client for the GLiNER entity extraction microservice.
 */
export class EntityExtractionClient {
  private config: EntityExtractionConfig;
  private _skipEmbeddingTypesCache: string[] | null = null;

  constructor(config: Partial<EntityExtractionConfig> = {}) {
    this.config = { ...DEFAULT_ENTITY_EXTRACTION_CONFIG, ...config };
  }

  /**
   * Check if the GLiNER service is available (responding to requests).
   * Note: This doesn't require the model to be loaded - use loadModel() to load it.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.config.serviceUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const data = (await response.json()) as HealthResponse;
      return data.status === 'ok';
    } catch {
      return false;
    }
  }

  /**
   * Get service health information.
   */
  async getHealth(): Promise<HealthResponse | null> {
    try {
      const response = await fetch(`${this.config.serviceUrl}/health`);
      return (await response.json()) as HealthResponse;
    } catch {
      return null;
    }
  }

  /**
   * Extract entities and relations from a single text.
   */
  async extract(text: string): Promise<ExtractionResult> {
    const request: ExtractionRequest = {
      text,
      entity_types: this.config.entityTypes,
      relation_types: this.config.relationTypes,
      include_confidence: true,
      include_spans: true,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs || 30000
    );

    try {
      const response = await fetch(`${this.config.serviceUrl}/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Entity extraction failed: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as ExtractionResult;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Entity extraction timed out after ${this.config.timeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Extract entities and relations from multiple texts in batch.
   */
  async extractBatch(texts: string[], batchSize = 8): Promise<ExtractionResult[]> {
    if (texts.length === 0) {
      return [];
    }

    // Use all domains (fastest - no classification)
    if (this.config.useAllDomains) {
      return this.extractWithAllDomains(texts, batchSize);
    }

    // Use auto domain detection (classifies first, then extracts per domain)
    if (this.config.autoDetectDomain) {
      return this.extractWithAutoDetection(texts, batchSize);
    }

    const request: BatchExtractionRequest = {
      texts,
      entity_types: this.config.entityTypes,
      relation_types: this.config.relationTypes,
      include_confidence: true,
      include_spans: true,
      batch_size: batchSize,
    };

    const controller = new AbortController();
    // Longer timeout for batch
    const timeoutMs = (this.config.timeoutMs || 30000) * Math.ceil(texts.length / batchSize);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.config.serviceUrl}/extract/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Batch extraction failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as BatchExtractionResponse;
      return data.results;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Batch extraction timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Extract using ALL entity types from ALL domains.
   * Skips domain classification - fastest option.
   * Chunks requests to avoid HTTP/memory issues with large document sets.
   */
  private async extractWithAllDomains(texts: string[], batchSize = 32): Promise<ExtractionResult[]> {
    // Client-side chunking: send max 100 texts per HTTP request to avoid timeouts/OOM
    const CLIENT_CHUNK_SIZE = 100;

    if (texts.length <= CLIENT_CHUNK_SIZE) {
      return this.extractAllDomainsChunk(texts);
    }

    const allResults: ExtractionResult[] = [];
    for (let i = 0; i < texts.length; i += CLIENT_CHUNK_SIZE) {
      const chunk = texts.slice(i, i + CLIENT_CHUNK_SIZE);
      const chunkResults = await this.extractAllDomainsChunk(chunk);
      allResults.push(...chunkResults);
    }
    return allResults;
  }

  /**
   * Send a single chunk to /extract/all endpoint.
   */
  private async extractAllDomainsChunk(texts: string[]): Promise<ExtractionResult[]> {
    const controller = new AbortController();
    const timeoutMs = (this.config.timeoutMs || 30000) * 2;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.config.serviceUrl}/extract/all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(texts),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`All-domains extraction failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as BatchExtractionResponse;
      return data.results;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`All-domains extraction timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Extract with automatic domain detection.
   * Groups texts by detected domain for efficient batch processing.
   * Chunks requests to avoid HTTP/memory issues with large document sets.
   */
  private async extractWithAutoDetection(texts: string[], batchSize = 32): Promise<ExtractionResult[]> {
    // Client-side chunking: send max 100 texts per HTTP request to avoid timeouts/OOM
    const CLIENT_CHUNK_SIZE = 100;

    if (texts.length <= CLIENT_CHUNK_SIZE) {
      // Small batch - send all at once
      return this.extractAutoDetectionChunk(texts);
    }

    // Large batch - chunk into multiple HTTP requests
    const allResults: ExtractionResult[] = [];
    for (let i = 0; i < texts.length; i += CLIENT_CHUNK_SIZE) {
      const chunk = texts.slice(i, i + CLIENT_CHUNK_SIZE);
      const chunkResults = await this.extractAutoDetectionChunk(chunk);
      allResults.push(...chunkResults);
    }
    return allResults;
  }

  /**
   * Send a single chunk to /extract/auto endpoint.
   */
  private async extractAutoDetectionChunk(texts: string[]): Promise<ExtractionResult[]> {
    const controller = new AbortController();
    const timeoutMs = (this.config.timeoutMs || 30000) * 2;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.config.serviceUrl}/extract/auto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(texts),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Auto extraction failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as BatchExtractionResponse;
      return data.results;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Auto extraction timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Classify text into domains using multi-label classification.
   */
  async classifyDomains(
    text: string,
    threshold = 0.3
  ): Promise<Array<{ label: string; confidence: number }>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const url = new URL(`${this.config.serviceUrl}/classify`);
      url.searchParams.set('text', text);
      url.searchParams.set('threshold', String(threshold));

      const response = await fetch(url.toString(), {
        method: 'POST',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Classification failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as { detected_domains?: Array<{ label: string; confidence: number }> };
      return data.detected_domains || [];
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Classification timed out');
      }
      throw error;
    }
  }

  /**
   * Batch classify texts into domains using multi-label classification.
   * More efficient than calling classifyDomains multiple times.
   */
  async classifyDomainsBatch(
    texts: string[],
    threshold = 0.3,
    batchSize = 64
  ): Promise<Array<Array<{ label: string; confidence: number }>>> {
    if (texts.length === 0) {
      return [];
    }

    const controller = new AbortController();
    // Longer timeout for batch
    const timeoutMs = Math.max(30000, texts.length * 500);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.config.serviceUrl}/classify/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(texts),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Batch classification failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as {
        classifications: Array<Array<{ label: string; confidence: number }>>;
      };
      return data.classifications || [];
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Batch classification timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Extract entities from texts using a specific domain's entity types.
   * Fetches the domain preset from the server and uses those entity types.
   */
  async extractBatchWithDomain(
    texts: string[],
    domain: string,
    batchSize = 8
  ): Promise<ExtractionResult[]> {
    return this.extractBatchWithDomains(texts, [domain], batchSize);
  }

  /**
   * Extract entities from texts using multiple domains' entity types (merged).
   * Fetches presets from the server and merges entity types from all domains.
   *
   * @param texts - Texts to extract from
   * @param domains - Array of domain names (e.g., ["legal", "tech"])
   * @param batchSize - Batch size for extraction
   */
  async extractBatchWithDomains(
    texts: string[],
    domains: string[],
    batchSize = 8
  ): Promise<ExtractionResult[]> {
    if (texts.length === 0) {
      return [];
    }

    // Handle 'default' domain - use standard extraction
    if (domains.length === 0 || (domains.length === 1 && domains[0] === 'default')) {
      return this.extractBatch(texts, batchSize);
    }

    // Fetch presets to get entity types for all domains
    const presets = await this.getPresets();
    if (!presets) {
      console.warn(`[EntityClient] Could not fetch presets, using default extraction`);
      return this.extractBatch(texts, batchSize);
    }

    // Merge entity types and relation types from all domains
    const entityTypesSet = new Set<string>();
    const mergedRelationTypes: Record<string, string> = {};

    for (const domain of domains) {
      if (domain === 'default') continue;

      const domainPreset = presets.presets[domain];
      if (!domainPreset) {
        console.warn(`[EntityClient] Domain "${domain}" not found in presets`);
        continue;
      }

      // Handle both array (legacy) and object (with descriptions) formats
      const entityTypes = domainPreset.entity_types;
      if (Array.isArray(entityTypes)) {
        for (const entityType of entityTypes) {
          entityTypesSet.add(entityType);
        }
      } else if (typeof entityTypes === 'object' && entityTypes !== null) {
        // Object format: { "person": "description", ... } - extract keys
        for (const entityType of Object.keys(entityTypes)) {
          entityTypesSet.add(entityType);
        }
      }
      Object.assign(mergedRelationTypes, domainPreset.relation_types);
    }

    // If no valid domains found, use default extraction
    if (entityTypesSet.size === 0) {
      console.warn(`[EntityClient] No valid domains found in [${domains.join(', ')}], using default extraction`);
      return this.extractBatch(texts, batchSize);
    }

    const entityTypes = Array.from(entityTypesSet);
    console.log(`[EntityClient] Extracting with merged domains [${domains.join('|')}]: ${entityTypes.length} entity types`);

    const request: BatchExtractionRequest = {
      texts,
      entity_types: entityTypes,
      relation_types: mergedRelationTypes,
      include_confidence: true,
      include_spans: true,
      batch_size: batchSize,
    };

    const controller = new AbortController();
    const timeoutMs = (this.config.timeoutMs || 30000) * Math.ceil(texts.length / batchSize);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.config.serviceUrl}/extract/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Domain batch extraction failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as BatchExtractionResponse;
      return data.results;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Domain batch extraction timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Get available domain presets from the service.
   */
  async getPresets(): Promise<{
    presets: Record<string, { entity_types: string[] | Record<string, string>; relation_types: Record<string, string> }>;
    available_domains: string[];
  } | null> {
    try {
      const response = await fetch(`${this.config.serviceUrl}/presets`);
      if (!response.ok) return null;
      return (await response.json()) as {
        presets: Record<string, { entity_types: string[] | Record<string, string>; relation_types: Record<string, string> }>;
        available_domains: string[];
      };
    } catch {
      return null;
    }
  }

  /**
   * Get the service configuration including skip_embedding_types.
   */
  async getServiceConfig(): Promise<ServiceConfigResponse | null> {
    try {
      const response = await fetch(`${this.config.serviceUrl}/config`);
      if (!response.ok) return null;
      const config = (await response.json()) as ServiceConfigResponse;
      // Cache skip_embedding_types for later use
      this._skipEmbeddingTypesCache = config.skip_embedding_types || DEFAULT_SKIP_EMBEDDING_TYPES;
      return config;
    } catch {
      return null;
    }
  }

  /**
   * Get domains that have enabled=false (extraction should be skipped).
   * These domains are still detected during classification but no entities are extracted.
   */
  async getDisabledDomains(): Promise<Set<string>> {
    const presets = await this.getPresets();
    if (!presets) return new Set();

    const disabled = new Set<string>();
    for (const [domain, config] of Object.entries(presets.presets)) {
      // Check if domain has enabled: false (default is true/enabled)
      if ((config as any).enabled === false) {
        disabled.add(domain);
      }
    }
    return disabled;
  }

  /**
   * Get entity types that should skip embedding generation.
   * Fetches from service and caches the result.
   * Returns default list if service is unavailable.
   *
   * This is the SINGLE SOURCE OF TRUTH for this list (defined in entity-extraction.yaml).
   */
  async getSkipEmbeddingTypes(): Promise<string[]> {
    // Return cached value if available
    if (this._skipEmbeddingTypesCache !== null) {
      return this._skipEmbeddingTypesCache;
    }

    // Fetch from service
    const config = await this.getServiceConfig();
    if (config?.skip_embedding_types) {
      return config.skip_embedding_types;
    }

    // Fallback to defaults
    this._skipEmbeddingTypesCache = DEFAULT_SKIP_EMBEDDING_TYPES;
    return DEFAULT_SKIP_EMBEDDING_TYPES;
  }

  /**
   * Clear the skip_embedding_types cache (call after config reload).
   */
  clearSkipEmbeddingTypesCache(): void {
    this._skipEmbeddingTypesCache = null;
  }

  /**
   * Update configuration.
   */
  configure(config: Partial<EntityExtractionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration.
   */
  getConfig(): EntityExtractionConfig {
    return { ...this.config };
  }

  /**
   * Load the GLiNER model into GPU memory.
   * Call this before entity extraction to ensure the model is ready.
   */
  async loadModel(): Promise<{ loaded: boolean; wasAlreadyLoaded: boolean }> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s for model loading

      const response = await fetch(`${this.config.serviceUrl}/model/load`, {
        method: 'POST',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error(`[GLiNER] Failed to load model: ${response.status} ${response.statusText}`);
        return { loaded: false, wasAlreadyLoaded: false };
      }

      const data = await response.json() as { status: string; was_loaded: boolean; message: string };
      return { loaded: data.status === 'ok', wasAlreadyLoaded: data.was_loaded };
    } catch (error) {
      console.error('[GLiNER] Failed to load model:', error);
      return { loaded: false, wasAlreadyLoaded: false };
    }
  }

  /**
   * Unload the GLiNER model from GPU to free VRAM.
   * Call this after entity extraction to free memory for Ollama embeddings.
   */
  async unloadModel(): Promise<{ unloaded: boolean; wasLoaded: boolean }> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${this.config.serviceUrl}/model/unload`, {
        method: 'POST',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error(`[GLiNER] Failed to unload model: ${response.status} ${response.statusText}`);
        return { unloaded: false, wasLoaded: false };
      }

      const data = await response.json() as { status: string; was_loaded: boolean; message: string };
      return { unloaded: data.status === 'ok', wasLoaded: data.was_loaded };
    } catch (error) {
      console.error('[GLiNER] Failed to unload model:', error);
      return { unloaded: false, wasLoaded: false };
    }
  }
}

// Singleton instance
let _client: EntityExtractionClient | null = null;

/**
 * Get or create the singleton entity extraction client.
 */
export function getEntityExtractionClient(
  config?: Partial<EntityExtractionConfig>
): EntityExtractionClient {
  if (!_client) {
    _client = new EntityExtractionClient(config);
  } else if (config) {
    _client.configure(config);
  }
  return _client;
}

/**
 * Reset the singleton client (for testing).
 */
export function resetEntityExtractionClient(): void {
  _client = null;
}
