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
 * Client for the GLiNER entity extraction microservice.
 */
export class EntityExtractionClient {
  private config: EntityExtractionConfig;

  constructor(config: Partial<EntityExtractionConfig> = {}) {
    this.config = { ...DEFAULT_ENTITY_EXTRACTION_CONFIG, ...config };
  }

  /**
   * Check if the GLiNER service is available.
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
      return data.status === 'ok' && data.model_loaded;
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
   * Get available domain presets from the service.
   */
  async getPresets(): Promise<{
    presets: Record<string, { entity_types: string[]; relation_types: Record<string, string> }>;
    available_domains: string[];
  } | null> {
    try {
      const response = await fetch(`${this.config.serviceUrl}/presets`);
      if (!response.ok) return null;
      return (await response.json()) as {
        presets: Record<string, { entity_types: string[]; relation_types: Record<string, string> }>;
        available_domains: string[];
      };
    } catch {
      return null;
    }
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
