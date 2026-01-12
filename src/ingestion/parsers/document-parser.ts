/**
 * Document Parser - Unified parser for binary documents (PDF, DOCX, etc.)
 *
 * Converts all documents to markdown-style structure:
 * - File node with original path (paper.pdf)
 * - MarkdownDocument node (parsed content metadata)
 * - MarkdownSection nodes (sections/headings)
 *
 * Supports:
 * - PDF: text extraction with optional Vision for images
 * - DOCX: text extraction via mammoth
 * - Spreadsheets: converted to markdown tables (TODO)
 *
 * @module parsers/document-parser
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type {
  ContentParser,
  NodeTypeDefinition,
  ParseInput,
  ParseOutput,
  ParserNode,
  ParserRelationship,
  FieldExtractors,
  ChunkingConfig,
  DocumentParseOptions,
} from '../parser-types.js';
import {
  parseDocumentFile,
  parsePdfWithVision,
  isDocumentFile,
  getDocumentFormat,
  type DocumentFileInfo,
  type ParsedSection,
} from '../../runtime/adapters/document-file-parser.js';
import { hashContent } from '../content-extractor.js';

// ============================================================
// CHUNKING CONFIG
// ============================================================

const sectionChunkingConfig: ChunkingConfig = {
  enabled: true,
  maxSize: 4000,
  overlap: 400,
  strategy: 'paragraph',
};

// ============================================================
// FIELD EXTRACTORS
// ============================================================

/**
 * Field extractors for File nodes (document files)
 */
const fileFieldExtractors: FieldExtractors = {
  name: (node) => node.name as string,
  content: () => null, // File node doesn't have content, sections do
  description: (node) => {
    const ext = node.extension as string;
    const size = node.sizeBytes as number | undefined;
    if (size) {
      const sizeKb = Math.round(size / 1024);
      return `${ext.toUpperCase().slice(1)} file (${sizeKb} KB)`;
    }
    return `${ext.toUpperCase().slice(1)} file`;
  },
  displayPath: (node) => node.path as string,
  gotoLocation: (node) => ({ path: node.path as string }),
};

/**
 * Field extractors for MarkdownDocument nodes (parsed from documents)
 */
const markdownDocumentFieldExtractors: FieldExtractors = {
  name: (node) => {
    const title = node.title as string | undefined;
    const file = node.file as string;
    return title || path.basename(file);
  },
  content: () => null, // Document wrapper, sections have content
  description: (node) => {
    const sourceFormat = node.sourceFormat as string | undefined;
    const pageCount = node.pageCount as number | undefined;
    const sectionCount = node.sectionCount as number | undefined;
    const parts: string[] = [];
    if (sourceFormat) parts.push(`Source: ${sourceFormat.toUpperCase()}`);
    if (pageCount) parts.push(`${pageCount} pages`);
    if (sectionCount) parts.push(`${sectionCount} sections`);
    return parts.join(', ') || null;
  },
  displayPath: (node) => {
    const file = node.file as string;
    const pageCount = node.pageCount as number | undefined;
    return pageCount ? `${file} (${pageCount} pages)` : file;
  },
  gotoLocation: (node) => ({ path: node.file as string }),
};

/**
 * Field extractors for MarkdownSection nodes (sections from documents)
 */
const markdownSectionFieldExtractors: FieldExtractors = {
  name: (node) => {
    const title = node.title as string | undefined;
    return title || 'Untitled Section';
  },
  content: (node) => node.content as string | null ?? null,
  description: (node) => {
    const pageNum = node.pageNum as number | undefined;
    const type = node.type as string | undefined;
    const parts: string[] = [];
    if (type && type !== 'content') parts.push(`Type: ${type}`);
    if (pageNum) parts.push(`Page ${pageNum}`);
    return parts.join(', ') || null;
  },
  displayPath: (node) => {
    const file = node.file as string;
    const title = node.title as string | undefined;
    return title ? `${file} > ${title}` : file;
  },
  gotoLocation: (node) => ({
    path: node.file as string,
    page: node.pageNum as number | undefined,
  }),
};

// ============================================================
// NODE TYPE DEFINITIONS
// ============================================================

const fileNodeType: NodeTypeDefinition = {
  label: 'File',
  description: 'Document file (PDF, DOCX, etc.)',
  supportsLineNavigation: false,
  uuidStrategy: { type: 'path' },
  fields: fileFieldExtractors,
  contentHashField: 'contentHash',
  chunking: undefined, // File doesn't have content to chunk
  additionalRequiredProps: ['path', 'name', 'extension'],
  indexedProps: ['path', 'name', 'extension', 'sourceFormat'],
};

