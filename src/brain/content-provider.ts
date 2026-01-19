/**
 * Content Provider Interface
 *
 * Abstracts file content reading to support both:
 * - Disk-based files (traditional file system)
 * - Virtual files (content stored in Neo4j _rawContent)
 *
 * This abstraction allows the FileProcessor and UnifiedProcessor to work
 * with virtual projects (like GitHub clones, ZIP uploads) without requiring
 * actual files on disk.
 *
 * @since 2026-01-18
 */

import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import type { Neo4jClient } from '../runtime/client/neo4j-client.js';
import type { FileState } from './file-state-machine.js';

// ============================================
// Types
// ============================================

/**
 * Minimal file info needed by content providers
 */
export interface ContentFileInfo {
  /** File UUID in Neo4j */
  uuid: string;
  /** Absolute path (required for disk, optional for virtual) */
  absolutePath?: string;
  /** Project ID */
  projectId?: string;
  /** Current state in the pipeline */
  state?: FileState;
  /** Whether this is a virtual file (no disk path) */
  isVirtual?: boolean;
}

/**
 * Result of reading content
 */
export interface ContentReadResult {
  /** File content as string */
  content: string;
  /** Content hash (for change detection) */
  hash: string;
}

/**
 * Result of batch reading
 */
export interface BatchContentResult {
  /** Map of uuid -> content */
  contents: Map<string, string>;
  /** Map of uuid -> hash */
  hashes: Map<string, string>;
  /** UUIDs that failed to read */
  errors: Set<string>;
}

// ============================================
// Interface
// ============================================

/**
 * Interface for content providers
 *
 * Implementations:
 * - DiskContentProvider: reads from file system
 * - VirtualContentProvider: reads from Neo4j _rawContent
 */
export interface IContentProvider {
  /**
   * Read content for a single file
   * @throws Error if file doesn't exist or can't be read
   */
  readContent(file: ContentFileInfo): Promise<string>;

  /**
   * Read content and compute hash
   */
  readContentWithHash(file: ContentFileInfo): Promise<ContentReadResult>;

  /**
   * Check if file exists and is readable
   */
  exists(file: ContentFileInfo): Promise<boolean>;

  /**
   * Compute hash of file content without storing it
   */
  computeHash(file: ContentFileInfo): Promise<string>;

  /**
   * Get stored hash (from Neo4j or cache)
   */
  getStoredHash(file: ContentFileInfo): Promise<string | null>;

  /**
   * Batch read multiple files (optimized for virtual provider)
   */
  readContentBatch(files: ContentFileInfo[]): Promise<BatchContentResult>;

  /**
   * Provider type identifier
   */
  readonly type: 'disk' | 'virtual';
}

// ============================================
// Disk Content Provider
// ============================================

/**
 * Reads file content from the file system
 *
 * This is the default provider for disk-based projects.
 */
export class DiskContentProvider implements IContentProvider {
  readonly type = 'disk' as const;

  constructor(
    private neo4jClient?: Neo4jClient,
    private projectId?: string
  ) {}

  async readContent(file: ContentFileInfo): Promise<string> {
    if (!file.absolutePath) {
      throw new Error(`DiskContentProvider requires absolutePath for file ${file.uuid}`);
    }
    return fs.readFile(file.absolutePath, 'utf-8');
  }

  async readContentWithHash(file: ContentFileInfo): Promise<ContentReadResult> {
    const content = await this.readContent(file);
    const hash = this.hashContent(content);
    return { content, hash };
  }

  async exists(file: ContentFileInfo): Promise<boolean> {
    if (!file.absolutePath) return false;
    try {
      await fs.access(file.absolutePath);
      return true;
    } catch {
      return false;
    }
  }

  async computeHash(file: ContentFileInfo): Promise<string> {
    const content = await this.readContent(file);
    return this.hashContent(content);
  }

