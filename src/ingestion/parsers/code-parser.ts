/**
 * Code Parser - ContentParser wrapper for code files
 *
 * Defines node types and field extractors for code-related nodes.
 * The actual parsing is done by @luciformresearch/codeparsers (external).
 * This wrapper provides the nodeTypes definitions for the registry.
 *
 * Node types defined:
 * - Scope: Functions, classes, methods, variables
 * - VueSFC: Vue Single File Components
 * - SvelteComponent: Svelte components
 * - Stylesheet: CSS/SCSS stylesheets
 * - GenericFile: Unknown code files
 * - File: File wrapper node
 *
 * @module parsers/code-parser
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
 * Code content chunking for large files/functions
 */
const codeChunkingConfig: ChunkingConfig = {
  enabled: true,
  maxSize: 3000,
  overlap: 300,
  strategy: 'code',
};

// ============================================================
// FIELD EXTRACTORS
// ============================================================

/**
 * Field extractors for Scope nodes (functions, classes, methods, etc.)
 */
const scopeFieldExtractors: FieldExtractors = {
  name: (node) => {
    // Signature is more searchable than just name
    return (node.signature as string) || (node.name as string) || '';
  },

  content: (node) => {
    // Source code is the main content
    return (node.source as string) || null;
  },

  description: (node) => {
    // Docstring/JSDoc for description
    return (node.docstring as string) || null;
  },

  displayPath: (node) => {
    const file = node.file as string;
    const startLine = node.startLine as number | undefined;
    const endLine = node.endLine as number | undefined;
    if (startLine && endLine) {
      return `${file}:${startLine}-${endLine}`;
    }
    return file || '';
  },

  gotoLocation: (node) => ({
    path: node.file as string,
    line: node.startLine as number | undefined,
    column: 0,
  }),
};

/**
 * Field extractors for File nodes
 */
const fileFieldExtractors: FieldExtractors = {
  name: (node) => {
    // Use full path for better search
    return (node.path as string) || (node.name as string) || '';
  },

  content: (node) => {
    // File source code
    return (node.source as string) || null;
  },

  description: () => null, // Would duplicate name

  displayPath: (node) => (node.path as string) || '',

  gotoLocation: (node) => ({
    path: node.path as string,
    line: 1,
  }),
};

/**
 * Field extractors for VueSFC nodes
 */
const vueSFCFieldExtractors: FieldExtractors = {
  name: (node) => {
    const componentName = node.componentName as string;
    const file = node.file as string;
    return componentName || path.basename(file, '.vue');
  },

  content: (node) => {
    // Template content
    return (node.templateSource as string) || (node.source as string) || null;
  },

  description: (node) => {
    const imports = node.imports as string;
    const usedComponents = node.usedComponents as string;
    const parts: string[] = [];
    if (usedComponents) parts.push(`Uses: ${usedComponents}`);
    if (imports) parts.push(`Imports: ${imports}`);
    return parts.join('. ') || null;
  },

  displayPath: (node) => (node.file as string) || '',

  gotoLocation: (node) => ({
    path: node.file as string,
    line: node.templateStartLine as number | undefined,
  }),
};

/**
 * Field extractors for SvelteComponent nodes
 */
const svelteFieldExtractors: FieldExtractors = {
  name: (node) => {
    const componentName = node.componentName as string;
    const file = node.file as string;
    return componentName || path.basename(file, '.svelte');
  },

  content: (node) => {
    return (node.templateSource as string) || (node.source as string) || null;
  },

  description: (node) => {
    const imports = node.imports as string;
    return imports ? `Imports: ${imports}` : null;
  },

  displayPath: (node) => (node.file as string) || '',

  gotoLocation: (node) => ({
    path: node.file as string,
    line: node.templateStartLine as number | undefined,
  }),
};

/**
 * Field extractors for Stylesheet nodes (CSS/SCSS)
 */
const stylesheetFieldExtractors: FieldExtractors = {
  name: (node) => {
    const file = node.file as string;
    return path.basename(file);
  },

  content: (node) => {
    // CSS content
    return (node.source as string) || null;
  },

  description: (node) => {
    const ruleCount = node.ruleCount as number | undefined;
    const variableCount = node.variableCount as number | undefined;
    const parts: string[] = [];
    if (ruleCount) parts.push(`${ruleCount} rules`);
    if (variableCount) parts.push(`${variableCount} variables`);
    return parts.join(', ') || null;
  },

  displayPath: (node) => (node.file as string) || '',

  gotoLocation: (node) => ({
    path: node.file as string,
    line: 1,
  }),
};

/**
 * Field extractors for GenericFile nodes (unknown code files)
 */
