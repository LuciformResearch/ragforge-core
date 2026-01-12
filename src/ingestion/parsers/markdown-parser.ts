/**
 * Markdown Parser - ContentParser wrapper for markdown files
 *
 * Defines node types and field extractors for markdown-related nodes.
 * The actual parsing is done by @luciformresearch/codeparsers (external).
 * This wrapper provides the nodeTypes definitions for the registry.
 *
 * Node types defined:
 * - MarkdownDocument: The document wrapper node
 * - MarkdownSection: Sections/headings within the document
 * - CodeBlock: Code blocks embedded in markdown
 *
 * @module parsers/markdown-parser
 */

import * as path from 'path';
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
 * Markdown section chunking for large documents
 */
const markdownChunkingConfig: ChunkingConfig = {
  enabled: true,
  maxSize: 4000,
  overlap: 400,
  strategy: 'paragraph',
};

/**
 * Code block chunking (less overlap needed)
 */
const codeBlockChunkingConfig: ChunkingConfig = {
  enabled: true,
  maxSize: 3000,
  overlap: 200,
  strategy: 'code',
};

// ============================================================
// FIELD EXTRACTORS
// ============================================================

/**
 * Field extractors for MarkdownDocument nodes
 */
const markdownDocumentFieldExtractors: FieldExtractors = {
  name: (node) => {
    // Title is more searchable
    return (node.title as string) || (node.file as string) || '';
  },

  content: () => {
    // Document node doesn't have distinct content (sections do)
    return null;
  },

  description: (node) => {
    // Front matter as description
    const frontMatter = node.frontMatter as string;
    if (frontMatter) {
      try {
        // Try to extract key info from front matter
        const parsed = JSON.parse(frontMatter);
        const desc = parsed.description || parsed.summary || parsed.excerpt;
        if (desc) return desc;
      } catch {
        // Not JSON, return as-is if short enough
        if (frontMatter.length < 500) return frontMatter;
      }
    }
    return null;
  },

  displayPath: (node) => {
    const file = node.file as string;
    const sectionCount = node.sectionCount as number | undefined;
    if (sectionCount) {
      return `${file} (${sectionCount} sections)`;
    }
    return file || '';
  },

  gotoLocation: (node) => ({
    path: node.file as string,
    line: 1,
  }),
};

/**
 * Field extractors for MarkdownSection nodes
 */
const markdownSectionFieldExtractors: FieldExtractors = {
  name: (node) => {
    // Section title/heading
    return (node.title as string) || '';
  },

  content: (node) => {
    // ownContent is the section without children, content includes children
    return (node.ownContent as string) || (node.content as string) || null;
  },

  description: () => {
    // rawText would duplicate content
    return null;
  },

  displayPath: (node) => {
    const file = node.file as string;
    const startLine = node.startLine as number | undefined;
    const slug = node.slug as string | undefined;
    if (startLine) {
      return `${file}:${startLine}${slug ? ` #${slug}` : ''}`;
    }
    return file || '';
  },

  gotoLocation: (node) => ({
    path: node.file as string,
    line: node.startLine as number | undefined,
    anchor: node.slug as string | undefined,
  }),
};

/**
 * Field extractors for CodeBlock nodes
 */
const codeBlockFieldExtractors: FieldExtractors = {
  name: (node) => {
    const language = node.language as string;
    return language ? `${language} code block` : 'code block';
  },

  content: (node) => {
    // The actual code
    return (node.code as string) || null;
  },

  description: () => {
    // Language already in name
    return null;
  },

  displayPath: (node) => {
    const file = node.file as string;
    const startLine = node.startLine as number | undefined;
    const language = node.language as string | undefined;
    const parts: string[] = [file];
    if (startLine) parts.push(`:${startLine}`);
    if (language) parts.push(` (${language})`);
    return parts.join('');
  },

  gotoLocation: (node) => ({
    path: node.file as string,
    line: node.startLine as number | undefined,
  }),
};

// ============================================================
// NODE TYPE DEFINITIONS
// ============================================================

const markdownDocumentNodeType: NodeTypeDefinition = {
  label: 'MarkdownDocument',
  description: 'Markdown document with sections and code blocks',
  supportsLineNavigation: true,
  uuidStrategy: { type: 'path' },
  fields: markdownDocumentFieldExtractors,
  contentHashField: 'file', // Document hash based on file path
  chunking: undefined, // Document doesn't have content to chunk
  additionalRequiredProps: ['file', 'type', 'title', 'sectionCount', 'codeBlockCount', 'linkCount', 'imageCount', 'wordCount'],
  indexedProps: ['file', 'title'],
};

const markdownSectionNodeType: NodeTypeDefinition = {
  label: 'MarkdownSection',
  description: 'Section within a markdown document',
  supportsLineNavigation: true,
  uuidStrategy: { type: 'signature', fields: ['file', 'slug', 'startLine'] },
  fields: markdownSectionFieldExtractors,
  contentHashField: 'content',
  chunking: markdownChunkingConfig,
  additionalRequiredProps: ['title', 'level', 'content', 'file', 'startLine', 'endLine', 'slug'],
  indexedProps: ['title', 'level', 'slug', 'file'],
};

const codeBlockNodeType: NodeTypeDefinition = {
  label: 'CodeBlock',
  description: 'Code block embedded in markdown',
  supportsLineNavigation: true,
  uuidStrategy: { type: 'position' }, // position-based for code blocks
  fields: codeBlockFieldExtractors,
  contentHashField: 'code',
  chunking: codeBlockChunkingConfig,
  additionalRequiredProps: ['file', 'language', 'code', 'rawText', 'startLine', 'endLine'],
  indexedProps: ['file', 'language'],
};

// ============================================================
// MARKDOWN PARSER
// ============================================================

/**
 * MarkdownParser - ContentParser that defines node types for markdown files
 *
 * NOTE: The actual parsing is done by @luciformresearch/codeparsers.
 * This parser provides:
 * 1. Node type definitions with field extractors
 * 2. Auto-generation of FIELD_MAPPING and embed configs
 *
 * Parsing is delegated to CodeSourceAdapter which uses the external library.
 */
export class MarkdownParser implements ContentParser {
  readonly name = 'markdown';
  readonly version = 1;

  readonly supportedExtensions = ['.md', '.mdx', '.markdown'];

  readonly supportedMimeTypes = [
    'text/markdown',
    'text/x-markdown',
  ];

  readonly nodeTypes: NodeTypeDefinition[] = [
    markdownDocumentNodeType,
    markdownSectionNodeType,
    codeBlockNodeType,
  ];

  /**
   * Check if this parser can handle a file
   */
  canHandle(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.supportedExtensions.includes(ext);
  }

  /**
   * Parse is delegated to CodeSourceAdapter
   *
   * This parser primarily exists to provide nodeTypes definitions.
   * Actual parsing uses @luciformresearch/codeparsers via CodeSourceAdapter.
   */
  async parse(_input: ParseInput): Promise<ParseOutput> {
    // Parsing is delegated to CodeSourceAdapter
    // This method is not called directly - we register nodeTypes only
    throw new Error(
      'MarkdownParser.parse() should not be called directly. ' +
      'Use CodeSourceAdapter for actual parsing.'
    );
  }
}

// ============================================================
// SINGLETON & REGISTRATION
// ============================================================

/**
 * Global MarkdownParser instance
 */
export const markdownParser = new MarkdownParser();
