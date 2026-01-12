/**
 * Ollama Embedding Provider
 *
 * Uses Ollama's local API for embeddings - free and private.
 * Requires Ollama to be running locally with an embedding model pulled.
 *
 * Uses the new /api/embed endpoint which supports batch embeddings natively.
 * See: https://docs.ollama.com/capabilities/embeddings
 *
 * Recommended models:
 * - nomic-embed-text (768 dimensions, good quality)
 * - mxbai-embed-large (1024 dimensions, better quality)
 * - all-minilm (384 dimensions, fast)
 */

import pLimit from 'p-limit';

export interface OllamaProviderOptions {
  /** Ollama API base URL (default: http://localhost:11434) */
  baseUrl?: string;
  /** Model name (default: nomic-embed-text) */
  model?: string;
  /** Batch size for API calls (default: 50 texts per call) */
  batchSize?: number;
  /** Max concurrent API calls (default: 5) */
  concurrency?: number;
  /** Request timeout in ms (default: 60000) */
  timeout?: number;
  /** Truncate inputs that exceed context length (default: true) */
  truncate?: boolean;
}

export class OllamaEmbeddingProvider {
  private baseUrl: string;
  private model: string;
  private batchSize: number;
  private concurrency: number;
  private timeout: number;
  private truncate: boolean;

  constructor(options: OllamaProviderOptions = {}) {
    this.baseUrl = options.baseUrl || 'http://localhost:11434';
    this.model = options.model || 'nomic-embed-text';
    this.batchSize = options.batchSize ?? 50; // Texts per API call
    this.concurrency = options.concurrency ?? 5; // Parallel API calls
    this.timeout = options.timeout ?? 60000;
    this.truncate = options.truncate ?? true;
  }

  getProviderName(): string {
    return 'ollama';
  }

  getModelName(): string {
    return this.model;
  }

  /**
   * Generate embeddings for a batch of texts using /api/embed
   * This is the new batch endpoint that accepts multiple inputs
   */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          truncate: this.truncate,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${error}`);
      }

      const data = (await response.json()) as { embeddings: number[][] };
      return data.embeddings;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Generate embeddings for multiple texts
   * Uses the new /api/embed batch endpoint for efficiency
   */
  async embed(
    texts: string[],
    overrides?: { model?: string }
  ): Promise<number[][]> {
    const originalModel = this.model;
    if (overrides?.model) {
      this.model = overrides.model;
    }

    try {
      // Split into batches
      const batches: string[][] = [];
      for (let i = 0; i < texts.length; i += this.batchSize) {
        batches.push(texts.slice(i, i + this.batchSize));
      }

      const startTime = Date.now();
      const limit = pLimit(this.concurrency);

      // Run batch API calls in parallel with concurrency limit
      const batchResults = await Promise.all(
        batches.map(batch => limit(() => this.embedBatch(batch)))
      );

      const allEmbeddings = batchResults.flat();

      // Only log summary if it took more than 2 seconds
      const elapsed = Date.now() - startTime;
      if (elapsed > 2000) {
        console.log(`[Embedding:Ollama] ${allEmbeddings.length} embeddings in ${elapsed}ms (${Math.round(allEmbeddings.length / (elapsed / 1000))}/s)`);
      }
      return allEmbeddings;
    } finally {
      this.model = originalModel;
    }
  }

  async embedSingle(text: string, overrides?: { model?: string }): Promise<number[]> {
    const embeddings = await this.embed([text], overrides);
    return embeddings[0];
  }

  /**
   * Check if Ollama is running and the model is available
   */
  async checkHealth(): Promise<{ ok: boolean; error?: string }> {
    try {
      // Check if Ollama is running
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return { ok: false, error: `Ollama not responding: ${response.status}` };
      }

      const data = (await response.json()) as { models?: Array<{ name: string }> };
      const models = data.models || [];
      const modelNames = models.map(m => m.name.split(':')[0]);

      if (!modelNames.includes(this.model.split(':')[0])) {
        return {
          ok: false,
          error: `Model '${this.model}' not found. Available: ${modelNames.join(', ')}. Run: ollama pull ${this.model}`,
        };
      }

      return { ok: true };
    } catch (error: any) {
      return {
        ok: false,
        error: `Cannot connect to Ollama at ${this.baseUrl}: ${error.message}`,
      };
    }
  }
}
