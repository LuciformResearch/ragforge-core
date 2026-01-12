/**
 * Parser Registry - Central registry for all content parsers
 *
 * This module:
 * - Registers all available parsers
 * - Auto-generates FIELD_MAPPING from parser nodeTypes
 * - Auto-generates embedding configs from parser nodeTypes
 * - Routes files to appropriate parsers
 * - Validates nodes against their definitions
 *
 * @module parser-registry
 */

import * as path from 'path';
import type {
  ContentParser,
  NodeTypeDefinition,
  FieldExtractors,
  NodeTypeMap,
  ParseInput,
  ParseOutput,
  ChunkingConfig,
} from './parser-types.js';

// ============================================================
// FIELD MAPPING (auto-generated)
// ============================================================

/**
 * Field mapping for a node type.
 * Mirrors the old FIELD_MAPPING structure for backwards compatibility.
 */
export interface NodeFieldMapping {
  title: (node: Record<string, unknown>) => string | null;
  content: (node: Record<string, unknown>) => string | null;
  description: (node: Record<string, unknown>) => string | null;
  location: (node: Record<string, unknown>) => string | null;
}

// ============================================================
// EMBED CONFIG (auto-generated)
// ============================================================

/**
 * Embedding configuration for a node type.
 * Used by EmbeddingService to know how to embed nodes.
 */
export interface EmbedConfig {
  label: string;
  fields: FieldExtractors;
  chunking?: ChunkingConfig;
  contentHashField: string;
}

// ============================================================
// PARSER REGISTRY
// ============================================================

/**
 * Central registry for all content parsers.
 *
 * @example
 * ```typescript
 * const registry = new ParserRegistry();
 * registry.register(new CodeParser());
 * registry.register(new MarkdownParser());
 *
 * // Get parser for a file
 * const parser = registry.getParserForFile('src/utils.ts');
 *
 * // Get auto-generated field mapping
 * const fieldMapping = registry.getFieldMapping();
 *
 * // Get auto-generated embed configs
 * const embedConfigs = registry.getEmbedConfigs();
 * ```
 */
export class ParserRegistry {
  /** Registered parsers by name */
  private parsers: Map<string, ContentParser> = new Map();

  /** Extension to parser mapping (cached) */
  private extensionMap: Map<string, ContentParser> = new Map();

  /** Node type definitions by label (cached) */
  private nodeTypeMap: NodeTypeMap = new Map();

  /** Field mapping cache */
  private fieldMappingCache: Record<string, NodeFieldMapping> | null = null;

  /** Embed configs cache */
  private embedConfigsCache: EmbedConfig[] | null = null;

  // ============================================================
  // REGISTRATION
  // ============================================================

  /**
   * Register a parser.
   *
   * @param parser - Parser to register
   * @throws Error if parser name is already registered
   */
  register(parser: ContentParser): void {
    if (this.parsers.has(parser.name)) {
      throw new Error(`Parser '${parser.name}' is already registered`);
    }

    this.parsers.set(parser.name, parser);

    // Update extension map
    for (const ext of parser.supportedExtensions) {
      const normalizedExt = ext.toLowerCase();
      if (this.extensionMap.has(normalizedExt)) {
        console.warn(
          `Extension '${ext}' is already handled by parser '${this.extensionMap.get(normalizedExt)?.name}'. ` +
          `Overwriting with parser '${parser.name}'.`
        );
      }
      this.extensionMap.set(normalizedExt, parser);
    }

    // Update node type map
    for (const nodeDef of parser.nodeTypes) {
      if (this.nodeTypeMap.has(nodeDef.label)) {
        console.warn(
          `Node type '${nodeDef.label}' is already defined. Overwriting with definition from parser '${parser.name}'.`
        );
      }
      this.nodeTypeMap.set(nodeDef.label, nodeDef);
    }

    // Invalidate caches
    this.fieldMappingCache = null;
    this.embedConfigsCache = null;
  }

  /**
   * Unregister a parser.
   *
   * @param name - Parser name to unregister
   */
  unregister(name: string): void {
    const parser = this.parsers.get(name);
    if (!parser) return;

    this.parsers.delete(name);

    // Remove from extension map
    for (const ext of parser.supportedExtensions) {
      const normalizedExt = ext.toLowerCase();
      if (this.extensionMap.get(normalizedExt) === parser) {
        this.extensionMap.delete(normalizedExt);
      }
    }

    // Remove from node type map
    for (const nodeDef of parser.nodeTypes) {
      if (this.nodeTypeMap.get(nodeDef.label) === nodeDef) {
        this.nodeTypeMap.delete(nodeDef.label);
      }
    }

    // Invalidate caches
    this.fieldMappingCache = null;
    this.embedConfigsCache = null;
  }

  // ============================================================
  // PARSER LOOKUP
  // ============================================================

  /**
   * Get parser by name.
   *
   * @param name - Parser name
   * @returns Parser or undefined
   */
  getParser(name: string): ContentParser | undefined {
    return this.parsers.get(name);
  }

