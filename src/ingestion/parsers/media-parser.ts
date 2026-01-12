/**
 * Media Parser - ContentParser wrapper for media files
 *
 * Wraps the existing MediaFileParser to implement the ContentParser interface.
 * Defines node types and field extractors for:
 * - ImageFile: Images (.png, .jpg, .gif, etc.)
 * - ThreeDFile: 3D models (.glb, .gltf)
 * - MediaFile: Generic media files
 *
 * @module parsers/media-parser
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
  MediaParseOptions,
} from '../parser-types.js';
import {
  parseMediaFile,
  isMediaFile,
  type AnyMediaFileInfo,
  type ImageFileInfo,
  type ThreeDFileInfo,
} from '../../runtime/adapters/media-file-parser.js';
import { hashContent } from '../content-extractor.js';

// ============================================================
// FIELD EXTRACTORS
// ============================================================

/**
 * Field extractors for ImageFile nodes
 */
const imageFieldExtractors: FieldExtractors = {
  name: (node) => {
    const file = node.file as string;
    return path.basename(file);
  },

  content: (node) => {
    // Images don't have textual content by default
    // Description is populated on-demand via analysis
    return node.description as string | null ?? null;
  },

  description: (node) => {
    // Return analysis description if available
    const analysis = node.analysis as { description?: string } | undefined;
    return analysis?.description ?? null;
  },

  displayPath: (node) => {
    const file = node.file as string;
    const dims = node.dimensions as { width: number; height: number } | undefined;
    if (dims) {
      return `${file} (${dims.width}×${dims.height})`;
    }
    return file;
  },

  gotoLocation: (node) => ({
    path: node.file as string,
  }),
};

/**
 * Field extractors for ThreeDFile nodes
 */
const threeDFieldExtractors: FieldExtractors = {
  name: (node) => {
    const file = node.file as string;
    return path.basename(file);
  },

  content: (node) => {
    // 3D files don't have textual content
    // Could return GLTF metadata as content
    const gltf = node.gltfInfo as {
      meshCount?: number;
      materialCount?: number;
      textureCount?: number;
      animationCount?: number;
    } | undefined;

    if (gltf) {
      return `Meshes: ${gltf.meshCount ?? 0}, Materials: ${gltf.materialCount ?? 0}, Textures: ${gltf.textureCount ?? 0}, Animations: ${gltf.animationCount ?? 0}`;
    }
    return null;
  },

  description: (node) => {
    // Return analysis description if available
    const analysis = node.analysis as { description?: string } | undefined;
    return analysis?.description ?? null;
  },

  displayPath: (node) => {
    const file = node.file as string;
    const gltf = node.gltfInfo as { generator?: string } | undefined;
    if (gltf?.generator) {
      return `${file} (${gltf.generator})`;
    }
    return file;
  },

  gotoLocation: (node) => ({
    path: node.file as string,
  }),
};

/**
 * Field extractors for generic MediaFile nodes
 */
const mediaFieldExtractors: FieldExtractors = {
  name: (node) => {
    const file = node.file as string;
    return path.basename(file);
  },

  content: () => null,

  description: (node) => {
    const analysis = node.analysis as { description?: string } | undefined;
    return analysis?.description ?? null;
  },

  displayPath: (node) => node.file as string,

  gotoLocation: (node) => ({
    path: node.file as string,
  }),
};

// ============================================================
// NODE TYPE DEFINITIONS
// ============================================================

const imageFileNodeType: NodeTypeDefinition = {
  label: 'ImageFile',
  description: 'Image files (PNG, JPG, GIF, WebP, etc.)',
  supportsLineNavigation: false,
  uuidStrategy: { type: 'path' },
  fields: imageFieldExtractors,
  contentHashField: 'hash',
  chunking: undefined, // Images are not chunked
  additionalRequiredProps: ['file', 'format', 'category'],
  indexedProps: ['file', 'format'],
};

