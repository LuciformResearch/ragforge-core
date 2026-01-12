/**
 * Data Parser - ContentParser wrapper for data/config files
 *
 * Wraps the existing DataFileParser to implement the ContentParser interface.
 * Defines node types and field extractors for:
 * - DataFile: Data/config files (.json, .yaml, .yml, .xml, .toml, .env)
 * - DataSection: Sections within data files (recursive objects/arrays)
 *
 * @module parsers/data-parser
 */

import * as path from 'path';
import * as fs from 'fs';
import type {
  ContentParser,
  NodeTypeDefinition,
  ParseInput,
  ParseOutput,
  ParserNode,
  ParserRelationship,
  FieldExtractors,
  ChunkingConfig,
} from '../parser-types.js';
import {
  parseDataFile,
  isDataFile,
  type DataFileInfo,
  type DataSection,
  type DataReference,
} from '../../runtime/adapters/data-file-parser.js';
import { hashContent } from '../content-extractor.js';

// ============================================================
// CHUNKING CONFIG
// ============================================================

/**
 * Data files are typically not chunked (already structured)
 * But large files may benefit from chunking
 */
const dataFileChunkingConfig: ChunkingConfig = {
  enabled: true,
  maxSize: 4000,
  overlap: 200,
  strategy: 'fixed', // Fixed for structured data
};

// ============================================================
// FIELD EXTRACTORS
// ============================================================

/**
 * Field extractors for DataFile nodes
 */
const dataFileFieldExtractors: FieldExtractors = {
  name: (node) => {
    const file = node.file as string;
    return path.basename(file);
  },

  content: (node) => {
    return node.rawContent as string | null ?? null;
  },

  description: (node) => {
    const format = node.format as string;
    const sections = node.sections as DataSection[] | undefined;
    const sectionCount = sections?.length ?? 0;
    const references = node.references as DataReference[] | undefined;
    const refCount = references?.length ?? 0;

    const parts: string[] = [`${format.toUpperCase()} configuration file`];
    if (sectionCount > 0) parts.push(`${sectionCount} top-level sections`);
    if (refCount > 0) parts.push(`${refCount} references`);

    return parts.join('. ');
  },

  displayPath: (node) => {
    const file = node.file as string;
    const loc = node.linesOfCode as number | undefined;
    if (loc) {
      return `${file} (${loc} lines)`;
    }
    return file;
  },

  gotoLocation: (node) => ({
    path: node.file as string,
    line: 1,
  }),
};

/**
 * Field extractors for DataSection nodes
 */
const dataSectionFieldExtractors: FieldExtractors = {
  name: (node) => {
    // Use the full path as name for searchability
    return node.path as string;
  },

  content: (node) => {
    return node.content as string | null ?? null;
  },

  description: (node) => {
    const valueType = node.valueType as string;
    const depth = node.depth as number;
    const key = node.key as string;
    return `${key} (${valueType}, depth: ${depth})`;
  },

  displayPath: (node) => {
    const file = node.file as string;
    const sectionPath = node.path as string;
    const startLine = node.startLine as number | undefined;
    if (startLine) {
      return `${file}:${startLine} → ${sectionPath}`;
    }
    return `${file} → ${sectionPath}`;
  },

  gotoLocation: (node) => ({
    path: node.file as string,
    line: node.startLine as number | undefined,
  }),
};

// ============================================================
// NODE TYPE DEFINITIONS
// ============================================================

const dataFileNodeType: NodeTypeDefinition = {
  label: 'DataFile',
  description: 'Data/configuration files (JSON, YAML, XML, TOML, ENV)',
  supportsLineNavigation: true,
  uuidStrategy: { type: 'path' },
  fields: dataFileFieldExtractors,
  contentHashField: 'hash',
  chunking: dataFileChunkingConfig,
  additionalRequiredProps: ['file', 'format'],
  indexedProps: ['file', 'format'],
};

const dataSectionNodeType: NodeTypeDefinition = {
  label: 'DataSection',
  description: 'Sections within data files',
  supportsLineNavigation: true,
  uuidStrategy: { type: 'signature', fields: ['file', 'path'] },
  fields: dataSectionFieldExtractors,
  contentHashField: 'content',
  chunking: undefined, // Sections are already small
  additionalRequiredProps: ['file', 'path', 'key', 'valueType'],
  indexedProps: ['path', 'key', 'valueType', 'depth'],
};

// ============================================================
// DATA PARSER
// ============================================================

/**
 * DataParser - ContentParser implementation for data/config files
 */
export class DataParser implements ContentParser {
  readonly name = 'data';
  readonly version = 1;

  readonly supportedExtensions = [
    '.json', '.yaml', '.yml', '.xml', '.toml',
    '.env', '.env.local', '.env.development', '.env.production',
  ];

  readonly supportedMimeTypes = [
    'application/json',
    'text/yaml',
    'application/yaml',
    'application/xml',
    'text/xml',
    'application/toml',
  ];

  readonly nodeTypes: NodeTypeDefinition[] = [
    dataFileNodeType,
    dataSectionNodeType,
  ];

  /**
   * Check if this parser can handle a file
   */
  canHandle(filePath: string): boolean {
    return isDataFile(filePath);
  }

