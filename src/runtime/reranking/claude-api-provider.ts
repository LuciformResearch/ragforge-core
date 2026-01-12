/**
 * Claude API Provider for LLM Generation
 *
 * Uses Anthropic's Claude API for text generation.
 * Implements LLMProvider interface for use with StructuredLLMExecutor.
 *
 * Features:
 * - Rate limiting with retry logic
 * - Batch processing with parallel execution
 * - Support for all Claude models
 *
 * @since 2025-01-03
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, LLMProviderConfig } from "./llm-provider.js";

export type RateLimitStrategy = "proactive" | "reactive" | "none";

export interface ClaudeAPIConfig extends LLMProviderConfig {
  apiKey: string;
  retryAttempts?: number;
  retryDelay?: number;
  rateLimitStrategy?: RateLimitStrategy;
}

export class ClaudeAPIProvider implements LLMProvider {
  private client: Anthropic;
  private modelName: string;
  private temperature: number;
  private maxOutputTokens: number;
  private retryAttempts: number;
  private retryDelay: number;
  private rateLimitStrategy: RateLimitStrategy;
  private requestTimestamps: number[] = [];

  constructor(config: ClaudeAPIConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.modelName = config.model;
    this.temperature = config.temperature ?? 0.3;
    this.maxOutputTokens = config.maxOutputTokens ?? 4096;
    this.retryAttempts = config.retryAttempts ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
    this.rateLimitStrategy = config.rateLimitStrategy ?? "reactive";
  }

  async generateContent(prompt: string, requestId: string): Promise<string> {
    if (!requestId) {
      throw new Error(
        "requestId is required for LLM calls. This helps trace why an LLM call was made."
      );
    }

    const promptSize = prompt.length;
    const promptTokens = Math.ceil(promptSize / 4);

    console.log(
      `[ClaudeAPIProvider] 📤 Sending request [${requestId}] | Prompt: ${promptSize} chars (~${promptTokens} tokens) | ` +
        `MaxOutput: ${this.maxOutputTokens} tokens | Model: ${this.modelName}`
    );

    const startTime = Date.now();

    // Add jitter to avoid thundering herd
    const jitter = 500 + Math.random() * 500;
    await this.sleep(jitter);

    // Track request timestamp for reactive strategy
    if (this.rateLimitStrategy === "reactive") {
      this.requestTimestamps.push(Date.now());
    }

    const result = await this.withRetry(async () => {
      const response = await this.client.messages.create({
        model: this.modelName,
        max_tokens: this.maxOutputTokens,
        temperature: this.temperature,
        messages: [{ role: "user", content: prompt }],
      });

      // Extract text from response
      const textBlocks = response.content.filter(
        (block) => block.type === "text"
      );
      if (textBlocks.length === 0) {
        throw new Error("No text in response");
      }

      return textBlocks.map((b) => (b as any).text).join("\n");
    });

    // Success cleanup
    if (this.rateLimitStrategy === "reactive") {
      const thirtySecondsAgo = Date.now() - 30000;
      this.requestTimestamps = this.requestTimestamps.filter(
        (ts) => ts > thirtySecondsAgo
      );
    }

    const duration = Date.now() - startTime;
    console.log(
      `[ClaudeAPIProvider] 📥 Response received [${requestId}] | Response: ${result.length} chars | Duration: ${duration}ms`
    );

    return result;
  }

  /**
   * Execute with retry logic for rate limits
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: any;

    for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
      try {
        if (attempt > 0) {
          console.log(
            `[ClaudeAPIProvider] 🔄 Retry attempt ${attempt}/${this.retryAttempts}`
          );
        }
        return await fn();
      } catch (error: any) {
        lastError = error;

        // Check if it's a rate limit error
        const isRateLimit =
          error.status === 429 ||
          error.message?.includes("rate_limit") ||
          error.message?.includes("overloaded");

        console.log(
          `[ClaudeAPIProvider] ❌ Attempt ${attempt + 1}/${this.retryAttempts + 1} failed. ` +
            `Is rate limit: ${isRateLimit}, Error: ${error.message?.substring(0, 100)}`
        );

        if (!isRateLimit || attempt === this.retryAttempts) {
          console.log(
            `[ClaudeAPIProvider] 🛑 Giving up after ${attempt + 1} attempts`
          );
          throw new Error(`Claude API generation failed: ${error.message}`);
        }

        // Calculate retry delay with exponential backoff
        let retryAfter = this.retryDelay * Math.pow(2, attempt);

        // Check for retry-after header
        if (error.headers?.["retry-after"]) {
          const suggestedDelay =
            parseInt(error.headers["retry-after"], 10) * 1000;
          retryAfter = Math.max(retryAfter, suggestedDelay);
        }

        // Cap at 60 seconds
        retryAfter = Math.min(retryAfter, 60000);

        console.warn(
          `[ClaudeAPIProvider] Rate limit hit. Waiting ${retryAfter}ms...`
        );

        await this.sleep(retryAfter);
      }
    }

    throw new Error(
      `Claude API generation failed after ${this.retryAttempts + 1} attempts: ${lastError.message}`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async generateBatch(prompts: string[], requestId: string): Promise<string[]> {
    if (!requestId) {
      throw new Error(
        "requestId is required for LLM batch calls. This helps trace why an LLM call was made."
      );
    }

    // Execute in parallel with concurrency limit
    const concurrencyLimit = 5; // Claude has generous rate limits
    const results: string[] = new Array(prompts.length);

    for (let i = 0; i < prompts.length; i += concurrencyLimit) {
      const batch = prompts.slice(i, i + concurrencyLimit);
      const batchResults = await Promise.all(
        batch.map((p, j) =>
          this.generateContent(p, `${requestId}-batch-${i + j + 1}`)
        )
      );
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
    }

    return results;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.generateContent("test", `availability-check-${Date.now()}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a default provider using environment variables
   */
  static fromEnv(
    model: string = "claude-3-5-haiku-20241022"
  ): ClaudeAPIProvider {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable not set");
    }

    return new ClaudeAPIProvider({
      apiKey,
      model,
      temperature: 0.3,
      maxOutputTokens: 4096,
    });
  }
}