  /**
   * Get parser for a file based on extension.
   *
   * @param filePath - Path to file
   * @returns Parser or null if no parser found
   */
  getParserForFile(filePath: string): ContentParser | null {
    const ext = path.extname(filePath).toLowerCase();
    const parser = this.extensionMap.get(ext);

    if (parser) {
      // Check if parser has custom canHandle logic
      if (parser.canHandle && !parser.canHandle(filePath)) {
        return null;
      }
      return parser;
    }

    // Fallback: check all parsers with canHandle
    for (const p of this.parsers.values()) {
      if (p.canHandle?.(filePath)) {
        return p;
      }
    }

    return null;
  }

  /**
   * Check if a file can be parsed.
   *
   * @param filePath - Path to file
   * @returns true if a parser exists for this file
   */
  canParse(filePath: string): boolean {
    return this.getParserForFile(filePath) !== null;
  }

  /**
   * Get all registered parsers.
   *
   * @returns Array of registered parsers
   */
  getAllParsers(): ContentParser[] {
    return Array.from(this.parsers.values());
  }

  /**
   * Get all supported extensions.
   *
   * @returns Array of supported extensions
   */
  getSupportedExtensions(): string[] {
    return Array.from(this.extensionMap.keys());
  }

  // ============================================================
  // NODE TYPE LOOKUP
  // ============================================================

  /**
   * Get node type definition by label.
   *
   * @param label - Node label (e.g., 'Scope', 'MarkdownSection')
   * @returns Node type definition or undefined
   */
  getNodeType(label: string): NodeTypeDefinition | undefined {
    return this.nodeTypeMap.get(label);
  }

  /**
   * Get all node type definitions.
   *
   * @returns Map of label to node type definition
   */
  getAllNodeTypes(): NodeTypeMap {
    return new Map(this.nodeTypeMap);
  }

  /**
   * Get all node labels.
   *
   * @returns Array of all node labels
   */
  getAllNodeLabels(): string[] {
    return Array.from(this.nodeTypeMap.keys());
  }

  // ============================================================
  // AUTO-GENERATED FIELD MAPPING
  // ============================================================

  /**
   * Get auto-generated field mapping from all parser nodeTypes.
   * This replaces the hardcoded FIELD_MAPPING in node-schema.ts.
   *
   * @returns Field mapping for all node types
   */
  getFieldMapping(): Record<string, NodeFieldMapping> {
    if (this.fieldMappingCache) {
      return this.fieldMappingCache;
    }

    const mapping: Record<string, NodeFieldMapping> = {};

    for (const [label, nodeDef] of this.nodeTypeMap) {
      mapping[label] = {
        title: (node) => nodeDef.fields.name(node) || null,
        content: (node) => nodeDef.fields.content(node),
        description: (node) => nodeDef.fields.description?.(node) ?? null,
        location: (node) => nodeDef.fields.displayPath(node) || null,
      };
    }

    this.fieldMappingCache = mapping;
    return mapping;
  }

  // ============================================================
  // AUTO-GENERATED EMBED CONFIGS
  // ============================================================

  /**
   * Get auto-generated embedding configs from all parser nodeTypes.
   * This replaces the hardcoded MULTI_EMBED_CONFIGS in embedding-service.ts.
   *
   * @returns Embedding configs for all node types
   */
  getEmbedConfigs(): EmbedConfig[] {
    if (this.embedConfigsCache) {
      return this.embedConfigsCache;
    }

    const configs: EmbedConfig[] = [];

    for (const [label, nodeDef] of this.nodeTypeMap) {
      configs.push({
        label,
        fields: nodeDef.fields,
        chunking: nodeDef.chunking,
        contentHashField: nodeDef.contentHashField,
      });
    }

    this.embedConfigsCache = configs;
    return configs;
  }

  // ============================================================
  // PARSING
  // ============================================================

  /**
   * Parse a file using the appropriate parser.
   *
   * @param input - Parse input
   * @returns Parse output or null if no parser found
   */
  async parse(input: ParseInput): Promise<ParseOutput | null> {
    const parser = this.getParserForFile(input.filePath);
    if (!parser) {
      return null;
    }

    return parser.parse(input);
  }

  /**
   * Parse multiple files.
   *
   * @param inputs - Array of parse inputs
   * @returns Array of parse outputs (null for files with no parser)
   */
  async parseMany(inputs: ParseInput[]): Promise<(ParseOutput | null)[]> {
    return Promise.all(inputs.map(input => this.parse(input)));
  }

  // ============================================================
  // VALIDATION
  // ============================================================

