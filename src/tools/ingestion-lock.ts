/**
 * Ingestion Lock - Coordinates file modifications with RAG queries
 *
 * Uses named operations with hash to track multiple concurrent operations.
 * The lock is active as long as AT LEAST ONE operation is in progress.
 * Each operation is identified by type + content hash.
 */

import * as crypto from 'crypto';
import type { AgentLogger } from '../runtime/agents/rag-agent.js';

/**
 * Operation types with their priorities
 * Lower number = higher priority
 */
export const OPERATION_PRIORITIES = {
  'initial-ingest': 1, // Initial project ingestion
  'watcher-batch': 2, // File watcher batch
  'mcp-edit': 3, // Edit via MCP tools
  'manual-ingest': 4, // Manual ingestion
} as const;

export type OperationType = keyof typeof OPERATION_PRIORITIES;

/**
 * A pending operation in the lock
 */
export interface PendingOperation {
  /** Unique key (type:hash) */
  key: string;
  /** Operation type */
  type: OperationType;
  /** Content hash */
  contentHash: string;
  /** Description for logs */
  description: string;
  /** Start timestamp */
  startedAt: Date;
  /** Timeout handle */
  timeoutHandle?: NodeJS.Timeout;
}

/**
 * Current lock status
 */
export interface IngestionStatus {
  /** Lock is active (at least one operation in progress) */
  isLocked: boolean;
  /** Number of operations in progress */
  operationCount: number;
  /** List of operations */
  operations: Array<{
    type: OperationType;
    description: string;
    elapsedMs: number;
  }>;
}

export interface IngestionLockOptions {
  /** Default timeout in ms (0 = no timeout). Default: 30000 */
  defaultTimeout?: number;
  /** Callback when status changes */
  onStatusChange?: (status: IngestionStatus) => void;
  /** Optional AgentLogger for structured logging */
  logger?: AgentLogger;
}

/**
 * Generate a short hash to identify an operation
 */
function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 12);
}

/**
 * Lock with named operations
 *
 * The lock is active as long as there is AT LEAST ONE operation in progress.
 * Each operation is identified by a type + content hash.
 *
 * Usage:
 * ```typescript
 * const lock = new IngestionLock();
 *
 * // Acquire for an operation
 * const opKey = lock.acquire('mcp-edit', 'src/utils.ts');
 * try {
 *   await doWork();
 * } finally {
 *   lock.release(opKey);
 * }
 *
 * // Wait for all operations to complete
 * await lock.waitForUnlock(30000);
 * ```
 */
export class IngestionLock {
  private operations: Map<string, PendingOperation> = new Map();
  private waiters: Array<{ resolve: () => void }> = [];
  private options: Required<Omit<IngestionLockOptions, 'logger'>>;
  private logger?: AgentLogger;

  constructor(options: IngestionLockOptions = {}) {
    this.options = {
      defaultTimeout: options.defaultTimeout ?? 30000,
      onStatusChange: options.onStatusChange ?? (() => {}),
    };
    this.logger = options.logger;
  }

  /**
   * Set or update the logger
   */
  setLogger(logger: AgentLogger): void {
    this.logger = logger;
  }

  /**
   * Check if lock is active (at least one operation in progress)
   */
  isLocked(): boolean {
    return this.operations.size > 0;
  }

  /**
   * Get current status
   */
  getStatus(): IngestionStatus {
    const now = Date.now();
    const operations = Array.from(this.operations.values()).map((op) => ({
      type: op.type,
      description: op.description,
      elapsedMs: now - op.startedAt.getTime(),
    }));

    return {
      isLocked: this.operations.size > 0,
      operationCount: this.operations.size,
      operations,
    };
  }

  /**
   * Acquire the lock for an operation.
   *
   * @param type - Operation type (for priority and logging)
   * @param identifier - Unique identifier (file path, "batch:N files", etc.)
   * @param options - Options (timeout, description)
   * @returns Operation key (pass to release())
   */
  acquire(
    type: OperationType,
    identifier: string,
    options?: {
      description?: string;
      timeoutMs?: number;
    }
  ): string {
    const contentHash = hashContent(identifier);
    const key = `${type}:${contentHash}`;

    // Check if already in progress (avoid duplicates)
    if (this.operations.has(key)) {
      console.warn(`[IngestionLock] Operation already in progress: ${key}`);
      return key;
    }

    const operation: PendingOperation = {
      key,
      type,
      contentHash,
      description: options?.description || identifier,
      startedAt: new Date(),
    };

    // Safety timeout
    const timeout = options?.timeoutMs ?? this.options.defaultTimeout;
    if (timeout > 0) {
      operation.timeoutHandle = setTimeout(() => {
        console.warn(`[IngestionLock] Timeout for ${key}, force releasing`);
        this.logger?.logLock('timeout', operation.description, timeout);
        this.release(key);
      }, timeout);
    }

    this.operations.set(key, operation);
    this.notifyStatusChange();

    // Log acquisition
    this.logger?.logLock('acquired', operation.description);
    console.log(
      `[IngestionLock] Acquired: ${operation.description} ` +
        `(${this.operations.size} active)`
    );

    return key;
  }

