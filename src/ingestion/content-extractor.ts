/**
 * Content Extractor - Unified content extraction and chunking
 *
 * This module provides:
 * - Extract embeddable content from any node type
 * - Chunk large content using text-chunker.ts
 * - Compute content hashes for change detection
 *
 * @module content-extractor
 */

import { createHash } from 'crypto';
import { chunkText, needsChunking, type ChunkOptions, type TextChunk } from '../runtime/embedding/text-chunker.js';
import { parserRegistry } from './parser-registry.js';
import type { NodeTypeDefinition, ChunkingConfig, FieldExtractors } from './parser-types.js';

// ============================================================
// TYPES
// ============================================================

/**
 * Extracted content ready for embedding.
 */
export interface ExtractedContent {
  /** Content for embedding_name */
  name: string;

  /** Content for embedding_content (may be chunked) */
  content: string | TextChunk[] | null;

  /** Content for embedding_description */
  description: string | null;

  /** Display path for UI */
  displayPath: string;

  /** Hash of the content for change detection */
  contentHash: string;

  /** Whether content was chunked */
  isChunked: boolean;

  /** Number of chunks (1 if not chunked) */
  chunkCount: number;
}

/**
 * Options for content extraction.
 */
export interface ExtractOptions {
  /** Force chunking even if under threshold */
  forceChunking?: boolean;

  /** Override default chunk size */
  chunkSize?: number;

  /** Override default overlap */
  overlap?: number;

  /** Skip chunking entirely */
  skipChunking?: boolean;
}

// ============================================================
// CONTENT HASHER
// ============================================================

/**
 * Compute SHA-256 hash of content.
 *
 * @param content - Content to hash
 * @returns Hex-encoded hash
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Compute hash from multiple fields.
 * Useful for composite hashes (e.g., name + content).
 *
 * @param fields - Fields to hash
 * @returns Hex-encoded hash
 */
export function hashFields(...fields: (string | null | undefined)[]): string {
  const combined = fields.filter(f => f != null).join('\0');
  return hashContent(combined);
}

// ============================================================
// CONTENT EXTRACTOR CLASS
// ============================================================

/**
 * Unified content extractor for all node types.
 *
 * @example
 * ```typescript
 * const extractor = new ContentExtractor();
 *
 * // Extract content from a Scope node
 * const content = extractor.extract('Scope', scopeNode);
 *
 * // Extract with custom options
 * const content = extractor.extract('MarkdownSection', sectionNode, {
 *   chunkSize: 2000,
 *   overlap: 200,
 * });
 * ```
 */
export class ContentExtractor {
  // ============================================================
  // MAIN EXTRACTION
  // ============================================================

  /**
   * Extract embeddable content from a node.
   *
   * @param label - Node label (e.g., 'Scope', 'MarkdownSection')
   * @param node - Node properties
   * @param options - Extraction options
   * @returns Extracted content or null if extraction failed
   */
  extract(
    label: string,
    node: Record<string, unknown>,
    options: ExtractOptions = {}
  ): ExtractedContent | null {
    // Get node type definition from registry
    const nodeDef = parserRegistry.getNodeType(label);
    if (!nodeDef) {
      console.warn(`[ContentExtractor] Unknown node type: ${label}`);
      return null;
    }

    return this.extractWithDefinition(nodeDef, node, options);
  }

  /**
   * Extract content using a specific node type definition.
   * Useful when you already have the definition.
   *
   * @param nodeDef - Node type definition
   * @param node - Node properties
   * @param options - Extraction options
   * @returns Extracted content
   */
  extractWithDefinition(
    nodeDef: NodeTypeDefinition,
    node: Record<string, unknown>,
    options: ExtractOptions = {}
  ): ExtractedContent {
    const { fields, chunking, contentHashField } = nodeDef;

    // Extract fields
    const name = fields.name(node) || '';
    const rawContent = fields.content(node);
    const description = fields.description?.(node) ?? null;
    const displayPath = fields.displayPath(node) || '';

    // Compute content hash from the designated field
    const hashSource = node[contentHashField];
    const contentHash = hashSource != null ? hashContent(String(hashSource)) : '';

    // Handle chunking
    let content: string | TextChunk[] | null = rawContent;
    let isChunked = false;
    let chunkCount = rawContent ? 1 : 0;

    if (rawContent && !options.skipChunking) {
      const shouldChunk = this.shouldChunk(rawContent, chunking, options);

      if (shouldChunk) {
        const chunkOptions = this.getChunkOptions(chunking, options);
        const chunks = chunkText(rawContent, chunkOptions);
        content = chunks;
        isChunked = true;
        chunkCount = chunks.length;
      }
    }

    return {
      name,
      content,
      description,
      displayPath,
      contentHash,
      isChunked,
      chunkCount,
    };
  }

  // ============================================================
  // BATCH EXTRACTION
  // ============================================================