  async getStoredHash(file: ContentFileInfo): Promise<string | null> {
    if (!this.neo4jClient) return null;

    const projectId = file.projectId || this.projectId;
    if (!projectId || !file.absolutePath) return null;

    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {absolutePath: $absolutePath, projectId: $projectId})
      RETURN f.hash AS hash
      `,
      { absolutePath: file.absolutePath, projectId }
    );

    return result.records[0]?.get('hash') || null;
  }

  async readContentBatch(files: ContentFileInfo[]): Promise<BatchContentResult> {
    const contents = new Map<string, string>();
    const hashes = new Map<string, string>();
    const errors = new Set<string>();

    // Parallel read with individual error handling
    await Promise.all(
      files.map(async (file) => {
        try {
          const content = await this.readContent(file);
          const hash = this.hashContent(content);
          contents.set(file.uuid, content);
          hashes.set(file.uuid, hash);
        } catch {
          errors.add(file.uuid);
        }
      })
    );

    return { contents, hashes, errors };
  }

  /**
   * Compute SHA256 hash truncated to 16 chars
   */
  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }
}

// ============================================
// Virtual Content Provider
// ============================================

/**
 * Reads file content from Neo4j _rawContent property
 *
 * This provider is used for virtual projects where files are stored
 * directly in the graph database (e.g., GitHub clones, ZIP uploads).
 *
 * Virtual files are identified by:
 * - Having _rawContent property on File node
 * - May or may not have absolutePath (path is virtual/synthetic)
 */
export class VirtualContentProvider implements IContentProvider {
  readonly type = 'virtual' as const;

  constructor(
    private neo4jClient: Neo4jClient,
    private projectId?: string
  ) {}

  async readContent(file: ContentFileInfo): Promise<string> {
    // Support both uuid and absolutePath lookup
    let result;
    if (file.uuid) {
      result = await this.neo4jClient.run(
        `
        MATCH (f:File {uuid: $uuid})
        RETURN f._rawContent AS content
        `,
        { uuid: file.uuid }
      );
    } else if (file.absolutePath) {
      // Fallback to absolutePath when uuid is not available
      const projectId = file.projectId || this.projectId;
      result = await this.neo4jClient.run(
        `
        MATCH (f:File)
        WHERE (f.absolutePath = $path OR f.file = $path)
          AND ($projectId IS NULL OR f.projectId = $projectId)
        RETURN f._rawContent AS content
        `,
        { path: file.absolutePath, projectId: projectId || null }
      );
    } else {
      throw new Error('VirtualContentProvider requires either uuid or absolutePath');
    }

    const content = result.records[0]?.get('content');
    if (content === null || content === undefined) {
      throw new Error(`No _rawContent for virtual file ${file.uuid || file.absolutePath}`);
    }
    return content;
  }

  async readContentWithHash(file: ContentFileInfo): Promise<ContentReadResult> {
    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {uuid: $uuid})
      RETURN f._rawContent AS content, f._rawContentHash AS hash
      `,
      { uuid: file.uuid }
    );

    const content = result.records[0]?.get('content');
    let hash = result.records[0]?.get('hash');

    if (content === null || content === undefined) {
      throw new Error(`No _rawContent for virtual file ${file.uuid}`);
    }

    // Compute hash if not stored
    if (!hash) {
      hash = this.hashContent(content);
    }

    return { content, hash };
  }

  async exists(file: ContentFileInfo): Promise<boolean> {
    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {uuid: $uuid})
      RETURN f._rawContent IS NOT NULL AS exists
      `,
      { uuid: file.uuid }
    );

    return result.records[0]?.get('exists') ?? false;
  }

  async computeHash(file: ContentFileInfo): Promise<string> {
    // For virtual files, prefer stored hash
    const storedHash = await this.getStoredHash(file);
    if (storedHash) return storedHash;

    // Fall back to computing from content
    const content = await this.readContent(file);
    return this.hashContent(content);
  }

  async getStoredHash(file: ContentFileInfo): Promise<string | null> {
    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {uuid: $uuid})
      RETURN f._rawContentHash AS hash, f.hash AS fileHash
      `,
      { uuid: file.uuid }
    );

    // Prefer _rawContentHash (virtual-specific), fall back to hash (general)
    return result.records[0]?.get('hash') || result.records[0]?.get('fileHash') || null;
  }

  async readContentBatch(files: ContentFileInfo[]): Promise<BatchContentResult> {
    const contents = new Map<string, string>();
    const hashes = new Map<string, string>();
    const errors = new Set<string>();

    if (files.length === 0) {
      return { contents, hashes, errors };
    }

    // Optimized: single Neo4j query for all files
    const result = await this.neo4jClient.run(
      `
      UNWIND $uuids AS uuid
      MATCH (f:File {uuid: uuid})
      RETURN f.uuid AS uuid, f._rawContent AS content, f._rawContentHash AS hash
      `,
      { uuids: files.map((f) => f.uuid) }
    );

    // Build result maps
    const foundUuids = new Set<string>();
    for (const record of result.records) {
      const uuid = record.get('uuid');
      const content = record.get('content');
      let hash = record.get('hash');

      if (content !== null && content !== undefined) {
        // Compute hash if not stored
        if (!hash) {
          hash = this.hashContent(content);
        }
        contents.set(uuid, content);
        hashes.set(uuid, hash);
        foundUuids.add(uuid);
      }
    }

    // Mark missing files as errors
    for (const file of files) {
      if (!foundUuids.has(file.uuid)) {
        errors.add(file.uuid);
      }
    }

    return { contents, hashes, errors };
  }

  /**
   * Compute SHA256 hash truncated to 16 chars
   */
  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Content source type - where file content comes from
 * - 'disk': Files on the file system (default)
 * - 'virtual': Files stored in Neo4j _rawContent
 */