  /**
   * Release a specific operation.
   * The global lock is released when ALL operations are complete.
   *
   * @param key - Key returned by acquire()
   */
  release(key: string): void {
    const operation = this.operations.get(key);

    if (!operation) {
      console.warn(`[IngestionLock] Unknown operation: ${key}`);
      return;
    }

    // Clear timeout
    if (operation.timeoutHandle) {
      clearTimeout(operation.timeoutHandle);
    }

    const elapsed = Date.now() - operation.startedAt.getTime();
    this.operations.delete(key);

    // Log release
    this.logger?.logLock('released', operation.description);
    console.log(
      `[IngestionLock] Released: ${operation.description} ` +
        `(${elapsed}ms, ${this.operations.size} remaining)`
    );

    this.notifyStatusChange();

    // If no more operations, wake up waiters
    if (this.operations.size === 0) {
      console.log('[IngestionLock] All operations complete, releasing waiters');
      for (const waiter of this.waiters) {
        waiter.resolve();
      }
      this.waiters = [];
    }
  }

  /**
   * Wait for all operations to complete.
   *
   * @param timeoutMs - Max wait time (default: 30000)
   * @returns true if unlocked, false if timeout
   */
  async waitForUnlock(timeoutMs: number = 30000): Promise<boolean> {
    if (this.operations.size === 0) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const waiter = { resolve: () => resolve(true) };
      this.waiters.push(waiter);

      // Timeout
      const timeout = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        resolve(false);
      }, timeoutMs);

      // Cleanup timeout if resolved before
      const originalResolve = waiter.resolve;
      waiter.resolve = () => {
        clearTimeout(timeout);
        originalResolve();
      };
    });
  }

  /**
   * Check if a specific operation is in progress
   */
  hasOperation(type: OperationType, identifier: string): boolean {
    const contentHash = hashContent(identifier);
    const key = `${type}:${contentHash}`;
    return this.operations.has(key);
  }

  /**
   * Get operations of a given type
   */
  getOperationsByType(type: OperationType): PendingOperation[] {
    return Array.from(this.operations.values()).filter((op) => op.type === type);
  }

  /**
   * Get a readable description for logs/debug
   */
  getDescription(): string {
    if (this.operations.size === 0) {
      return 'No active operations';
    }

    const lines = Array.from(this.operations.values()).map((op) => {
      const elapsed = Date.now() - op.startedAt.getTime();
      return `  - [${op.type}] ${op.description} (${elapsed}ms)`;
    });

    return `${this.operations.size} active operations:\n${lines.join('\n')}`;
  }

  /**
   * Get a user-friendly message about the current status
   */
  getBlockingMessage(): string {
    if (this.operations.size === 0) {
      return '';
    }

    const ops = Array.from(this.operations.values());
    const totalElapsed = Math.max(
      ...ops.map((op) => Date.now() - op.startedAt.getTime())
    );
    const elapsedSec = Math.round(totalElapsed / 1000);

    let msg = `⏳ Ingestion in progress (${this.operations.size} operations, ${elapsedSec}s)`;

    for (const op of ops) {
      const elapsed = Math.round((Date.now() - op.startedAt.getTime()) / 1000);
      msg += `\n   - [${op.type}] ${op.description} (${elapsed}s)`;
    }

    msg += '\n   RAG queries will return fresh data once complete.';

    return msg;
  }

  private notifyStatusChange(): void {
    this.options.onStatusChange(this.getStatus());
  }
}

/**
 * Singleton instance for global ingestion lock coordination
 */
let globalIngestionLock: IngestionLock | null = null;

export function getGlobalIngestionLock(): IngestionLock {
  if (!globalIngestionLock) {
    globalIngestionLock = new IngestionLock({
      onStatusChange: (status) => {
        if (status.isLocked) {
          console.log(
            `🔒 Ingestion lock: ${status.operationCount} operation(s) active`
          );
        } else {
          console.log(`🔓 Ingestion lock: all operations complete`);
        }
      },
    });
  }
  return globalIngestionLock;
}

/**
 * Singleton instance for global embedding lock coordination
 * Separate from ingestion lock to allow non-semantic queries during embedding generation
 */
let globalEmbeddingLock: IngestionLock | null = null;

export function getGlobalEmbeddingLock(): IngestionLock {
  if (!globalEmbeddingLock) {
    globalEmbeddingLock = new IngestionLock({
      onStatusChange: (status) => {
        if (status.isLocked) {
          console.log(
            `🧠 Embedding lock: ${status.operationCount} operation(s) active`
          );
        } else {
          console.log(`🧠 Embedding lock: all operations complete`);
        }
      },
    });
  }
  return globalEmbeddingLock;
}