  /**
   * Validate a node against its type definition.
   *
   * @param label - Node label
   * @param node - Node properties
   * @returns Validation result with errors
   */
  validateNode(label: string, node: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const nodeDef = this.nodeTypeMap.get(label);
    if (!nodeDef) {
      return { valid: false, errors: [`Unknown node type: ${label}`] };
    }

    const errors: string[] = [];

    // Check required base props
    const baseRequired = ['uuid', 'projectId', 'sourcePath', 'contentHash'];
    for (const prop of baseRequired) {
      if (node[prop] === undefined || node[prop] === null) {
        errors.push(`Missing required base property: ${prop}`);
      }
    }

    // Check additional required props
    for (const prop of nodeDef.additionalRequiredProps) {
      if (node[prop] === undefined || node[prop] === null) {
        errors.push(`Missing required property: ${prop}`);
      }
    }

    // Check content hash field exists
    if (node[nodeDef.contentHashField] === undefined) {
      errors.push(`Missing content hash source field: ${nodeDef.contentHashField}`);
    }

    return { valid: errors.length === 0, errors };
  }

  // ============================================================
  // DEBUG / INFO
  // ============================================================

  /**
   * Get registry statistics.
   */
  getStats(): {
    parserCount: number;
    extensionCount: number;
    nodeTypeCount: number;
    parsers: { name: string; version: number; extensions: string[]; nodeTypes: string[] }[];
  } {
    return {
      parserCount: this.parsers.size,
      extensionCount: this.extensionMap.size,
      nodeTypeCount: this.nodeTypeMap.size,
      parsers: Array.from(this.parsers.values()).map(p => ({
        name: p.name,
        version: p.version,
        extensions: p.supportedExtensions,
        nodeTypes: p.nodeTypes.map(nt => nt.label),
      })),
    };
  }

  /**
   * Print registry info for debugging.
   */
  printInfo(): void {
    const stats = this.getStats();
    console.log('=== Parser Registry ===');
    console.log(`Parsers: ${stats.parserCount}`);
    console.log(`Extensions: ${stats.extensionCount}`);
    console.log(`Node types: ${stats.nodeTypeCount}`);
    console.log('');
    for (const p of stats.parsers) {
      console.log(`  ${p.name} v${p.version}`);
      console.log(`    Extensions: ${p.extensions.join(', ')}`);
      console.log(`    Node types: ${p.nodeTypes.join(', ')}`);
    }
  }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

/**
 * Global parser registry instance.
 * Use this for most cases instead of creating new instances.
 */
export const parserRegistry = new ParserRegistry();

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Register a parser with the global registry.
 *
 * @param parser - Parser to register
 */
export function registerParser(parser: ContentParser): void {
  parserRegistry.register(parser);
}

/**
 * Get the parser for a file from the global registry.
 *
 * @param filePath - Path to file
 * @returns Parser or null
 */
export function getParserForFile(filePath: string): ContentParser | null {
  return parserRegistry.getParserForFile(filePath);
}

/**
 * Check if a file can be parsed.
 *
 * @param filePath - Path to file
 * @returns true if a parser exists
 */
export function canParseFile(filePath: string): boolean {
  return parserRegistry.canParse(filePath);
}

/**
 * Get the global field mapping.
 *
 * @returns Field mapping for all node types
 */
export function getFieldMapping(): Record<string, NodeFieldMapping> {
  return parserRegistry.getFieldMapping();
}

/**
 * Get the global embed configs.
 *
 * @returns Embed configs for all node types
 */
export function getEmbedConfigs(): EmbedConfig[] {
  return parserRegistry.getEmbedConfigs();
}

// ============================================================
// NEO4J RECORD COMPATIBILITY
// ============================================================

/**
 * Convert a Neo4j record to a plain object.
 * Neo4j records use record.get('field') while extractors expect node.field
 */
export function recordToObject(record: any): Record<string, any> {
  const obj: Record<string, any> = {};
  // Neo4j records have a keys property with all field names
  if (record.keys) {
    for (const key of record.keys) {
      obj[key] = record.get(key);
    }
  }
  return obj;
}

/**
 * Embedding extractors that work with Neo4j records.
 */
export interface RecordEmbeddingExtractors {
  name: (record: any) => string;
  content: (record: any) => string;
  description: (record: any) => string;
}

/**
 * Get embedding extractors for a label that work with Neo4j records.
 * Wraps the FieldExtractors from parser definitions.
 *
 * @param label - Node label (e.g., 'Scope', 'MarkdownSection')
 * @returns Extractors that take Neo4j records and return text
 */
export function getRecordExtractors(label: string): RecordEmbeddingExtractors {
  const nodeDef = parserRegistry.getNodeType(label);

  if (!nodeDef) {
    // Fallback for unknown/unregistered types
    return {
      name: (r) => {
        const node = recordToObject(r);
        return node.signature || node.title || node.name || node.path || '';
      },
      content: (r) => {
        const node = recordToObject(r);
        return node.source || node.content || node.textContent || '';
      },
      description: (r) => {
        const node = recordToObject(r);
        return node.docstring || node.description || '';
      },
    };
  }

  const fields = nodeDef.fields;

  return {
    name: (r) => {
      const node = recordToObject(r);
      return fields.name(node) || '';
    },
    content: (r) => {
      const node = recordToObject(r);
      return fields.content(node) || '';
    },
    description: (r) => {
      const node = recordToObject(r);
      return fields.description?.(node) || '';
    },
  };
}
