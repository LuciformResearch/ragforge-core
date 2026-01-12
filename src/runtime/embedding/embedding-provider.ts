/**
 * Embedding Providers
 *
 * Supports multiple embedding providers:
 * - Gemini (cloud, requires API key)
 * - Ollama (local, free)
 */

import { GoogleGenAI } from '@google/genai';
import pLimit from 'p-limit';

/**
 * Common interface for all embedding providers
 */
export interface EmbeddingProviderInterface {
  getProviderName(): string;
  getModelName(): string;
  embed(texts: string[], overrides?: { model?: string; dimension?: number }): Promise<number[][]>;
  embedSingle(text: string, overrides?: { model?: string; dimension?: number }): Promise<number[]>;
}

/**
 * Gemini embedding provider options
 */
export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  dimension?: number;
  batching?: {
    size?: number;
  };
}

/**
 * Native Gemini Embedding Provider using @google/genai
 */
export class GeminiEmbeddingProvider {
  private client: GoogleGenAI;
  private model: string;
  private dimension?: number;
  private batchSize: number;

  constructor(options: GeminiProviderOptions) {
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model || 'gemini-embedding-001';
    this.dimension = options.dimension;
    this.batchSize = options.batching?.size ?? 100;
  }

  getProviderName(): string {
    return 'gemini';
  }

  getModelName(): string {
    return this.model;
  }

  async embed(
    texts: string[],
    overrides?: { model?: string; dimension?: number }
  ): Promise<number[][]> {
    const model = overrides?.model || this.model;
    const dimension = overrides?.dimension ?? this.dimension;

    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      batches.push(texts.slice(i, i + this.batchSize));
    }

    console.log(`[Embedding] ${texts.length} texts → ${batches.length} batches`);
    const startTime = Date.now();

    const limit = pLimit(5);

    const retryWithBackoff = async <T>(
      fn: () => Promise<T>,
      maxRetries = 5,
      baseDelay = 60000 // 1 minute - Gemini rate limits are per-minute
    ): Promise<T> => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (error: any) {
          const isRateLimit =
            error.message?.includes('429') ||
            error.message?.includes('rate') ||
            error.message?.includes('quota') ||
            error.message?.includes('RESOURCE_EXHAUSTED');
          if (attempt < maxRetries && isRateLimit) {
            // Add jitter (0-10s) to avoid thundering herd
            const jitter = Math.random() * 10000;
            const delay = baseDelay * Math.pow(1.5, attempt) + jitter;
            console.warn(`[Embedding] Rate limited, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`);
            await new Promise(r => setTimeout(r, delay));
          } else {
            throw error;
          }
        }
      }
      throw new Error('Max retries exceeded');
    };

    const batchResults = await Promise.all(
      batches.map((batch, batchNum) =>
        limit(async () => {
          const batchStart = Date.now();
          const response = await retryWithBackoff(() =>
            this.client.models.embedContent({
              model,
              contents: batch.map(text => ({ parts: [{ text }] })),
              config: dimension ? { outputDimensionality: dimension } : undefined,
            })
          );

          const embeddings: number[][] = [];
          if (response.embeddings) {
            for (const embedding of response.embeddings) {
              if (embedding.values) {
                embeddings.push(embedding.values);
              }
            }
          }
          console.log(`[Embedding] Batch ${batchNum + 1}/${batches.length}: ${batch.length} texts in ${Date.now() - batchStart}ms`);
          return embeddings;
        })
      )
    );

    const results = batchResults.flat();
    console.log(`[Embedding] Total: ${results.length} embeddings in ${Date.now() - startTime}ms`);

    return results;
  }

  async embedSingle(text: string, overrides?: { model?: string; dimension?: number }): Promise<number[]> {
    const embeddings = await this.embed([text], overrides);
    return embeddings[0];
  }
}

// Legacy exports for compatibility
export type EmbeddingProviderOptions = GeminiProviderOptions;
export const EmbeddingProvider = GeminiEmbeddingProvider;
export type EmbeddingProviderType = GeminiEmbeddingProvider;