const markdownDocumentNodeType: NodeTypeDefinition = {
  label: 'MarkdownDocument',
  description: 'Parsed document content',
  supportsLineNavigation: false,
  uuidStrategy: { type: 'path' },
  fields: markdownDocumentFieldExtractors,
  contentHashField: 'contentHash',
  chunking: undefined, // Document wrapper, sections are chunked
  additionalRequiredProps: ['file', 'title', 'sourceFormat'],
  indexedProps: ['file', 'title', 'sourceFormat', 'parsedWith'],
};

const markdownSectionNodeType: NodeTypeDefinition = {
  label: 'MarkdownSection',
  description: 'Section within a parsed document',
  supportsLineNavigation: false,
  uuidStrategy: { type: 'signature', fields: ['file', 'index'] },
  fields: markdownSectionFieldExtractors,
  contentHashField: 'content',
  chunking: sectionChunkingConfig,
  additionalRequiredProps: ['file', 'title', 'content', 'index'],
  indexedProps: ['file', 'title', 'titleLevel', 'type', 'pageNum'],
};

// ============================================================
// DOCUMENT PARSER
// ============================================================

/**
 * DocumentParser - Parses binary documents into markdown-style nodes
 *
 * Creates:
 * - File node with original path (e.g., paper.pdf)
 * - MarkdownDocument node (document metadata)
 * - MarkdownSection nodes (sections with content)
 *
 * Relationships:
 * - MarkdownDocument -[:DERIVED_FROM]-> File
 * - MarkdownSection -[:IN_DOCUMENT]-> MarkdownDocument
 */
export class DocumentParser implements ContentParser {
  readonly name = 'document';
  readonly version = 2; // Bumped version for new output format

  readonly supportedExtensions = ['.pdf', '.docx', '.xlsx', '.xls', '.csv'];