const genericFileFieldExtractors: FieldExtractors = {
  name: (node) => {
    const file = node.file as string;
    return path.basename(file);
  },

  content: (node) => {
    return (node.source as string) || null;
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

const scopeNodeType: NodeTypeDefinition = {
  label: 'Scope',
  description: 'Code scopes: functions, classes, methods, interfaces, variables, etc.',
  supportsLineNavigation: true,
  uuidStrategy: { type: 'signature', fields: ['file', 'signature', 'startLine'] },
  fields: scopeFieldExtractors,
  contentHashField: 'source',
  chunking: codeChunkingConfig,
  additionalRequiredProps: ['name', 'type', 'file', 'language', 'startLine', 'endLine', 'linesOfCode', 'source', 'signature'],
  indexedProps: ['name', 'type', 'file', 'language'],
};

const fileNodeType: NodeTypeDefinition = {
  label: 'File',
  description: 'Source code file wrapper',
  supportsLineNavigation: true,
  uuidStrategy: { type: 'path' },
  fields: fileFieldExtractors,
  contentHashField: 'source',
  chunking: undefined, // Files contain Scopes, don't chunk the whole file
  additionalRequiredProps: ['path', 'name', 'extension'],
  indexedProps: ['path', 'name', 'extension'],
};

const vueSFCNodeType: NodeTypeDefinition = {
  label: 'VueSFC',
  description: 'Vue Single File Component',
  supportsLineNavigation: true,
  uuidStrategy: { type: 'path' },
  fields: vueSFCFieldExtractors,
  contentHashField: 'source',
  chunking: codeChunkingConfig,
  additionalRequiredProps: ['file', 'type', 'templateStartLine', 'templateEndLine'],
  indexedProps: ['file', 'componentName'],
};

const svelteComponentNodeType: NodeTypeDefinition = {
  label: 'SvelteComponent',
  description: 'Svelte component',
  supportsLineNavigation: true,
  uuidStrategy: { type: 'path' },
  fields: svelteFieldExtractors,
  contentHashField: 'source',
  chunking: codeChunkingConfig,
  additionalRequiredProps: ['file', 'type', 'templateStartLine', 'templateEndLine'],
  indexedProps: ['file', 'componentName'],
};

const stylesheetNodeType: NodeTypeDefinition = {
  label: 'Stylesheet',
  description: 'CSS/SCSS stylesheet',
  supportsLineNavigation: true,
  uuidStrategy: { type: 'path' },
  fields: stylesheetFieldExtractors,
  contentHashField: 'source',
  chunking: codeChunkingConfig,
  additionalRequiredProps: ['file', 'type', 'ruleCount'],
  indexedProps: ['file', 'type'],
};

const genericFileNodeType: NodeTypeDefinition = {
  label: 'GenericFile',
  description: 'Unknown code file type',
  supportsLineNavigation: true,
  uuidStrategy: { type: 'path' },
  fields: genericFileFieldExtractors,
  contentHashField: 'source',
  chunking: codeChunkingConfig,
  additionalRequiredProps: ['file'],
  indexedProps: ['file'],
};

// ============================================================
// CODE PARSER
// ============================================================

/**
 * CodeParser - ContentParser that defines node types for code files
 *
 * NOTE: The actual parsing is done by @luciformresearch/codeparsers.
 * This parser provides:
 * 1. Node type definitions with field extractors
 * 2. Auto-generation of FIELD_MAPPING and embed configs
 *
 * Parsing is delegated to CodeSourceAdapter which uses the external library.
 */
export class CodeParser implements ContentParser {
  readonly name = 'code';
  readonly version = 1;

  readonly supportedExtensions = [
    // TypeScript/JavaScript
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    // Python
    '.py',
    // Web components
    '.vue', '.svelte',
    // Styles
    '.css', '.scss', '.sass',
    // HTML
    '.html', '.htm', '.astro',
    // Other
    '.go', '.rs', '.java', '.kt', '.rb', '.php', '.c', '.cpp', '.h', '.hpp',
  ];

  readonly supportedMimeTypes = [
    'text/typescript',
    'application/typescript',
    'text/javascript',
    'application/javascript',
    'text/x-python',
    'text/css',
    'text/html',
  ];

  readonly nodeTypes: NodeTypeDefinition[] = [
    scopeNodeType,
    fileNodeType,
    vueSFCNodeType,
    svelteComponentNodeType,
    stylesheetNodeType,
    genericFileNodeType,
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
      'CodeParser.parse() should not be called directly. ' +
      'Use CodeSourceAdapter for actual parsing.'
    );
  }
}

// ============================================================
// SINGLETON & REGISTRATION
// ============================================================

/**
 * Global CodeParser instance
 */
export const codeParser = new CodeParser();
