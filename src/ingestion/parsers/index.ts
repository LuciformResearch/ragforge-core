/**
 * Parser Wrappers - ContentParser implementations for all file types
 *
 * This module exports:
 * 1. Individual parser instances
 * 2. Function to register all parsers with the registry
 *
 * @module parsers
 */

import { parserRegistry } from '../parser-registry.js';

// Parser implementations
export { CodeParser, codeParser } from './code-parser.js';
export { MarkdownParser, markdownParser } from './markdown-parser.js';
export { DocumentParser, documentParser } from './document-parser.js';
export { MediaParser, mediaParser } from './media-parser.js';
export { DataParser, dataParser } from './data-parser.js';
export { WebParser, webParser } from './web-parser.js';

// Import instances for registration
import { codeParser } from './code-parser.js';
import { markdownParser } from './markdown-parser.js';
import { documentParser } from './document-parser.js';
import { mediaParser } from './media-parser.js';
import { dataParser } from './data-parser.js';
import { webParser } from './web-parser.js';

/**
 * All available parsers in registration order
 */
export const allParsers = [
  codeParser,
  markdownParser,
  documentParser,
  mediaParser,
  dataParser,
  webParser,
] as const;

/**
 * Register all parsers with the global registry.
 *
 * This function should be called once at startup to populate
 * the registry with all available parsers.
 *
 * @example
 * ```typescript
 * import { registerAllParsers } from './parsers';
 * registerAllParsers();
 *
 * // Now the registry has all node types
 * const fieldMapping = getFieldMapping();
 * const embedConfigs = getEmbedConfigs();
 * ```
 */
export function registerAllParsers(): void {
  for (const parser of allParsers) {
    try {
      parserRegistry.register(parser);
    } catch (error) {
      // Parser already registered (e.g., during hot reload)
      console.debug(`[Parsers] Parser '${parser.name}' already registered`);
    }
  }
}

/**
 * Check if parsers have been registered
 */
export function areParsersRegistered(): boolean {
  return parserRegistry.getAllParsers().length > 0;
}

/**
 * Get registration stats
 */
export function getParserStats(): {
  parserCount: number;
  extensionCount: number;
  nodeTypeCount: number;
} {
  return {
    parserCount: parserRegistry.getAllParsers().length,
    extensionCount: parserRegistry.getSupportedExtensions().length,
    nodeTypeCount: parserRegistry.getAllNodeLabels().length,
  };
}
