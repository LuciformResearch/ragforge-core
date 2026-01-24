/**
 * TEI (Text Embeddings Inference) Embedding Provider
 *
 * Uses HuggingFace's TEI server for fast, GPU-accelerated embeddings.
 * Requires TEI to be running (via Docker).
 *
 * API Docs: https://huggingface.github.io/text-embeddings-inference/
 *
 * Recommended models:
 * - BAAI/bge-base-en-v1.5 (768 dimensions, good balance)
 * - BAAI/bge-small-en-v1.5 (384 dimensions, faster)
 * - BAAI/bge-large-en-v1.5 (1024 dimensions, best quality)
 */

import pLimit from 'p-limit';

export interface TEIProviderOptions {
  /** TEI API base URL (default: http://localhost:8081) */
  baseUrl?: string;
  /** Batch size for API calls (default: 32, TEI's default max) */
  batchSize?: number;
  /** Max concurrent API calls (default: 5) */
  concurrency?: number;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Truncate inputs that exceed model's max length (default: true) */
  truncate?: boolean;
}

// Rough estimate: 1 token ≈ 4 chars for code (conservative)
const CHARS_PER_TOKEN = 4;

export class TEIEmbeddingProvider {
  private baseUrl: string;
  private batchSize: number;
  private concurrency: number;
  private timeout: number;
  private truncate: boolean;
  private modelInfo: { model_id?: string; max_input_length?: number } | null = null;
  private modelInfoFetched = false;
  private truncationWarnings = 0;

  constructor(options: TEIProviderOptions = {}) {
    this.baseUrl = options.baseUrl || 'http://localhost:8081';
    this.batchSize = options.batchSize ?? 32; // TEI default max_client_batch_size
    this.concurrency = options.concurrency ?? 5;
    this.timeout = options.timeout ?? 30000;
    this.truncate = options.truncate ?? true;
  }

  /**
   * Get max input length in tokens (fetches from TEI if not cached)
   */
  async getMaxInputLength(): Promise<number> {
    if (!this.modelInfoFetched) {
      await this.fetchModelInfo();
    }
    return this.modelInfo?.max_input_length ?? 512;
  }

  /**
   * Fetch model info from TEI server
   */
  private async fetchModelInfo(): Promise<void> {
    if (this.modelInfoFetched) return;
    try {
      const response = await fetch(`${this.baseUrl}/info`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        this.modelInfo = await response.json() as { model_id?: string; max_input_length?: number };
      }
    } catch {
      // Ignore - will use defaults
    }
    this.modelInfoFetched = true;
  }

  getProviderName(): string {
    return 'tei';
  }

  getModelName(): string {
    return this.modelInfo?.model_id || 'unknown';
  }

  /**
   * Generate embeddings for a batch of texts
   * TEI endpoint: POST /embed with {"inputs": [...]}
   */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    // Fetch model info if not already done
    if (!this.modelInfoFetched) {
      await this.fetchModelInfo();
    }

    // Check for texts that will be truncated
    const maxTokens = this.modelInfo?.max_input_length ?? 512;
    const maxCharsEstimate = maxTokens * CHARS_PER_TOKEN;

    for (const text of texts) {
      if (text.length > maxCharsEstimate) {
        this.truncationWarnings++;
        if (this.truncationWarnings <= 5) {
          console.warn(
            `[TEI] ⚠️ Text will be truncated: ${text.length} chars > ~${maxCharsEstimate} chars (${maxTokens} tokens). ` +
            `First 50 chars: "${text.slice(0, 50).replace(/\n/g, '\\n')}..."`
          );
        } else if (this.truncationWarnings === 6) {
          console.warn(`[TEI] ⚠️ Suppressing further truncation warnings...`);
        }
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: texts,
          truncate: this.truncate,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`TEI API error: ${response.status} - ${error}`);
      }

      // TEI returns array of arrays directly: [[...], [...], ...]
      const embeddings = (await response.json()) as number[][];
      return embeddings;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Generate embeddings for multiple texts
   */
  async embed(
    texts: string[],
    _overrides?: { model?: string; dimension?: number }
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Split into batches
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      batches.push(texts.slice(i, i + this.batchSize));
    }

    const startTime = Date.now();
    const limit = pLimit(this.concurrency);

    // Run batch API calls in parallel with concurrency limit
    const batchResults = await Promise.all(
      batches.map((batch, i) =>
        limit(async () => {
          const result = await this.embedBatch(batch);
          if (batches.length > 1) {
            console.log(`[Embedding:TEI] Batch ${i + 1}/${batches.length}: ${batch.length} texts`);
          }
          return result;
        })
      )
    );

    const allEmbeddings = batchResults.flat();

    // Log summary
    const elapsed = Date.now() - startTime;
    if (elapsed > 1000 || texts.length > 10) {
      const rate = Math.round(allEmbeddings.length / (elapsed / 1000));
      console.log(`[Embedding:TEI] ${allEmbeddings.length} embeddings in ${elapsed}ms (${rate}/s)`);
    }

    return allEmbeddings;
  }

  async embedSingle(
    text: string,
    overrides?: { model?: string; dimension?: number }
  ): Promise<number[]> {
    const embeddings = await this.embed([text], overrides);
    return embeddings[0];
  }

  /**
   * Check if TEI is running and get model info
   */
  async checkHealth(): Promise<{ ok: boolean; error?: string; info?: Record<string, unknown> }> {
    try {
      const response = await fetch(`${this.baseUrl}/info`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return { ok: false, error: `TEI not responding: ${response.status}` };
      }

      const info = (await response.json()) as {
        model_id: string;
        max_input_length: number;
        model_dtype: string;
      };

      this.modelInfo = info;

      return {
        ok: true,
        info: {
          model: info.model_id,
          maxInputLength: info.max_input_length,
          dtype: info.model_dtype,
        },
      };
    } catch (error: any) {
      return {
        ok: false,
        error: `Cannot connect to TEI at ${this.baseUrl}: ${error.message}`,
      };
    }
  }

  /**
   * Get embedding dimensions by generating a test embedding
   */
  async getDimensions(): Promise<number> {
    const testEmbedding = await this.embedSingle('test');
    return testEmbedding.length;
  }
}
