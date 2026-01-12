/**
 * Change Detector
 *
 * Centralizes file change detection logic based on content hashes.
 * Used by FileProcessor, IncrementalIngestionManager, and FileWatcher.
 *
 * Features:
 * - Single file change detection
 * - Batch change detection (optimized)
 * - Hash storage/retrieval from Neo4j
 * - Support for both absolutePath and relative path lookups
 *
 * @since 2025-12-13
 */

import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import pLimit from 'p-limit';
import type { Neo4jClient } from '../runtime/client/neo4j-client.js';

// ============================================
// Types
// ============================================

export interface ChangeResult {
  /** Whether the file has changed */
  changed: boolean;
  /** New hash computed from current content */
  newHash: string;
  /** Previous hash from database (if exists) */
  oldHash?: string;
  /** Reason for the change */
  reason: 'new' | 'modified' | 'unchanged' | 'deleted' | 'error';
  /** Error message if reason is 'error' */
  error?: string;
}

export interface BatchChangeResult {
  /** Files that have changed (need processing) */
  changed: Map<string, ChangeResult>;
  /** Files that are unchanged (can be skipped) */
  unchanged: Map<string, ChangeResult>;
  /** Files that encountered errors */
  errors: Map<string, ChangeResult>;
  /** Total files checked */
  totalChecked: number;
  /** Duration in ms */
  durationMs: number;
}

export interface ChangeDetectorConfig {
  /** Neo4j client */
  neo4jClient: Neo4jClient;
  /** Project ID (optional - for filtering) */
  projectId?: string;
  /** Concurrency for batch operations (default: 20) */
  concurrency?: number;
  /** Verbose logging */
  verbose?: boolean;
}

// ============================================
// ChangeDetector
// ============================================

export class ChangeDetector {
  private neo4jClient: Neo4jClient;
  private projectId?: string;
  private concurrency: number;
  private verbose: boolean;

  constructor(config: ChangeDetectorConfig) {
    this.neo4jClient = config.neo4jClient;
    this.projectId = config.projectId;
    this.concurrency = config.concurrency ?? 20;
    this.verbose = config.verbose ?? false;
  }