  /**
   * Parse a data file into nodes and relationships
   */
  async parse(input: ParseInput): Promise<ParseOutput> {
    const startTime = Date.now();
    const nodes: ParserNode[] = [];
    const relationships: ParserRelationship[] = [];
    const warnings: string[] = [];

    try {
      // Read file content if not provided
      const content = input.content ?? await fs.promises.readFile(input.filePath, 'utf-8');

      const dataInfo = parseDataFile(input.filePath, content);

      // Create main DataFile node
      const dataFileNode = this.createDataFileNode(dataInfo, input.projectId);
      nodes.push(dataFileNode);

      // Create File wrapper node
      const fileNode = this.createFileNode(input.filePath, input.projectId);
      nodes.push(fileNode);

      // Relationship: DataFile -[:IN_FILE]-> File
      relationships.push({
        type: 'IN_FILE',
        from: dataFileNode.id,
        to: fileNode.id,
      });

      // Create DataSection nodes (recursive)
      this.createSectionNodes(
        dataInfo.sections,
        dataInfo.file,
        input.projectId,
        dataFileNode.id,
        nodes,
        relationships
      );

      // Create relationship for references
      for (const ref of dataInfo.references) {
        if (ref.type === 'package') {
          // Create ExternalLibrary node for package references
          const libNode = this.createExternalLibraryNode(ref.value, input.projectId);
          // Check if already exists
          if (!nodes.find(n => n.id === libNode.id)) {
            nodes.push(libNode);
          }
          relationships.push({
            type: 'DEPENDS_ON',
            from: dataFileNode.id,
            to: libNode.id,
            properties: { context: ref.path, line: ref.line },
          });
        }
        // Other reference types (file, url, directory) could create relationships too
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
        fileSize: nodes.length > 0 ? (nodes[0].properties.linesOfCode as number) * 50 : 0, // Estimate
      },
    };
  }

  /**
   * Create a DataFile node
   */
  private createDataFileNode(info: DataFileInfo, projectId: string): ParserNode {
    const id = this.generateId(info.file, projectId);

    return {
      labels: ['DataFile'],
      id,
      properties: {
        uuid: id,
        projectId,
        sourcePath: info.file,
        sourceType: 'file',
        contentHash: info.hash,
        file: info.file,
        format: info.format,
        linesOfCode: info.linesOfCode,
        rawContent: info.rawContent,
        sectionCount: info.sections.length,
        referenceCount: info.references.length,
      },
      position: { type: 'whole' },
    };
  }

  /**
   * Create DataSection nodes recursively
   */
  private createSectionNodes(
    sections: DataSection[],
    filePath: string,
    projectId: string,
    parentId: string,
    nodes: ParserNode[],
    relationships: ParserRelationship[]
  ): void {
    for (const section of sections) {
      const sectionId = this.generateSectionId(filePath, section.path, projectId);

      const node: ParserNode = {
        labels: ['DataSection'],
        id: sectionId,
        properties: {
          uuid: sectionId,
          projectId,
          sourcePath: filePath,
          sourceType: 'file',
          contentHash: hashContent(section.content),
          file: filePath,
          path: section.path,
          key: section.key,
          content: section.content,
          startLine: section.startLine,
          endLine: section.endLine,
          depth: section.depth,
          parentPath: section.parentPath,
          valueType: section.valueType,
        },
        position: {
          type: 'lines',
          startLine: section.startLine,
          endLine: section.endLine,
        },
        parentId,
      };

      nodes.push(node);

      // Relationship: DataSection -[:CONTAINS]-> parent
      relationships.push({
        type: 'CONTAINS',
        from: parentId,
        to: sectionId,
      });

      // Recurse for children
      if (section.children && section.children.length > 0) {
        this.createSectionNodes(
          section.children,
          filePath,
          projectId,
          sectionId,
          nodes,
          relationships
        );
      }
    }
  }

  /**
   * Create a File wrapper node
   */
  private createFileNode(filePath: string, projectId: string): ParserNode {
    const id = `file:${hashContent(filePath + projectId)}`;

    return {
      labels: ['File'],
      id,
      properties: {
        uuid: id,
        projectId,
        sourcePath: filePath,
        sourceType: 'file',
        contentHash: hashContent(filePath),
        absolutePath: filePath,
        name: path.basename(filePath),
        extension: path.extname(filePath).toLowerCase(),
      },
      position: { type: 'whole' },
    };
  }

  /**
   * Create an ExternalLibrary node for package references
   */
  private createExternalLibraryNode(packageName: string, projectId: string): ParserNode {
    const id = `lib:${hashContent(packageName)}`;

    return {
      labels: ['ExternalLibrary'],
      id,
      properties: {
        uuid: id,
        projectId,
        sourcePath: `npm:${packageName}`,
        sourceType: 'external',
        contentHash: hashContent(packageName),
        name: packageName,
        registry: 'npm',
      },
      position: { type: 'whole' },
    };
  }

  /**
   * Generate deterministic ID from file path
   */
  private generateId(filePath: string, projectId: string): string {
    return `data:${hashContent(filePath + projectId)}`;
  }

  /**
   * Generate deterministic ID for a section
   */
  private generateSectionId(filePath: string, sectionPath: string, projectId: string): string {
    return `section:${hashContent(filePath + sectionPath + projectId)}`;
  }
}

// ============================================================
// SINGLETON & REGISTRATION
// ============================================================

/**
 * Global DataParser instance
 */
export const dataParser = new DataParser();
