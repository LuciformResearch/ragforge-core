/**
 * Web Parser - ContentParser wrapper for web pages
 *
 * Defines node types and field extractors for web page nodes.
 * Web pages are crawled by WebAdapter and stored as WebPage nodes.
 *
 * Node types defined:
 * - WebPage: Crawled web pages
 * - WebDocument: HTML documents (from HTML files)
 *
 * @module parsers/web-parser
 */

import type {
  ContentParser,
  NodeTypeDefinition,
  ParseInput,
  ParseOutput,
  FieldExtractors,
  ChunkingConfig,
} from '../parser-types.js';

// ============================================================
// CHUNKING CONFIG
// ============================================================

/**
 * Web page content chunking
 */
const webPageChunkingConfig: ChunkingConfig = {
  enabled: true,
  maxSize: 4000,
  overlap: 400,
  strategy: 'paragraph',
};

// ============================================================
// FIELD EXTRACTORS
// ============================================================

/**
 * Field extractors for WebPage nodes
 */
const webPageFieldExtractors: FieldExtractors = {
  name: (node) => {
    // Include URL for better search
    const title = node.title as string;
    const url = node.url as string;
    return `${title || ''} ${url || ''}`.trim();
  },

  content: (node) => {
    return (node.textContent as string) || null;
  },

  description: (node) => {
    return (node.metaDescription as string) || (node.description as string) || null;
  },

  displayPath: (node) => {
    const url = node.url as string;
    const title = node.title as string;
    if (title) {
      return `${title} (${url})`;
    }
    return url || '';
  },

  gotoLocation: (node) => ({
    path: node.url as string,
  }),
};

/**
 * Field extractors for WebDocument nodes (HTML files)
 */
const webDocumentFieldExtractors: FieldExtractors = {
  name: (node) => {
    const title = node.title as string;
    const file = node.file as string;
    return title || file || '';
  },

  content: (node) => {
    return (node.textContent as string) || (node.source as string) || null;
  },

  description: () => null,

  displayPath: (node) => (node.file as string) || '',

  gotoLocation: (node) => ({
    path: node.file as string,
    line: 1,
  }),
};

// ============================================================
// NODE TYPE DEFINITIONS
// ============================================================

const webPageNodeType: NodeTypeDefinition = {
  label: 'WebPage',
  description: 'Crawled web page',
  supportsLineNavigation: false,
  uuidStrategy: { type: 'content', field: 'url' },
  fields: webPageFieldExtractors,
  contentHashField: 'textContent',
  chunking: webPageChunkingConfig,
  additionalRequiredProps: ['url', 'title', 'textContent', 'headingCount', 'linkCount', 'depth', 'crawledAt'],
  indexedProps: ['url', 'title', 'depth'],
};

const webDocumentNodeType: NodeTypeDefinition = {
  label: 'WebDocument',
  description: 'HTML document file',
  supportsLineNavigation: true,
  uuidStrategy: { type: 'path' },
  fields: webDocumentFieldExtractors,
  contentHashField: 'source',
  chunking: webPageChunkingConfig,
  additionalRequiredProps: ['file', 'type'],
  indexedProps: ['file', 'title'],
};

// ============================================================
// WEB PARSER
// ============================================================

/**
 * WebParser - ContentParser that defines node types for web content
 *
 * NOTE: The actual crawling is done by WebAdapter.
 * This parser provides:
 * 1. Node type definitions with field extractors
 * 2. Auto-generation of FIELD_MAPPING and embed configs
 */
export class WebParser implements ContentParser {
  readonly name = 'web';
  readonly version = 1;

  readonly supportedExtensions = ['.html', '.htm'];

  readonly supportedMimeTypes = [
    'text/html',
    'application/xhtml+xml',
  ];

  readonly nodeTypes: NodeTypeDefinition[] = [
    webPageNodeType,
    webDocumentNodeType,
  ];

  /**
   * Check if this parser can handle a file
   */
  canHandle(filePath: string): boolean {
    const ext = filePath.toLowerCase().split('.').pop();
    return ext === 'html' || ext === 'htm';
  }

  /**
   * Parse is delegated to WebAdapter or CodeSourceAdapter
   *
   * This parser primarily exists to provide nodeTypes definitions.
   */
  async parse(_input: ParseInput): Promise<ParseOutput> {
    // Parsing is delegated to appropriate adapter
    throw new Error(
      'WebParser.parse() should not be called directly. ' +
      'Use WebAdapter for crawling or CodeSourceAdapter for HTML files.'
    );
  }
}

// ============================================================
// SINGLETON & REGISTRATION
// ============================================================

/**
 * Global WebParser instance
 */
export const webParser = new WebParser();