const threeDFileNodeType: NodeTypeDefinition = {
  label: 'ThreeDFile',
  description: '3D model files (GLTF, GLB)',
  supportsLineNavigation: false,
  uuidStrategy: { type: 'path' },
  fields: threeDFieldExtractors,
  contentHashField: 'hash',
  chunking: undefined, // 3D files are not chunked
  additionalRequiredProps: ['file', 'format', 'category'],
  indexedProps: ['file', 'format'],
};

const mediaFileNodeType: NodeTypeDefinition = {
  label: 'MediaFile',
  description: 'Generic media files',
  supportsLineNavigation: false,
  uuidStrategy: { type: 'path' },
  fields: mediaFieldExtractors,
  contentHashField: 'hash',
  chunking: undefined,
  additionalRequiredProps: ['file', 'format', 'category'],
  indexedProps: ['file', 'format'],
};

// ============================================================
// MEDIA PARSER
// ============================================================

/**
 * MediaParser - ContentParser implementation for media files
 */
export class MediaParser implements ContentParser {
  readonly name = 'media';
  readonly version = 1;

  readonly supportedExtensions = [
    // Images
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff',
    // 3D
    '.gltf', '.glb',
  ];

  readonly supportedMimeTypes = [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
    'model/gltf+json', 'model/gltf-binary',
  ];

  readonly nodeTypes: NodeTypeDefinition[] = [
    imageFileNodeType,
    threeDFileNodeType,
    mediaFileNodeType,
  ];

  /**
   * Check if this parser can handle a file
   */
  canHandle(filePath: string): boolean {
    return isMediaFile(filePath);
  }

  /**
   * Parse a media file into nodes and relationships
   *
   * Supports Vision analysis for images and 3D models when enableVision=true.
   * - Images: analyzed directly with visionAnalyzer
   * - 3D models: rendered to images, then each view analyzed with visionAnalyzer
   */
  async parse(input: ParseInput): Promise<ParseOutput> {
    const startTime = Date.now();
    const nodes: ParserNode[] = [];
    const relationships: ParserRelationship[] = [];
    const warnings: string[] = [];

    // Get parse options
    const options = (input.options || {}) as MediaParseOptions;
    const { enableVision = false, visionAnalyzer, render3D } = options;

    try {
      const mediaInfo = await parseMediaFile(input.filePath, {
        extractDimensions: true,
        parseGltfMetadata: true,
      });

      if (!mediaInfo) {
        warnings.push(`Could not parse media file: ${input.filePath}`);
        return {
          nodes: [],
          relationships: [],
          warnings,
          metadata: {
            parseTimeMs: Date.now() - startTime,
            fileSize: 0,
          },
        };
      }

      // Vision analysis if enabled
      let description: string | undefined;

      console.log(`[MediaParser] Vision check: enableVision=${enableVision}, hasVisionAnalyzer=${!!visionAnalyzer}, hasRender3D=${!!render3D}, category=${mediaInfo.category}`);

      if (enableVision && visionAnalyzer) {
        try {
          if (mediaInfo.category === 'image') {
            // Analyze image directly
            console.log(`[MediaParser] Analyzing image: ${input.filePath}`);
            const imageBuffer = fs.readFileSync(input.filePath);
            description = await visionAnalyzer(
              imageBuffer,
              'Describe this image in detail. What does it show? Include colors, composition, text if any, and notable features.'
            );
            console.log(`[MediaParser] Image vision description generated (${description?.length} chars)`);
          } else if (mediaInfo.category === '3d' && render3D) {
            // Render 3D model and analyze the first/main view
            console.log(`[MediaParser] Rendering 3D model: ${input.filePath}`);
            const renders = await render3D(input.filePath);
            console.log(`[MediaParser] Render result: ${renders.length} views`);
            if (renders.length > 0) {
              const mainRender = renders[0]; // Use first (perspective) view
              console.log(`[MediaParser] Analyzing view: ${mainRender.view}, buffer size: ${mainRender.buffer.length}`);
              description = await visionAnalyzer(
                mainRender.buffer,
                `Describe this 3D model. What kind of object or character is it? What are its visual characteristics, style, and notable features?`
              );
              console.log(`[MediaParser] 3D vision description generated (${description?.length} chars)`);
            }
          }
        } catch (visionError) {
          console.error(`[MediaParser] Vision error:`, visionError);
          warnings.push(`Vision analysis failed: ${visionError}`);
        }
      }

      // Create node based on category
      const node = this.createNode(mediaInfo, input.projectId, description);
      nodes.push(node);

      // Create File wrapper node
      const fileNode = this.createFileNode(input.filePath, input.projectId, node.id);
      nodes.push(fileNode);

      // Relationship: MediaFile/ImageFile/ThreeDFile -[:IN_FILE]-> File
      relationships.push({
        type: 'IN_FILE',
        from: node.id,
        to: fileNode.id,
      });

    } catch (error) {
      warnings.push(`Error parsing ${input.filePath}: ${error}`);
    }

    return {
      nodes,
      relationships,
      warnings: warnings.length > 0 ? warnings : undefined,
      metadata: {
        parseTimeMs: Date.now() - startTime,
        fileSize: nodes.length > 0 ? (nodes[0].properties.sizeBytes as number) : 0,
      },
    };
  }