export type ContentSourceType = 'disk' | 'virtual';

/**
 * Create a content provider based on content source type
 */
export function createContentProvider(
  type: ContentSourceType,
  neo4jClient: Neo4jClient,
  projectId?: string
): IContentProvider {
  switch (type) {
    case 'virtual':
      return new VirtualContentProvider(neo4jClient, projectId);
    case 'disk':
    default:
      return new DiskContentProvider(neo4jClient, projectId);
  }
}

/**
 * Determine if a file is virtual based on its properties
 */
export function isVirtualFile(file: ContentFileInfo): boolean {
  // Explicit flag
  if (file.isVirtual !== undefined) {
    return file.isVirtual;
  }
  // No absolutePath = likely virtual
  if (!file.absolutePath) {
    return true;
  }
  // Path starts with /virtual/ = virtual
  if (file.absolutePath.startsWith('/virtual/')) {
    return true;
  }
  return false;
}

/**
 * Create a hybrid provider that auto-detects disk vs virtual per file
 * Useful for mixed projects or gradual migration
 */
export class HybridContentProvider implements IContentProvider {
  readonly type = 'disk' as const; // Default type for compatibility

  private diskProvider: DiskContentProvider;
  private virtualProvider: VirtualContentProvider;

  constructor(neo4jClient: Neo4jClient, projectId?: string) {
    this.diskProvider = new DiskContentProvider(neo4jClient, projectId);
    this.virtualProvider = new VirtualContentProvider(neo4jClient, projectId);
  }

  private getProvider(file: ContentFileInfo): IContentProvider {
    return isVirtualFile(file) ? this.virtualProvider : this.diskProvider;
  }

  async readContent(file: ContentFileInfo): Promise<string> {
    return this.getProvider(file).readContent(file);
  }

  async readContentWithHash(file: ContentFileInfo): Promise<ContentReadResult> {
    return this.getProvider(file).readContentWithHash(file);
  }

  async exists(file: ContentFileInfo): Promise<boolean> {
    return this.getProvider(file).exists(file);
  }

  async computeHash(file: ContentFileInfo): Promise<string> {
    return this.getProvider(file).computeHash(file);
  }

  async getStoredHash(file: ContentFileInfo): Promise<string | null> {
    return this.getProvider(file).getStoredHash(file);
  }

  async readContentBatch(files: ContentFileInfo[]): Promise<BatchContentResult> {
    // Split files by type
    const diskFiles = files.filter((f) => !isVirtualFile(f));
    const virtualFiles = files.filter((f) => isVirtualFile(f));

    // Read in parallel
    const [diskResult, virtualResult] = await Promise.all([
      diskFiles.length > 0 ? this.diskProvider.readContentBatch(diskFiles) : null,
      virtualFiles.length > 0 ? this.virtualProvider.readContentBatch(virtualFiles) : null,
    ]);

    // Merge results
    const contents = new Map<string, string>();
    const hashes = new Map<string, string>();
    const errors = new Set<string>();

    if (diskResult) {
      diskResult.contents.forEach((v, k) => contents.set(k, v));
      diskResult.hashes.forEach((v, k) => hashes.set(k, v));
      diskResult.errors.forEach((e) => errors.add(e));
    }

    if (virtualResult) {
      virtualResult.contents.forEach((v, k) => contents.set(k, v));
      virtualResult.hashes.forEach((v, k) => hashes.set(k, v));
      virtualResult.errors.forEach((e) => errors.add(e));
    }

    return { contents, hashes, errors };
  }
}