  readonly supportedMimeTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
  ];

  readonly nodeTypes: NodeTypeDefinition[] = [
    fileNodeType,
    markdownDocumentNodeType,
    markdownSectionNodeType,
  ];

  /**
   * Check if this parser can handle a file
   */
  canHandle(filePath: string): boolean {
    return isDocumentFile(filePath);
  }

  /**
   * Parse a document file into File + MarkdownDocument + MarkdownSection nodes
   */
  async parse(input: ParseInput): Promise<ParseOutput> {
    const startTime = Date.now();
    const nodes: ParserNode[] = [];
    const relationships: ParserRelationship[] = [];
    const warnings: string[] = [];

    // Get parse options
    const options = (input.options || {}) as DocumentParseOptions;
    const {
      enableVision = false,
      visionAnalyzer,
      sectionTitles = 'detect',
      maxPages,
      minParagraphLength = 50,
      generateTitles = false,
      titleGenerator,
    } = options;

    try {
      const format = getDocumentFormat(input.filePath);
      if (!format) {
        warnings.push(`Unknown document format: ${input.filePath}`);
        return this.emptyResult(startTime, warnings);
      }

      // Handle binary content if provided
      let filePath = input.filePath;
      let tempFile: string | null = null;

      if (input.binaryContent) {
        // Write binary content to temp file for parsing
        tempFile = path.join(os.tmpdir(), `ragforge-${Date.now()}-${path.basename(input.filePath)}`);
        fs.writeFileSync(tempFile, input.binaryContent);
        filePath = tempFile;
      }

      try {
        // Parse based on format
        if (format === 'pdf') {
          await this.parsePdf(
            filePath,
            input.filePath, // original path for nodes
            input.projectId,
            { enableVision, visionAnalyzer, sectionTitles, maxPages, minParagraphLength, generateTitles, titleGenerator },
            nodes,
            relationships,
            warnings
          );
        } else if (format === 'docx') {
          await this.parseDocx(
            filePath,
            input.filePath,
            input.projectId,
            { sectionTitles, minParagraphLength, generateTitles, titleGenerator },
            nodes,
            relationships,
            warnings
          );
        } else {
          // Spreadsheets - fallback to simple text extraction
          await this.parseSpreadsheet(
            filePath,
            input.filePath,
            input.projectId,
            { generateTitles, titleGenerator },
            nodes,
            relationships,
            warnings
          );
        }
      } finally {
        // Clean up temp file
        if (tempFile && fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      }

    } catch (error) {
      warnings.push(`Error parsing ${input.filePath}: ${error}`);
    }

    return {
      nodes,
      relationships,
      warnings: warnings.length > 0 ? warnings : undefined,
      metadata: {
        parseTimeMs: Date.now() - startTime,
        fileSize: nodes.length > 0 ? (nodes[0].properties.sizeBytes as number) || 0 : 0,
      },
    };
  }

  /**
   * Parse PDF file
   */
  private async parsePdf(
    filePath: string,
    originalPath: string,
    projectId: string,
    options: DocumentParseOptions,
    nodes: ParserNode[],
    relationships: ParserRelationship[],
    warnings: string[]
  ): Promise<void> {
    const { enableVision, visionAnalyzer, sectionTitles, maxPages, minParagraphLength, generateTitles, titleGenerator } = options;

    let sections: ParsedSection[] = [];
    let pageCount = 0;
    let imagesAnalyzed = 0;
    let parsedWith: 'text' | 'vision' = 'text';

    if (enableVision && visionAnalyzer) {
      // Use Vision-enhanced parsing
      const result = await parsePdfWithVision(filePath, {
        visionAnalyzer,
        maxPages,
        sectionTitles: sectionTitles as 'none' | 'auto' | 'detect',
        minParagraphLength,
        outputFormat: 'text', // We handle markdown ourselves
      });

      sections = result.sections || [];
      pageCount = result.pagesProcessed;
      imagesAnalyzed = result.imagesAnalyzed;
      parsedWith = 'vision';
    } else {
      // Basic text extraction with section detection
      const docInfo = await parseDocumentFile(filePath, {
        extractText: true,
        useOcr: true,
      });

      if (docInfo) {
        pageCount = docInfo.pageCount || 0;

        // If we have text content, create a single section
        // TODO: Parse text content into sections using the same heuristics
        if (docInfo.textContent) {
          sections = [{
            index: 1,
            title: '',
            text: docInfo.textContent,
            pageNum: 1,
          }];
        }

        if (docInfo.needsGeminiVision) {
          warnings.push(`Document may need Vision for better text extraction`);
        }
      }
    }

    // Create nodes
    const fileStats = fs.statSync(filePath);
    await this.createDocumentNodes(
      originalPath,
      projectId,
      'pdf',
      parsedWith,
      sections,
      pageCount,
      imagesAnalyzed,
      fileStats.size,
      nodes,
      relationships,
      { generateTitles, titleGenerator }
    );
  }

  /**
   * Parse DOCX file
   */
  private async parseDocx(
    filePath: string,
    originalPath: string,
    projectId: string,
    options: Pick<DocumentParseOptions, 'sectionTitles' | 'minParagraphLength' | 'generateTitles' | 'titleGenerator'>,
    nodes: ParserNode[],
    relationships: ParserRelationship[],
    warnings: string[]
  ): Promise<void> {
    const { generateTitles, titleGenerator } = options;
    const docInfo = await parseDocumentFile(filePath, {
      extractText: true,
    });

    if (!docInfo) {
      warnings.push(`Could not parse DOCX: ${originalPath}`);
      return;
    }

    // TODO: Parse DOCX with sections (using mammoth HTML or similar)
    const sections: ParsedSection[] = [];
    if (docInfo.textContent) {
      sections.push({
        index: 1,
        title: '',
        text: docInfo.textContent,
        pageNum: 1,
      });
    }

    const fileStats = fs.statSync(filePath);
    await this.createDocumentNodes(
      originalPath,
      projectId,
      'docx',
      'text',
      sections,
      docInfo.pageCount || 1,
      0,
      fileStats.size,
      nodes,
      relationships,
      { generateTitles, titleGenerator }
    );
  }

  /**
   * Parse spreadsheet file
   */
  private async parseSpreadsheet(
    filePath: string,
    originalPath: string,
    projectId: string,
    options: Pick<DocumentParseOptions, 'generateTitles' | 'titleGenerator'>,
    nodes: ParserNode[],
    relationships: ParserRelationship[],
    warnings: string[]
  ): Promise<void> {
    const { generateTitles, titleGenerator } = options;
    const docInfo = await parseDocumentFile(filePath, {
      extractText: true,
    });

    if (!docInfo) {
      warnings.push(`Could not parse spreadsheet: ${originalPath}`);
      return;
    }

    const format = getDocumentFormat(originalPath) || 'xlsx';
    const sections: ParsedSection[] = [];

    // TODO: Convert sheets to markdown tables
    if (docInfo.textContent) {
      sections.push({
        index: 1,
        title: 'Data',
        text: docInfo.textContent,
        pageNum: 1,
      });
    }

    const fileStats = fs.statSync(filePath);
    await this.createDocumentNodes(
      originalPath,
      projectId,
      format,
      'text',
      sections,
      1,
      0,
      fileStats.size,
      nodes,
      relationships,
      { generateTitles, titleGenerator }
    );
  }

  /**
   * Create File + MarkdownDocument + MarkdownSection nodes
   */
  private async createDocumentNodes(
    filePath: string,
    projectId: string,
    sourceFormat: string,
    parsedWith: 'text' | 'vision',
    sections: ParsedSection[],
    pageCount: number,
    imagesAnalyzed: number,
    sizeBytes: number,
    nodes: ParserNode[],
    relationships: ParserRelationship[],
    options?: Pick<DocumentParseOptions, 'generateTitles' | 'titleGenerator'>
  ): Promise<void> {
    const fileName = path.basename(filePath);
    const extension = path.extname(filePath).toLowerCase();

    // Generate titles for sections without one if enabled
    if (options?.generateTitles && options?.titleGenerator) {
      const sectionsWithoutTitles = sections
        .filter(s => !s.title || s.title.trim() === '')
        .map(s => ({ index: s.index, content: s.text.substring(0, 2000) })); // Limit content for LLM

      if (sectionsWithoutTitles.length > 0) {
        try {
          const generatedTitles = await options.titleGenerator(sectionsWithoutTitles);

          // Map generated titles back to sections
          const titleMap = new Map(generatedTitles.map(t => [t.index, t.title]));
          for (const section of sections) {
            if (!section.title || section.title.trim() === '') {
              const generatedTitle = titleMap.get(section.index);
              if (generatedTitle) {
                section.title = generatedTitle;
              }
            }
          }
        } catch (error) {
          console.warn(`[DocumentParser] Failed to generate titles: ${error}`);
          // Continue with fallback titles
        }
      }
    }

    // 1. Create File node
    const fileId = `file:${hashContent(filePath + projectId)}`;
    nodes.push({
      labels: ['File'],
      id: fileId,
      properties: {
        uuid: fileId,
        projectId,
        sourcePath: filePath,
        sourceType: 'file',
        contentHash: hashContent(filePath + Date.now()), // Will be updated with actual content hash
        path: filePath,
        name: fileName.replace(extension, ''),
        extension,
        sourceFormat,
        sizeBytes,
      },
      position: { type: 'whole' },
    });

    // 2. Create MarkdownDocument node
    const docId = `doc:${hashContent(filePath + projectId)}`;
    const docTitle = sections.find(s => s.titleLevel === 1)?.title || fileName;

    nodes.push({
      labels: ['MarkdownDocument'],
      id: docId,
      properties: {
        uuid: docId,
        projectId,
        sourcePath: filePath,
        sourceType: 'document',
        contentHash: hashContent(filePath + sections.length),
        file: filePath,
        title: docTitle,
        sourceFormat,
        parsedWith,
        pageCount,
        sectionCount: sections.length,
        imagesAnalyzed,
        type: 'document',
      },
      position: { type: 'whole' },
    });

    // Relationship: MarkdownDocument -[:DERIVED_FROM]-> File
    relationships.push({
      type: 'DERIVED_FROM',
      from: docId,
      to: fileId,
    });

    // 3. Create MarkdownSection nodes
    for (const section of sections) {
      const sectionId = `section:${hashContent(filePath + section.index + projectId)}`;

      // Generate fallback title if none provided (and no LLM generation was used)
      const sectionTitle = section.title || `Section ${section.index}`;

      nodes.push({
        labels: ['MarkdownSection'],
        id: sectionId,
        properties: {
          uuid: sectionId,
          projectId,
          sourcePath: filePath,
          sourceType: 'section',
          contentHash: hashContent(section.text),
          file: filePath,
          title: sectionTitle,
          titleLevel: section.titleLevel,
          content: section.text,
          index: section.index,
          pageNum: section.pageNum,
          type: section.type || 'content',
          slug: this.slugify(sectionTitle),
        },
        position: { type: 'whole' },
        parentId: docId,
      });

      // Relationship: MarkdownSection -[:IN_DOCUMENT]-> MarkdownDocument
      relationships.push({
        type: 'IN_DOCUMENT',
        from: sectionId,
        to: docId,
      });
    }
  }

  /**
   * Create empty result
   */
  private emptyResult(startTime: number, warnings: string[]): ParseOutput {
    return {
      nodes: [],
      relationships: [],
      warnings: warnings.length > 0 ? warnings : undefined,
      metadata: {
        parseTimeMs: Date.now() - startTime,
        fileSize: 0,
      },
    };
  }

  /**
   * Generate slug from title
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  }
}

// ============================================================
// SINGLETON & REGISTRATION
// ============================================================

/**
 * Global DocumentParser instance
 */
export const documentParser = new DocumentParser();