  /**
   * Extract content from multiple nodes of the same type.
   *
   * @param label - Node label
   * @param nodes - Array of nodes
   * @param options - Extraction options
   * @returns Array of extracted content (null for failed extractions)
   */
  extractMany(
    label: string,
    nodes: Record<string, unknown>[],
    options: ExtractOptions = {}
  ): (ExtractedContent | null)[] {
    const nodeDef = parserRegistry.getNodeType(label);
    if (!nodeDef) {
      console.warn(`[ContentExtractor] Unknown node type: ${label}`);
      return nodes.map(() => null);
    }

    return nodes.map(node => this.extractWithDefinition(nodeDef, node, options));
  }

  /**
   * Extract content from nodes of mixed types.
   *
   * @param labeledNodes - Array of [label, node] tuples
   * @param options - Extraction options
   * @returns Array of extracted content
   */
  extractMixed(
    labeledNodes: [string, Record<string, unknown>][],
    options: ExtractOptions = {}
  ): (ExtractedContent | null)[] {
    return labeledNodes.map(([label, node]) => this.extract(label, node, options));
  }

  // ============================================================
  // CHUNKING HELPERS
  // ============================================================

  /**
   * Check if content should be chunked.
   */
  private shouldChunk(
    content: string,
    chunking: ChunkingConfig | undefined,
    options: ExtractOptions
  ): boolean {
    if (options.forceChunking) return true;
    if (!chunking?.enabled) return false;

    const maxSize = options.chunkSize ?? chunking.maxSize;
    return needsChunking(content, maxSize);
  }

  /**
   * Get chunk options from config and overrides.
   */
  private getChunkOptions(
    chunking: ChunkingConfig | undefined,
    options: ExtractOptions
  ): ChunkOptions {
    return {
      chunkSize: options.chunkSize ?? chunking?.maxSize ?? 2000,
      overlap: options.overlap ?? chunking?.overlap ?? 200,
      strategy: chunking?.strategy === 'code' ? 'fixed' : chunking?.strategy ?? 'paragraph',
    };
  }

  // ============================================================
  // DIRECT FIELD ACCESS
  // ============================================================

  /**
   * Get just the name field from a node.
   */
  getName(label: string, node: Record<string, unknown>): string | null {
    const nodeDef = parserRegistry.getNodeType(label);
    if (!nodeDef) return null;
    return nodeDef.fields.name(node) || null;
  }

  /**
   * Get just the content field from a node (no chunking).
   */
  getContent(label: string, node: Record<string, unknown>): string | null {
    const nodeDef = parserRegistry.getNodeType(label);
    if (!nodeDef) return null;
    return nodeDef.fields.content(node);
  }

  /**
   * Get just the description field from a node.
   */
  getDescription(label: string, node: Record<string, unknown>): string | null {
    const nodeDef = parserRegistry.getNodeType(label);
    if (!nodeDef) return null;
    return nodeDef.fields.description?.(node) ?? null;
  }

  /**
   * Get just the display path from a node.
   */
  getDisplayPath(label: string, node: Record<string, unknown>): string | null {
    const nodeDef = parserRegistry.getNodeType(label);
    if (!nodeDef) return null;
    return nodeDef.fields.displayPath(node) || null;
  }

  /**
   * Get the goto location from a node.
   */
  getGotoLocation(label: string, node: Record<string, unknown>) {
    const nodeDef = parserRegistry.getNodeType(label);
    if (!nodeDef) return null;
    return nodeDef.fields.gotoLocation?.(node) ?? null;
  }

  // ============================================================
  // HASH COMPUTATION
  // ============================================================

  /**
   * Compute content hash for a node using its designated hash field.
   */
  computeHash(label: string, node: Record<string, unknown>): string | null {
    const nodeDef = parserRegistry.getNodeType(label);
    if (!nodeDef) return null;

    const hashSource = node[nodeDef.contentHashField];
    if (hashSource == null) return null;

    return hashContent(String(hashSource));
  }

  /**
   * Check if a node's content has changed by comparing hashes.
   *
   * @param label - Node label
   * @param node - Current node properties
   * @param previousHash - Previous content hash
   * @returns true if content changed, false if unchanged, null if can't determine
   */
  hasChanged(
    label: string,
    node: Record<string, unknown>,
    previousHash: string | null
  ): boolean | null {
    const currentHash = this.computeHash(label, node);
    if (currentHash === null || previousHash === null) return null;
    return currentHash !== previousHash;
  }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

/**
 * Global content extractor instance.
 */
export const contentExtractor = new ContentExtractor();

// ============================================================
// CONVENIENCE FUNCTIONS
// ============================================================

/**
 * Extract content from a node using the global extractor.
 */
export function extractContent(
  label: string,
  node: Record<string, unknown>,
  options?: ExtractOptions
): ExtractedContent | null {
  return contentExtractor.extract(label, node, options);
}

/**
 * Compute content hash for a node.
 */
export function computeNodeHash(label: string, node: Record<string, unknown>): string | null {
  return contentExtractor.computeHash(label, node);
}

/**
 * Check if node content has changed.
 */
export function hasNodeChanged(
  label: string,
  node: Record<string, unknown>,
  previousHash: string | null
): boolean | null {
  return contentExtractor.hasChanged(label, node, previousHash);
}
