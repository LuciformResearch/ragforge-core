/**
 * Batch Processor - Generic utility for parallel batch processing with retry
 *
 * Features:
 * - Concurrency control with pLimit
 * - Exponential backoff with jitter for rate limits
 * - Progress callbacks
 * - Per-item success/failure tracking for resumability
 */

import pLimit from 'p-limit';

export interface BatchProcessorOptions<T, R> {
  /** Items to process */
  items: T[];
  /** Function to process each item */
  processor: (item: T, index: number) => Promise<R>;
  /** Max concurrent operations (default: 5) */
  concurrency?: number;
  /** Max retries per item on rate limit (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for retry backoff (default: 5000) */
  baseDelayMs?: number;
  /** Called after each item completes (success or failure) */
  onProgress?: (progress: BatchProgress<T, R>) => void;
  /** Called when an item fails after all retries */
  onItemError?: (item: T, error: Error, index: number) => void;
  /** Label for logging (e.g., "images", "3D models") */
  label?: string;
}

export interface BatchProgress<T, R> {
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
  currentItem?: T;
  lastResult?: R;
  lastError?: Error;
}

export interface BatchResult<T, R> {
  results: Array<{ item: T; result: R; index: number }>;
  errors: Array<{ item: T; error: Error; index: number }>;
  stats: {
    total: number;
    succeeded: number;
    failed: number;
    durationMs: number;
  };
}

/**
 * Check if an error is a rate limit error
 */
function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('quota') ||
    normalized.includes('429') ||
    normalized.includes('rate limit') ||
    normalized.includes('rate_limit') ||
    normalized.includes('exhausted') ||
    normalized.includes('resource_exhausted') ||
    normalized.includes('too many requests')
  );
}

/**
 * Sleep for a given duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process items in parallel batches with retry logic
 */
export async function processBatch<T, R>(
  options: BatchProcessorOptions<T, R>
): Promise<BatchResult<T, R>> {
  const {
    items,
    processor,
    concurrency = 5,
    maxRetries = 3,
    baseDelayMs = 5000,
    onProgress,
    onItemError,
    label = 'items',
  } = options;

  const startTime = Date.now();
  const limit = pLimit(concurrency);

  const results: Array<{ item: T; result: R; index: number }> = [];
  const errors: Array<{ item: T; error: Error; index: number }> = [];

  let completed = 0;
  let succeeded = 0;
  let failed = 0;

  const processWithRetry = async (item: T, index: number): Promise<void> => {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await processor(item, index);

        succeeded++;
        completed++;
        results.push({ item, result, index });

        if (onProgress) {
          onProgress({
            completed,
            total: items.length,
            succeeded,
            failed,
            currentItem: item,
            lastResult: result,
          });
        }

        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries && isRateLimitError(error)) {
          // Exponential backoff with jitter
          const jitter = Math.random() * 2000;
          const delay = baseDelayMs * Math.pow(1.5, attempt) + jitter;
          console.warn(
            `[BatchProcessor] Rate limited on ${label} (attempt ${attempt + 1}/${maxRetries + 1}), ` +
            `retrying in ${Math.round(delay / 1000)}s...`
          );
          await sleep(delay);
        } else if (attempt < maxRetries && !isRateLimitError(error)) {
          // Non-rate-limit error, don't retry
          break;
        }
      }
    }

    // All retries exhausted or non-retryable error
    failed++;
    completed++;
    errors.push({ item, error: lastError!, index });

    if (onItemError) {
      onItemError(item, lastError!, index);
    }

    if (onProgress) {
      onProgress({
        completed,
        total: items.length,
        succeeded,
        failed,
        currentItem: item,
        lastError,
      });
    }
  };

  // Process all items with concurrency limit
  await Promise.all(
    items.map((item, index) =>
      limit(() => processWithRetry(item, index))
    )
  );

  const durationMs = Date.now() - startTime;

  console.log(
    `[BatchProcessor] Completed ${label}: ${succeeded}/${items.length} succeeded ` +
    `(${failed} failed) in ${Math.round(durationMs / 1000)}s`
  );

  return {
    results,
    errors,
    stats: {
      total: items.length,
      succeeded,
      failed,
      durationMs,
    },
  };
}

/**
 * Chunk an array into smaller arrays of a given size
 */
export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