  /**
   * Create a node from media file info
   */
  private createNode(info: AnyMediaFileInfo, projectId: string, description?: string): ParserNode {
    const labels = this.getLabels(info);
    const id = this.generateId(info.file, projectId);

    return {
      labels,
      id,
      properties: {
        uuid: id,
        projectId,
        sourcePath: info.file,
        sourceType: 'file',
        contentHash: info.hash,
        file: info.file,
        format: info.format,
        category: info.category,
        sizeBytes: info.sizeBytes,
        modifiedAt: info.modifiedAt instanceof Date ? info.modifiedAt.toISOString() : info.modifiedAt,
        analyzed: description ? true : info.analyzed,
        // Vision description (if analyzed)
        ...(description && { description }),
        // Image-specific
        ...((info as ImageFileInfo).dimensions && {
          width: (info as ImageFileInfo).dimensions!.width,
          height: (info as ImageFileInfo).dimensions!.height,
        }),
        // 3D-specific
        ...((info as ThreeDFileInfo).gltfInfo && {
          gltfVersion: (info as ThreeDFileInfo).gltfInfo!.version,
          gltfGenerator: (info as ThreeDFileInfo).gltfInfo!.generator,
          meshCount: (info as ThreeDFileInfo).gltfInfo!.meshCount,
          materialCount: (info as ThreeDFileInfo).gltfInfo!.materialCount,
          textureCount: (info as ThreeDFileInfo).gltfInfo!.textureCount,
          animationCount: (info as ThreeDFileInfo).gltfInfo!.animationCount,
        }),
      },
      position: { type: 'whole' },
    };
  }

  /**
   * Create a File wrapper node
   */
  private createFileNode(filePath: string, projectId: string, mediaNodeId: string): ParserNode {
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
        path: filePath, // Required for IncrementalIngestionManager merge
        absolutePath: filePath,
        name: path.basename(filePath),
        extension: path.extname(filePath).toLowerCase(),
      },
      position: { type: 'whole' },
    };
  }

  /**
   * Get labels based on media category
   */
  private getLabels(info: AnyMediaFileInfo): string[] {
    switch (info.category) {
      case 'image':
        return ['ImageFile', 'MediaFile'];
      case '3d':
        return ['ThreeDFile', 'MediaFile'];
      case 'document':
        return ['DocumentFile', 'MediaFile'];
      default:
        return ['MediaFile'];
    }
  }

  /**
   * Generate deterministic ID from file path
   */
  private generateId(filePath: string, projectId: string): string {
    return `media:${hashContent(filePath + projectId)}`;
  }
}

// ============================================================
// SINGLETON & REGISTRATION
// ============================================================

/**
 * Global MediaParser instance
 */
export const mediaParser = new MediaParser();