  /**
   * Check if a single file has changed based on content hash
   *
   * @param absolutePath - Absolute path to the file
   * @returns Change result with hash information
   */
  async hasChanged(absolutePath: string): Promise<ChangeResult> {
    try {
      // Read current file content
      let content: string;
      try {
        content = await fs.readFile(absolutePath, 'utf-8');
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          // File deleted
          const oldHash = await this.getStoredHash(absolutePath);
          return {
            changed: oldHash !== null, // Changed if it existed before
            newHash: '',
            oldHash: oldHash ?? undefined,
            reason: 'deleted',
          };
        }
        throw err;
      }

      // Compute new hash
      const newHash = this.computeHash(content);

      // Get stored hash
      const oldHash = await this.getStoredHash(absolutePath);

      if (oldHash === null) {
        // New file
        return {
          changed: true,
          newHash,
          reason: 'new',
        };
      }

      if (oldHash !== newHash) {
        // Modified file
        return {
          changed: true,
          newHash,
          oldHash,
          reason: 'modified',
        };
      }

      // Unchanged
      return {
        changed: false,
        newHash,
        oldHash,
        reason: 'unchanged',
      };
    } catch (err: any) {
      return {
        changed: false,
        newHash: '',
        reason: 'error',
        error: err.message,
      };
    }
  }

  /**
   * Batch check multiple files for changes
   * More efficient than checking one by one
   *
   * @param absolutePaths - Array of absolute paths to check
   * @returns Batch result with changed, unchanged, and error maps
   */
  async detectChanges(absolutePaths: string[]): Promise<BatchChangeResult> {
    const startTime = Date.now();
    const limit = pLimit(this.concurrency);

    const changed = new Map<string, ChangeResult>();
    const unchanged = new Map<string, ChangeResult>();
    const errors = new Map<string, ChangeResult>();

    // First, get all stored hashes in one query (batch optimization)
    const storedHashes = await this.getStoredHashesBatch(absolutePaths);

    // Then check each file in parallel
    await Promise.all(
      absolutePaths.map(filePath =>
        limit(async () => {
          try {
            // Read file
            let content: string;
            try {
              content = await fs.readFile(filePath, 'utf-8');
            } catch (err: any) {
              if (err.code === 'ENOENT') {
                const oldHash = storedHashes.get(filePath);
                const result: ChangeResult = {
                  changed: oldHash !== undefined,
                  newHash: '',
                  oldHash,
                  reason: 'deleted',
                };
                if (result.changed) {
                  changed.set(filePath, result);
                }
                return;
              }
              throw err;
            }

            // Compute hash
            const newHash = this.computeHash(content);
            const oldHash = storedHashes.get(filePath);

            let result: ChangeResult;

            if (oldHash === undefined) {
              result = { changed: true, newHash, reason: 'new' };
              changed.set(filePath, result);
            } else if (oldHash !== newHash) {
              result = { changed: true, newHash, oldHash, reason: 'modified' };
              changed.set(filePath, result);
            } else {
              result = { changed: false, newHash, oldHash, reason: 'unchanged' };
              unchanged.set(filePath, result);
            }
          } catch (err: any) {
            errors.set(filePath, {
              changed: false,
              newHash: '',
              reason: 'error',
              error: err.message,
            });
          }
        })
      )
    );

    const durationMs = Date.now() - startTime;

    if (this.verbose) {
      console.log(
        `[ChangeDetector] Checked ${absolutePaths.length} files: ` +
        `${changed.size} changed, ${unchanged.size} unchanged, ${errors.size} errors (${durationMs}ms)`
      );
    }

    return {
      changed,
      unchanged,
      errors,
      totalChecked: absolutePaths.length,
      durationMs,
    };
  }

  /**
   * Get stored hash for a file from Neo4j
   *
   * @param absolutePath - Absolute path to the file
   * @returns Stored hash or null if not found
   */
  async getStoredHash(absolutePath: string): Promise<string | null> {
    const query = this.projectId
      ? `
        MATCH (f:File {absolutePath: $absolutePath, projectId: $projectId})
        RETURN f.hash AS hash
        `
      : `
        MATCH (f:File {absolutePath: $absolutePath})
        RETURN f.hash AS hash
        `;

    const result = await this.neo4jClient.run(query, {
      absolutePath,
      projectId: this.projectId,
    });

    return result.records[0]?.get('hash') || null;
  }

  /**
   * Get stored hashes for multiple files (batch query)
   *
   * @param absolutePaths - Array of absolute paths
   * @returns Map of absolutePath -> hash
   */
  async getStoredHashesBatch(absolutePaths: string[]): Promise<Map<string, string>> {
    if (absolutePaths.length === 0) {
      return new Map();
    }

    const query = this.projectId
      ? `
        MATCH (f:File)
        WHERE f.absolutePath IN $absolutePaths AND f.projectId = $projectId
        RETURN f.absolutePath AS path, f.hash AS hash
        `
      : `
        MATCH (f:File)
        WHERE f.absolutePath IN $absolutePaths
        RETURN f.absolutePath AS path, f.hash AS hash
        `;

    const result = await this.neo4jClient.run(query, {
      absolutePaths,
      projectId: this.projectId,
    });

    const hashes = new Map<string, string>();
    for (const record of result.records) {
      const path = record.get('path');
      const hash = record.get('hash');
      if (path && hash) {
        hashes.set(path, hash);
      }
    }

    return hashes;
  }

  /**
   * Update stored hash for a file
   *
   * @param absolutePath - Absolute path to the file
   * @param hash - New hash to store
   */
  async updateHash(absolutePath: string, hash: string): Promise<void> {
    const query = this.projectId
      ? `
        MATCH (f:File {absolutePath: $absolutePath, projectId: $projectId})
        SET f.hash = $hash
        `
      : `
        MATCH (f:File {absolutePath: $absolutePath})
        SET f.hash = $hash
        `;

    await this.neo4jClient.run(query, {
      absolutePath,
      hash,
      projectId: this.projectId,
    });
  }

  /**
   * Update stored hashes for multiple files (batch)
   *
   * @param updates - Map of absolutePath -> hash
   */
  async updateHashesBatch(updates: Map<string, string>): Promise<void> {
    if (updates.size === 0) return;

    const data = Array.from(updates.entries()).map(([path, hash]) => ({
      path,
      hash,
    }));

    const query = this.projectId
      ? `
        UNWIND $data AS item
        MATCH (f:File {absolutePath: item.path, projectId: $projectId})
        SET f.hash = item.hash
        `
      : `
        UNWIND $data AS item
        MATCH (f:File {absolutePath: item.path})
        SET f.hash = item.hash
        `;

    await this.neo4jClient.run(query, {
      data,
      projectId: this.projectId,
    });
  }

  /**
   * Check if any files in a list have changed
   * Quick check that stops at first change found
   *
   * @param absolutePaths - Array of absolute paths to check
   * @returns true if at least one file has changed
   */
  async hasAnyChanged(absolutePaths: string[]): Promise<boolean> {
    const storedHashes = await this.getStoredHashesBatch(absolutePaths);

    for (const filePath of absolutePaths) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const newHash = this.computeHash(content);
        const oldHash = storedHashes.get(filePath);

        if (oldHash === undefined || oldHash !== newHash) {
          return true;
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          // File deleted = changed
          if (storedHashes.has(filePath)) {
            return true;
          }
        }
        // Other errors - continue checking
      }
    }

    return false;
  }

  /**
   * Compute content hash (SHA-256, truncated)
   */
  computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  /**
   * Create a ChangeDetector for a specific project
   */
  static forProject(neo4jClient: Neo4jClient, projectId: string, options?: {
    concurrency?: number;
    verbose?: boolean;
  }): ChangeDetector {
    return new ChangeDetector({
      neo4jClient,
      projectId,
      ...options,
    });
  }
}
